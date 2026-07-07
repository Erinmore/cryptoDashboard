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
 * @param {{ backendContradictionCount?: number }} [opts]
 *   backendContradictionCount: contradicciones deterministas precalculadas por el backend
 *   (5 de 6 del CONVICTION DECAY, ver utils/gating.js). Se le suma aquí la 6ª (que depende
 *   de los scores del LLM) para cerrar el conteo y decidir si dispara `conviction_decay_forces_wait`.
 * @returns {{ warnings: Array<{rule:string, severity:'severe'|'minor', message:string}>, hasSevere: boolean }}
 */
export function validateAnalysis(structured, opts = {}) {
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

  // ── Conviction decay: >=3 contradicciones ⟹ action="Esperar" ──────────────
  // El backend precalcula 5 de las 6 contradicciones del CONVICTION DECAY; la 6ª
  // (conflicto Volume Flow ↔ Structure) depende de los scores del LLM, que aquí sí
  // tenemos → se cierra el conteo determinista. El prompt exige ESPERAR con total >=3;
  // esta regla lo hace cumplir (severa → candidata a fail-safe).
  // M4: simétrica — cuenta el conflicto en cualquier dirección (volume<0∧structure>0 O
  // volume>0∧structure<0), no solo el caso alcista. Antes penalizaba asimétricamente.
  const sixthContradiction = isInt(s.volume) && isInt(s.structure) &&
    ((s.volume < 0 && s.structure > 0) || (s.volume > 0 && s.structure < 0));
  const contradictionTotal =
    (isInt(opts.backendContradictionCount) ? opts.backendContradictionCount : 0) + (sixthContradiction ? 1 : 0);
  if (contradictionTotal >= 3 && action !== 'Esperar') {
    warn('conviction_decay_forces_wait', 'severe',
      `contradiction_count=${contradictionTotal} (>=3) exige Esperar pero action="${action}"`);
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

  // ── Guardia de divergencia de scores (C2) ─────────────────────────────────
  // La puerta de arriba compara el score del LLM contra sí misma (circular). Aquí lo
  // comparamos contra el score ESPERADO por el backend desde el dato. Solo se dispara
  // cuando el LLM abre la puerta en una dirección (score en el lado que autoriza el trade)
  // pero el dato lee CLARAMENTE lo contrario (esperado en el lado opuesto, |.|>=1). Es
  // deliberadamente conservador: no micro-gestiona, solo caza contradicciones flagrantes.
  const exp = opts.expectedScores;
  if (exp) {
    const checkDiv = (block) => {
      const llm = s[block];
      const e = exp[block]?.score;
      if (!isInt(llm) || !isNum(e)) return;
      if (action === 'Comprar' && llm >= 1 && e <= -1) {
        warn(`score_divergence_${block}`, 'severe',
          `Comprar con ${block}=${llm} pero el backend espera ${block}≈${e} desde el dato (${(exp[block].basis || []).join('; ')})`);
      }
      if (action === 'Vender' && llm <= -1 && e >= 1) {
        warn(`score_divergence_${block}`, 'severe',
          `Vender con ${block}=${llm} pero el backend espera ${block}≈${e} desde el dato (${(exp[block].basis || []).join('; ')})`);
      }
    };
    checkDiv('derivatives');
    checkDiv('volume');
  }

  // ── Coherencia de existencia de setup ─────────────────────────────────────
  const hasSetup = setup != null;
  if (has_executable_setup === false && hasSetup) {
    warn('setup_should_be_null', 'minor', 'has_executable_setup=false pero setup no es null');
  }
  if (has_executable_setup === true && !hasSetup) {
    warn('setup_missing', 'minor', 'has_executable_setup=true pero setup es null');
  }

  // ── Cotas de sanidad del setup (H6) — minor, alimentan fill-rate/telemetría ─
  // No degradan la acción, pero marcan setups mal calibrados (entradas lejanas, R:R pobre)
  // que en el backtest tienden a quedar 'not_triggered' y escapar de la evaluación.
  if (hasSetup) {
    const { entry_price, stop_price, tp1_price } = setup;
    const price = opts.currentPrice;
    if (isNum(entry_price) && isNum(price) && price > 0) {
      const entryDistPct = Math.abs(entry_price - price) / price * 100;
      if (entryDistPct > 8) {
        warn('setup_entry_far', 'minor', `entry=${entry_price} a ${entryDistPct.toFixed(1)}% del precio ${price} (poco probable de llenarse)`);
      }
    }
    if (isNum(entry_price) && isNum(stop_price) && isNum(tp1_price) && entry_price !== stop_price) {
      const risk = Math.abs(entry_price - stop_price);
      const reward = Math.abs(tp1_price - entry_price);
      if (risk > 0 && reward / risk < 1) {
        warn('setup_low_rr', 'minor', `R:R tp1/stop = ${(reward / risk).toFixed(2)} (<1: riesgo mayor que recompensa)`);
      }
    }
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

  // Coherencia de missing_confirmations: un Esperar forzado NO es un setup ejecutable, así que
  // un array vacío ("no falta nada para operar") contradiría la acción. Si el LLM lo dejó vacío,
  // lo poblamos con el motivo del bloqueo; si ya traía confirmaciones pendientes, se respetan.
  const existingMissing = Array.isArray(structured.missing_confirmations) ? structured.missing_confirmations : [];
  const missing_confirmations = existingMissing.length > 0
    ? existingMissing
    : [`Trade bloqueado por el backend (${severeRules.join(', ')}); no ejecutar hasta que se resuelva.`];

  const patched = {
    ...structured,
    action: 'Esperar',
    // Un Esperar forzado no ejecuta: se neutraliza el setup para no dejar niveles activos.
    has_executable_setup: false,
    setup: null,
    missing_confirmations,
    fail_safe_applied: true,
    fail_safe_original_action: structured.action ?? null,
    fail_safe_rules: severeRules,
    executive_summary: `${note}${structured.executive_summary ? ' ' + structured.executive_summary : ''}`,
  };

  return { structured: patched, applied: true };
}
