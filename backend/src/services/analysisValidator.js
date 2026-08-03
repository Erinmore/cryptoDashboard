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

// `Preparar` RETIRADO el 2026-08-03 (P5). Sale del enum a propósito: si el modelo lo emitiera
// pese al prompt, `action_enum` lo marca como salida inválida en vez de dejarlo pasar.
// ⚠️ Los LECTORES (utils/stats.js, dbService) siguen tratándolo como abstención: las filas
// históricas con ese valor deben seguir siendo interpretables. Escritores dejan de producirlo,
// lectores siguen entendiéndolo — que es para lo que sirve el versionado por fila (L2/A3).
const ACTIONS = ['Comprar', 'Vender', 'Esperar'];
const CONFIDENCES = ['Alta', 'Media', 'Baja'];
const DRIVERS = ['derivatives', 'structure', 'macro', 'volume', 'onchain'];
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
  // COHERENCIA confidence ↔ conviction. Eran dos salidas para la misma magnitud sin
  // ninguna relación definida: el modelo podía emitir confidence="Alta" con conviction=0.2
  // y nada se quejaba. Desde v8_2 confidence es la discretización de conviction, con los
  // MISMOS cortes que `convictionBucket` de utils/stats.js — así la calibración de
  // convicción del backtest mide la misma escala que reporta el modelo.
  // Severidad `minor`: es incoherencia de formato, no una decisión mal tomada; no debe
  // degradar la acción a Esperar.
  if (Number.isFinite(conviction) && CONFIDENCES.includes(confidence)) {
    const esperado = conviction < 0.4 ? 'Baja' : conviction < 0.7 ? 'Media' : 'Alta';
    if (esperado !== confidence) {
      warn('confidence_conviction_mismatch', 'minor',
        `confidence="${confidence}" no corresponde a conviction=${conviction} (esperado "${esperado}")`);
    }
  }
  if (structured.primary_driver != null && !DRIVERS.includes(structured.primary_driver)) {
    warn('primary_driver_enum', 'minor', `primary_driver="${structured.primary_driver}" no es uno de ${DRIVERS.join('|')}`);
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
  // (La puerta de PREPARAR se retiró con la propia acción — P5, 2026-08-03.)

  // ── Guardia de divergencia de scores (C2) ─────────────────────────────────
  // La puerta de arriba compara el score del LLM contra sí misma (circular). Aquí lo
  // comparamos contra el score ESPERADO por el backend desde el dato. Solo se dispara
  // cuando el LLM abre la puerta en una dirección (score en el lado que autoriza el trade)
  // pero el dato lee CLARAMENTE lo contrario (esperado en el lado opuesto, |.|>=1). Es
  // deliberadamente conservador: no micro-gestiona, solo caza contradicciones flagrantes.
  const exp = opts.expectedScores;
  if (exp) {
    // Dirección efectiva del análisis: Comprar/Vender por la acción; Preparar por la
    // geometría de su setup ejecutable (long si stop<entry) — sin esto, Preparar era
    // una vía de escape de la guardia (auditoría #2, hallazgo 5).
    const geomDir = (setup != null && isNum(setup.entry_price) && isNum(setup.stop_price)
      && setup.stop_price !== setup.entry_price)
      ? (setup.stop_price < setup.entry_price ? 'long' : 'short') : null;
    const effDir = action === 'Comprar' ? 'long'
      : action === 'Vender' ? 'short'
      : (action === 'Preparar' && has_executable_setup === true) ? geomDir
      : null;
    const checkDiv = (block) => {
      const llm = s[block];
      const e = exp[block]?.score;
      if (!isInt(llm) || !isNum(e) || !effDir) return;
      if (effDir === 'long' && llm >= 1 && e <= -1) {
        warn(`score_divergence_${block}`, 'severe',
          `${action} (long) con ${block}=${llm} pero el backend espera ${block}≈${e} desde el dato (${(exp[block].basis || []).join('; ')})`);
      }
      if (effDir === 'short' && llm <= -1 && e >= 1) {
        warn(`score_divergence_${block}`, 'severe',
          `${action} (short) con ${block}=${llm} pero el backend espera ${block}≈${e} desde el dato (${(exp[block].basis || []).join('; ')})`);
      }
    };
    // Solo `volume`: el Derivatives Score lo calcula el backend desde el 2026-07-29, así que
    // no puede divergir de sí mismo. Ver la nota en utils/expectedScores.js.
    checkDiv('volume');
  }

  // ── Coherencia de existencia de setup ─────────────────────────────────────
  const hasSetup = setup != null;

  // M1 · Un trade sin geometría no es un trade: es una opinión, y una opinión no se puede
  // evaluar ni gestionar. SEVERE porque degradar a Esperar es preferible a persistir un
  // direccional imposible de medir — `evaluateSetupBarrier` no puede evaluarlo y el backtest
  // caería a la medida débil (dirección al horizonte).
  if ((action === 'Comprar' || action === 'Vender') && (has_executable_setup !== true || !hasSetup)) {
    warn('directional_without_setup', 'severe',
      `${action} sin setup ejecutable: una acción direccional exige entry/stop/tp para poder evaluarse`);
  }

  // M4 · El setup condicional hace medible la abstención: sin geometría declarada, un
  // Esperar es incontestable por construcción. `minor` a propósito — su ausencia es un
  // defecto de reporte, no una decisión mal tomada, así que no debe degradar la acción.
  const cond = structured?.conditional_setup ?? null;
  if ((action === 'Esperar' || action === 'Preparar') && !cond) {
    warn('missing_conditional_setup', 'minor',
      `${action} sin conditional_setup: no se puede evaluar a posteriori si fue prudencia o parálisis`);
  }
  if (cond) {
    const { entry_price: ce, stop_price: cs, tp1_price: ct, direction: cdir, trigger } = cond;
    // Comprobable = contiene al menos un NÚMERO (un nivel, un precio, un porcentaje). No se
    // mide por longitud: "si mejora el momentum" son 22 caracteres y no es verificable,
    // mientras que "cierre > 76.57" son 14 y sí lo es. Un umbral de longitud habría sido
    // otra constante inventada.
    if (!trigger || !/\d/.test(String(trigger))) {
      warn('conditional_trigger_vague', 'minor',
        'conditional_setup.trigger sin ningún nivel numérico: no es comprobable a posteriori');
    }
    if (isNum(ce) && isNum(cs)) {
      if (ce === cs) {
        warn('conditional_stop_eq_entry', 'minor', `conditional_setup stop==entry (${ce})`);
      } else {
        const cLong = cs < ce;
        if (cdir && ((cdir === 'long') !== cLong)) {
          warn('conditional_direction_mismatch', 'minor',
            `conditional_setup.direction=${cdir} pero la geometría es ${cLong ? 'long' : 'short'}`);
        }
        if (isNum(ct)) {
          if ((cLong && ct <= ce) || (!cLong && ct >= ce)) {
            warn('conditional_tp_side', 'minor', `conditional_setup tp1=${ct} en el lado equivocado de entry=${ce}`);
          }
          // ⚠️ AQUÍ HABÍA UN `conditional_low_rr` CON CORTE EN R:R < 1. Retirado el
          // 2026-08-01 tras MEDIRLO (`scripts/auditConditionalRR.mjs`): el aviso presuponía
          // que por debajo de 1 la geometría rinde peor, y no hay tal cosa. Barridas 7
          // geometrías × 2 formas de mover el cociente sobre 3 monedas (n≈1.945-3.204
          // réplicas por celda, evaluador y agregador REALES), **la expectativa es plana y
          // ≈0 en todo el rango** y el acierto calca el equilibrio (67,1 vs 66,7 · 57,5 vs
          // 57,1 · 50,0 vs 50,0 · 43,5 vs 44,4): es la identidad del paseo sin deriva,
          // P(TP primero) ≈ riesgo/(riesgo+recompensa), o sea que el acierto BAJA
          // exactamente lo que sube el premio. Un R:R bajo no es una geometría peor, es
          // otra apuesta — y lo único que cambia con él, el win-rate de equilibrio, ya
          // viaja calculado en `breakeven_win_rate_pct`. El corte en 1 era un número
          // redondo sin distribución detrás, del mismo tipo que T1-T6.
          // (Un barrido daba +0,204R a R:R 0,5, pero el control con la entrada EN el precio
          // lo aplana a −0,004R: era selección por el llenado —entrar tras 0,75×ATR en
          // contra— y no una propiedad del R:R. Publicarlo habría sido otra cifra que no
          // significa lo que dice.)
          // Lo que SÍ resultó medible es otra cosa, y ocupa ahora su sitio: no la CALIDAD de
          // la geometría sino la COHERENCIA de la declaración. Si el objetivo está a una
          // distancia que el mercado no recorre en las velas que el propio análisis declara,
          // el resultado no vendrá del objetivo sino de la caducidad — la declaración es
          // inerte, igual que un `trigger` sin números. Eje y corte medidos en
          // `scripts/auditTargetReachability.mjs` (curva `TARGET_REACHABILITY` en stats.js).
          //
          // Llega YA CALCULADO en vez de importarse: este módulo se declara sin dependencias
          // y la curva tiene un único dueño en stats.js. Duplicarla aquí serían dos verdades
          // sobre lo mismo, que es el fallo que este proyecto persigue.
          const reach = opts.targetReachability;   // { pct, min, d } | null
          if (isNum(reach?.pct) && isNum(reach?.min) && reach.pct < reach.min) {
            warn('conditional_target_unreachable', 'minor',
              `conditional_setup: tp1 a ${Number(reach.d).toFixed(2)} unidades de recorrido de la `
              + `vigencia declarada → alcanzable el ${reach.pct}% de las veces (umbral ${reach.min}%); `
              + 'el resultado lo decidiría la caducidad, no el objetivo');
          }
        }
      }
    }
  }

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
  // Auditoría #2, hallazgo 18: una geometría incoherente (stop==entry: dirección
  // indeterminable; TP en el lado de la pérdida) en un setup EJECUTABLE se muestra al
  // usuario con niveles operables → severe (degrada y neutraliza el setup). Si el LLM
  // no lo declaró ejecutable, queda en minor (telemetría).
  const geomSeverity = has_executable_setup === true ? 'severe' : 'minor';
  if (hasSetup) {
    const { entry_price, stop_price, tp1_price } = setup;
    if (isNum(entry_price) && isNum(stop_price) && isNum(tp1_price)) {
      if (stop_price === entry_price) {
        warn('setup_stop_eq_entry', geomSeverity, `setup stop_price==entry_price (${entry_price})`);
      } else {
        const dir = stop_price < entry_price ? 'long' : 'short';
        // TP1 debe estar en el lado del beneficio según la dirección.
        const tpOk = dir === 'long' ? tp1_price > entry_price : tp1_price < entry_price;
        if (!tpOk) {
          warn('setup_tp_side', geomSeverity, `setup ${dir}: tp1=${tp1_price} en el lado equivocado de entry=${entry_price}`);
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
