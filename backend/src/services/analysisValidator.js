/**
 * analysisValidator.js — validación determinista del output del LLM.
 *
 * Funciones puras, sin dependencias. Verifica que el `structured` devuelto por
 * analyzeMarket() respeta las REGLAS DURAS del SYSTEM_PROMPT. Complementa (no
 * reemplaza) la validación de estructura/JSON que ya hace anthropicService
 * (parse + AppError 502): aquí comprobamos coherencia de reglas de negocio.
 *
 * FASE 1 (log + flag): `validateAnalysis()` detecta y clasifica violaciones; el
 * caller (analysisController) las loguea y persiste en `analyses.validation_warnings`.
 * Objetivo: telemetría de con qué frecuencia y qué reglas viola el LLM.
 *
 * FASE 2 (fail-safe): `applyFailSafe()` degrada a action="Esperar" ante violación
 * severa (gated por `ANALYSIS_FAILSAFE_ENABLED`, default true). Ver más abajo.
 *
 * Severidad:
 *   - 'severe': contradicción dura (Comprar/Vender sin cumplir su puerta,
 *     gating ignorado, dirección de setup opuesta a la acción). Candidata a
 *     fail-safe en Fase 2.
 *   - 'minor': incoherencia de rango/coherencia sin invertir la decisión.
 */

const ACTIONS = ['Comprar', 'Vender', 'Preparar', 'Esperar'];
const CONFIDENCES = ['Alta', 'Media', 'Baja'];
const SCORE_KEYS = ['derivatives', 'structure', 'volume', 'onchain'];

const isInt    = (v) => Number.isInteger(v);
const isNum    = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange  = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;

/**
 * Valida el objeto `structured` de un análisis contra las reglas del prompt.
 * @param {object} structured
 * @returns {{ warnings: Array<{rule:string, severity:'severe'|'minor', message:string}>, hasSevere: boolean }}
 */
export function validateAnalysis(structured) {
  const warnings = [];
  const warn = (rule, severity, message) => warnings.push({ rule, severity, message });

  if (!structured || typeof structured !== 'object') {
    return {
      warnings: [{ rule: 'structured_present', severity: 'severe', message: 'structured ausente o no es un objeto' }],
      hasSevere: true,
    };
  }

  const {
    action, confidence, risk_score, conviction, scores,
    setup, has_executable_setup, gating_active,
  } = structured;

  // ── Enums ────────────────────────────────────────────────────────────────
  if (!ACTIONS.includes(action)) {
    warn('action_enum', 'severe', `action="${action}" no es uno de ${ACTIONS.join('|')}`);
  }
  if (!CONFIDENCES.includes(confidence)) {
    warn('confidence_enum', 'minor', `confidence="${confidence}" no es uno de ${CONFIDENCES.join('|')}`);
  }

  // ── Rangos numéricos ──────────────────────────────────────────────────────
  if (!inRange(conviction, 0, 1)) {
    warn('conviction_range', 'minor', `conviction=${conviction} fuera de [0,1]`);
  }
  if (!(isInt(risk_score) && inRange(risk_score, 1, 10))) {
    warn('risk_score_range', 'minor', `risk_score=${risk_score} no es entero en [1,10]`);
  }

  const s = scores ?? {};
  for (const k of SCORE_KEYS) {
    if (!(isInt(s[k]) && inRange(s[k], -2, 2))) {
      warn(`score_${k}_range`, 'minor', `scores.${k}=${s[k]} no es entero en [-2,+2]`);
    }
  }
  if (!isNum(s.total)) {
    warn('score_total_type', 'minor', `scores.total=${s.total} no es un número`);
  }

  // ── Gating: gating_active=true ⟹ action="Esperar" ─────────────────────────
  if (gating_active === true && action !== 'Esperar') {
    warn('gating_forces_wait', 'severe', `gating_active=true pero action="${action}" (debería ser Esperar)`);
  }

  // ── Puertas de Comprar / Vender ───────────────────────────────────────────
  if (action === 'Comprar' && !(s.derivatives >= 1 && s.volume >= 1)) {
    warn('buy_gate', 'severe',
      `Comprar exige derivatives>=+1 y volume>=+1 (derivatives=${s.derivatives}, volume=${s.volume})`);
  }
  if (action === 'Vender' && !(s.derivatives <= -1 && s.volume <= -1)) {
    warn('sell_gate', 'severe',
      `Vender exige derivatives<=-1 y volume<=-1 (derivatives=${s.derivatives}, volume=${s.volume})`);
  }

  // ── Coherencia de existencia de setup ─────────────────────────────────────
  const hasSetup = setup != null;
  if (has_executable_setup === false && hasSetup) {
    warn('setup_should_be_null', 'minor', 'has_executable_setup=false pero setup no es null');
  }
  if (has_executable_setup === true && !hasSetup) {
    warn('setup_missing', 'minor', 'has_executable_setup=true pero setup es null');
  }

  // ── Dirección del setup coherente con la acción ───────────────────────────
  if (hasSetup) {
    const { entry_price, stop_price, tp1_price } = setup;
    if (isNum(entry_price) && isNum(stop_price) && isNum(tp1_price)) {
      if (stop_price === entry_price) {
        warn('setup_stop_eq_entry', 'minor', `setup stop_price==entry_price (${entry_price})`);
      } else {
        const dir = stop_price < entry_price ? 'long' : 'short';
        // TP1 debe estar en el lado del beneficio según la dirección.
        const tpOk = dir === 'long' ? tp1_price > entry_price : tp1_price < entry_price;
        if (!tpOk) {
          warn('setup_tp_side', 'minor', `setup ${dir}: tp1=${tp1_price} en el lado equivocado de entry=${entry_price}`);
        }
        // La acción debe coincidir con la dirección geométrica del setup.
        if (action === 'Comprar' && dir !== 'long') {
          warn('setup_action_dir', 'severe', `action=Comprar pero setup es short (stop=${stop_price} > entry=${entry_price})`);
        }
        if (action === 'Vender' && dir !== 'short') {
          warn('setup_action_dir', 'severe', `action=Vender pero setup es long (stop=${stop_price} < entry=${entry_price})`);
        }
      }
    }
  }

  // ── Signo de scores.total (no es suma mecánica; solo contradicción flagrante) ─
  if (isNum(s.total)) {
    const comps = SCORE_KEYS.map(k => s[k]).filter(isInt);
    if (comps.length) {
      if (s.total > 0.5 && comps.every(v => v <= 0)) {
        warn('total_sign', 'minor', `scores.total=${s.total} positivo pero todos los componentes <=0`);
      }
      if (s.total < -0.5 && comps.every(v => v >= 0)) {
        warn('total_sign', 'minor', `scores.total=${s.total} negativo pero todos los componentes >=0`);
      }
    }
  }

  return { warnings, hasSevere: warnings.some(w => w.severity === 'severe') };
}

/**
 * FASE 2 (fail-safe) — degrada el output a "Esperar" ante violación SEVERA.
 *
 * Función pura: no muta `structured`, devuelve una copia parcheada. Coherente con el
 * DEFAULT STATE del prompt ("por defecto ESPERAR"): si el LLM recomendó Comprar/Vender
 * sin cumplir su puerta, o ignoró un gating activo, o dio un setup en dirección opuesta
 * a la acción, no ejecutamos ese trade — forzamos Esperar y neutralizamos el setup.
 * Las violaciones menores NO disparan fail-safe (quedan en log + persistencia).
 *
 * @param {object} structured - Output del LLM ya validado.
 * @param {{ warnings: Array, hasSevere: boolean }} validation - Resultado de validateAnalysis().
 * @returns {{ structured: object, applied: boolean }}
 */
export function applyFailSafe(structured, validation) {
  if (!validation?.hasSevere || !structured) {
    return { structured, applied: false };
  }

  const severeRules = validation.warnings
    .filter(w => w.severity === 'severe')
    .map(w => w.rule);

  const note = `[FAIL-SAFE] Acción degradada a Esperar por violación de reglas duras del prompt `
    + `(${severeRules.join(', ')}). Output original del LLM: action="${structured.action}".`;

  const patched = {
    ...structured,
    action: 'Esperar',
    // Un Esperar forzado no ejecuta: se neutraliza el setup para no dejar niveles activos.
    has_executable_setup: false,
    setup: null,
    fail_safe_applied: true,
    fail_safe_original_action: structured.action ?? null,
    fail_safe_rules: severeRules,
    executive_summary: `${note}${structured.executive_summary ? ' ' + structured.executive_summary : ''}`,
  };

  return { structured: patched, applied: true };
}
