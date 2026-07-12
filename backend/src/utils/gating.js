/**
 * Gating determinista — vetos de trade + contradicciones precalculados en el backend.
 *
 * Traslada el bloque HARD GATING y el CONVICTION DECAY del SYSTEM_PROMPT a código: en
 * vez de que el LLM recalcule ANDs de condiciones con umbrales de %, el backend evalúa
 * los flags de forma determinista y el LLM solo obedece.
 *
 * Funciones puras (sin I/O), testeables en aislamiento.
 *
 * Cambios de la auditoría red-team (Fase 2):
 *  - H3 · Vetos LONG/SHORT SIMÉTRICOS: ambos sobre los mismos ejes (CVD 1D + OI + S/R
 *    del TF primario). Se retiró la condición de funding asimétrica del veto short
 *    (funding se gobierna en el prompt vía severity + en el crowdedTradeFlag).
 *  - H2 · FAIL-CLOSED ante datos ausentes: si faltan los inputs críticos compartidos
 *    (CVD 1D u Open Interest) se marca `data_insufficient` → el caller bloquea trades
 *    direccionales en vez de dejar pasar (antes: sin dato, el veto no podía afirmarse
 *    y quedaba vía libre justo cuando el contexto es más incierto).
 *  - H1 · Ausencia de estructura ≠ contradicción: la falta de estructura SMC activa ya
 *    NO cuenta como contradicción "en contra" (es falta de confirmación → va a
 *    missing_structural_confirmation). Solo un CONFLICTO estructural activo (BOS vs
 *    CHoCH opuestos, ambos active) cuenta como contradicción.
 *  - H1 · `price_near_key_level` exige un nivel con historial (>=2 toques), no mera
 *    cercanía a cualquier pivote.
 *  - H4 · DEDUPE veto↔contradicciones: si un veto está activo, no se recuentan como
 *    contradicciones "independientes" los hechos que ya construyeron ese veto
 *    (CVD 1D, cercanía a nivel, OI sin expandir) — evita sobre-determinar la decisión
 *    con datos correlados.
 *
 * Auditoría #2 (2026-07-10, hallazgo 2 — semántica CVD/absorción):
 *  - La divergencia CVD 1D solo afirma veto/contradicción con cvd_strength no-marginal.
 *    Racional: precio↑+CVD↓ es AMBIGUO (el prompt lo lee como absorción ALCISTA sobre
 *    soporte); la desambiguación bajista del veto es la CONJUNCIÓN con resistencia
 *    probada + OI estancado (rally débil/distribución), y exige un desequilibrio real
 *    (moderate/strong), no ruido marginal. Ver INTERPRETACIÓN CVD del SYSTEM_PROMPT.
 */

// Fuerzas de CVD que afirman una divergencia como señal (auditoría #2, hallazgo 2):
// una divergencia precio↔CVD es AMBIGUA (el prompt lee precio↑+CVD↓ como absorción
// ALCISTA sobre soporte) y con cvd_strength="marginal" es además ruido de fondo según
// el propio prompt. El veto y la contradicción solo la cuentan con fuerza no-marginal:
// la conjunción con resistencia probada + OI estancado es la desambiguación bajista
// (rally débil/distribución), pero exige que el desequilibrio sea real, no marginal.
const CVD_AFFIRMING_STRENGTHS = new Set(['moderate', 'strong']);

const NEAR_LEVEL_PCT = 1.5; // fallback fijo si no hay ATR del TF primario
// Umbral de cercanía NORMALIZADO POR VOLATILIDAD (auditoría #2, hallazgos 7/14): 1.5%
// fijo hacía que la contradicción/veto "precio en nivel" disparara con frecuencias
// estructuralmente distintas por activo (la vol diaria de SOL dobla la de BTC) y por TF
// (en 1h casi siempre hay un nivel a <1.5%; en 1W casi nunca). k=1.5 × ATR% del TF
// primario ≈ el 1.5% histórico para BTC 4h (ATR%≈1), acotado para no degenerar.
const NEAR_LEVEL_ATR_MULT = 1.5;
const NEAR_LEVEL_MIN_PCT = 0.5;
const NEAR_LEVEL_MAX_PCT = 3.0;

// Tolerancias de zona BORDERLINE (telemetría, hallazgo 9): un veto que se activa o se
// queda a un tick de activarse por décimas es una decisión de borde — se señala en
// gating.borderline[] para poder auditar cuántas decisiones viven pegadas al umbral.
// (Una histéresis real exigiría estado entre requests; el sistema es stateless.)
const OI_BORDERLINE_PT = 0.25;      // |change_24h_pct − umbral| <= 0.25 puntos
const LEVEL_BORDERLINE_FACTOR = 1.25; // nivel fuerte entre 1× y 1.25× del umbral

/** Umbral efectivo de cercanía a nivel para un ATR% dado (fallback al fijo). */
export function dynamicNearLevelPct(atrPct) {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return NEAR_LEVEL_PCT;
  const v = NEAR_LEVEL_ATR_MULT * atrPct;
  return parseFloat(Math.max(NEAR_LEVEL_MIN_PCT, Math.min(NEAR_LEVEL_MAX_PCT, v)).toFixed(2));
}
const MIN_TOUCHES = 3;      // veto: nivel fuerte = 3+ toques
const CONTRADICTION_MIN_TOUCHES = 2; // contradicción: nivel con algo de historial (>=2)
const OI_EXPANSION_PCT = 1; // "OI no está expandiendo" = change_24h_pct < +1%

// Bloque analítico de cada contradicción determinista. La ANTI-DOUBLE-COUNT RULE (B1) exige
// que la confluencia venga de bloques DISTINTOS: varias señales del MISMO bloque (p.ej. dos
// conflictos estructurales — HTF y SMC) son el mismo eje y NO son evidencia independiente.
// `contradiction_count` mide bloques distintos, no señales sueltas, para que la puerta de
// >=3 → Esperar no se dispare por hechos correlacionados del mismo bloque (mismo criterio
// que el dedupe veto↔contradicciones de H4, aplicado también a la ruta sin veto).
const CONTRADICTION_BLOCK = {
  cvd_1d_divergence:       'volume',
  oi_flat_or_falling:      'derivatives',
  price_near_key_level:    'structure',
  htf_conflict_1w_1d:      'structure',
  smc_structural_conflict: 'structure',
};

/** Nº de bloques analíticos DISTINTOS representados en una lista de contradicciones. */
function countBlocks(list) {
  return new Set(list.map((c) => c.block ?? CONTRADICTION_BLOCK[c.code])).size;
}

// ¿La tendencia (string tipo "strongly_bullish"/"bearish"/"neutral") es alcista/bajista?
function trendDir(t) {
  if (!t) return null;
  if (t.includes('bull')) return 'bull';
  if (t.includes('bear')) return 'bear';
  return 'neutral';
}

// Normaliza la dirección de un evento SMC a 'bull'/'bear'/null (acepta 'bullish'/'bearish').
function smcDir(d) {
  if (!d) return null;
  if (d.includes('bull')) return 'bull';
  if (d.includes('bear')) return 'bear';
  return null;
}

/**
 * ¿Existe algún nivel en `levels` a <= NEAR_LEVEL_PCT del precio y con >= minTouches
 * toques? Escanea toda la lista (no solo el más cercano): un nivel algo más lejano
 * pero con más toques es el que arma el veto, no necesariamente levels[0].
 *
 * @param {Array<{price:number, touches?:number}>} levels
 * @param {number} price
 * @param {number} [minTouches=MIN_TOUCHES]
 * @param {number} [maxDistPct=NEAR_LEVEL_PCT] - umbral efectivo (normalizado por ATR).
 * @returns {{ found: boolean, level: object|null, distance_pct: number|null }}
 */
export function nearStrongLevel(levels, price, minTouches = MIN_TOUCHES, maxDistPct = NEAR_LEVEL_PCT) {
  if (!Array.isArray(levels) || !price) {
    return { found: false, level: null, distance_pct: null };
  }
  for (const lvl of levels) {
    if (lvl?.price == null) continue;
    const distPct = (Math.abs(price - lvl.price) / price) * 100;
    if (distPct <= maxDistPct && (lvl.touches ?? 0) >= minTouches) {
      return { found: true, level: lvl, distance_pct: parseFloat(distPct.toFixed(2)) };
    }
  }
  return { found: false, level: null, distance_pct: null };
}

/**
 * Calcula los vetos de trade (HARD GATING) de forma determinista y SIMÉTRICA.
 *
 * VETO LONG — las tres a la vez:
 *   1. CVD 1D con divergence="bearish"
 *   2. Open Interest no expande (change_24h_pct < +1%)
 *   3. precio dentro del 1.5% de una resistencia (TF primario) con 3+ toques
 *
 * VETO SHORT — espejo exacto:
 *   1. CVD 1D con divergence="bullish"
 *   2. Open Interest no expande (change_24h_pct < +1%)
 *   3. precio dentro del 1.5% de un soporte (TF primario) con 3+ toques
 *
 * FAIL-CLOSED (H2): los inputs críticos compartidos son CVD 1D y Open Interest. Si
 * falta alguno, `data_insufficient=true` y `missing_inputs` lo lista. Cada condición
 * sigue exigiendo el dato para AFIRMARSE (no se veta sobre datos ausentes), pero el
 * caller usa `data_insufficient` para NO dejar pasar trades direccionales a ciegas.
 *
 * @param {object} args
 * @param {object} args.technical
 * @param {{change_24h_pct?: number|null}|null} args.openInterest
 * @param {number|null} args.currentPrice
 * @param {string} args.primaryTf
 * @returns {{ veto_long:boolean, veto_short:boolean, veto_reason:string|null,
 *             data_insufficient:boolean, missing_inputs:string[], conditions:object }}
 */
export function computeVetos({ technical, openInterest, currentPrice, primaryTf }) {
  const cvd1D = technical?.['1D']?.cvd ?? null;
  const primarySr = technical?.[primaryTf]?.support_resistance ?? null;
  const nearPct = dynamicNearLevelPct(technical?.[primaryTf]?.atr?.pct);

  const oiChange = openInterest?.change_24h_pct ?? null;
  const cvd1DPresent = cvd1D?.divergence != null;
  const oiPresent = oiChange != null;

  // FAIL-CLOSED: inputs críticos compartidos por ambos vetos.
  const missing_inputs = [];
  if (!cvd1DPresent) missing_inputs.push('cvd_1d');
  if (!oiPresent) missing_inputs.push('open_interest');
  const data_insufficient = missing_inputs.length > 0;

  const oiNotExpanding = oiPresent && oiChange < OI_EXPANSION_PCT;

  // La divergencia solo afirma la pata CVD con fuerza no-marginal (ver
  // CVD_AFFIRMING_STRENGTHS). cvd_strength ausente = no se puede afirmar → sin veto
  // (misma filosofía que el resto de condiciones: el dato debe estar para AFIRMARSE).
  const cvdStrengthOk = CVD_AFFIRMING_STRENGTHS.has(cvd1D?.cvd_strength);

  // --- VETO LONG ---
  const cvd1DBearish = cvd1D?.divergence === 'bearish' && cvdStrengthOk;
  const nearResistance = nearStrongLevel(primarySr?.resistances, currentPrice, MIN_TOUCHES, nearPct);
  const vetoLong = cvd1DBearish && oiNotExpanding && nearResistance.found;

  // --- VETO SHORT (espejo) ---
  const cvd1DBullish = cvd1D?.divergence === 'bullish' && cvdStrengthOk;
  const nearSupport = nearStrongLevel(primarySr?.supports, currentPrice, MIN_TOUCHES, nearPct);
  const vetoShort = cvd1DBullish && oiNotExpanding && nearSupport.found;

  // --- Telemetría BORDERLINE (hallazgo 9): condiciones pegadas al umbral ---
  // Señala decisiones de borde: el OI a <=0.25 puntos de flipear su condición, o un
  // nivel fuerte justo fuera del umbral (entre 1× y 1.25×). No altera los vetos.
  const borderline = [];
  if (oiPresent && Math.abs(oiChange - OI_EXPANSION_PCT) <= OI_BORDERLINE_PT) {
    borderline.push(`oi_change_near_threshold (${oiChange}% vs ${OI_EXPANSION_PCT}%)`);
  }
  const nearResWide = nearStrongLevel(primarySr?.resistances, currentPrice, MIN_TOUCHES, nearPct * LEVEL_BORDERLINE_FACTOR);
  if (!nearResistance.found && nearResWide.found) {
    borderline.push(`resistance_just_outside_threshold (${nearResWide.distance_pct}% vs ${nearPct}%)`);
  }
  const nearSupWide = nearStrongLevel(primarySr?.supports, currentPrice, MIN_TOUCHES, nearPct * LEVEL_BORDERLINE_FACTOR);
  if (!nearSupport.found && nearSupWide.found) {
    borderline.push(`support_just_outside_threshold (${nearSupWide.distance_pct}% vs ${nearPct}%)`);
  }

  let veto_reason = null;
  if (vetoLong) {
    veto_reason =
      `VETO LONG: CVD 1D bearish divergence (strength=${cvd1D.cvd_strength}) + OI sin expandir (change_24h_pct=${oiChange}%) ` +
      `+ resistencia ${primaryTf} a ${nearResistance.distance_pct}% con ${nearResistance.level.touches} toques`;
  } else if (vetoShort) {
    veto_reason =
      `VETO SHORT: CVD 1D bullish divergence (strength=${cvd1D.cvd_strength}) + OI sin expandir (change_24h_pct=${oiChange}%) ` +
      `+ soporte ${primaryTf} a ${nearSupport.distance_pct}% con ${nearSupport.level.touches} toques`;
  }

  return {
    veto_long: vetoLong,
    veto_short: vetoShort,
    veto_reason,
    data_insufficient,
    missing_inputs,
    near_level_pct_used: nearPct,
    borderline,
    conditions: {
      sr_timeframe: primaryTf,
      long: {
        cvd_1d_bearish: cvd1DBearish,
        oi_not_expanding: oiNotExpanding,
        near_resistance_3plus_touches: nearResistance.found,
      },
      short: {
        cvd_1d_bullish: cvd1DBullish,
        oi_not_expanding: oiNotExpanding,
        near_support_3plus_touches: nearSupport.found,
      },
    },
  };
}

/**
 * Precalcula las contradicciones deterministas del CONVICTION DECAY del SYSTEM_PROMPT.
 *
 * Cubre 5 de las 6 condiciones (todas menos "Volume Flow Score negativo con Structure
 * Score positivo", que depende de scores que solo existen en el output del LLM). El
 * prompt suma esa sexta si aplica. Cada condición exige el dato presente.
 *
 * Semántica revisada (H1): la falta de estructura SMC activa NO es una contradicción
 * (es falta de confirmación → `missing_structural_confirmation`). Solo un CONFLICTO
 * estructural activo (BOS vs CHoCH opuestos, ambos "active") cuenta como contradicción.
 *
 * @param {object} args
 * @param {object} args.technical
 * @param {{change_24h_pct?: number|null}|null} args.openInterest
 * @param {number|null} args.currentPrice
 * @param {string} args.primaryTf
 * @returns {{ contradictions: Array<{code:string, detail:string}>, contradiction_count: number,
 *             missing_structural_confirmation: boolean }}
 */
export function computeContradictions({ technical, openInterest, currentPrice, primaryTf }) {
  const contradictions = [];
  const pTf = technical?.[primaryTf] ?? null;

  // 1. CVD 1D en divergencia con el precio — solo con fuerza no-marginal (mismo criterio
  //    que el veto: una divergencia marginal es ruido, no un bloque de contradicción).
  const cvd1DDiv = technical?.['1D']?.cvd?.divergence ?? null;
  const cvd1DStrength = technical?.['1D']?.cvd?.cvd_strength ?? null;
  if (cvd1DDiv && cvd1DDiv !== 'none' && CVD_AFFIRMING_STRENGTHS.has(cvd1DStrength)) {
    contradictions.push({
      code: 'cvd_1d_divergence',
      block: 'volume',
      detail: `CVD 1D divergence="${cvd1DDiv}" (strength=${cvd1DStrength})`,
    });
  }

  // 2. OI plano o cayendo (change_24h_pct < 0).
  const oiChange = openInterest?.change_24h_pct ?? null;
  if (oiChange != null && oiChange < 0) {
    contradictions.push({ code: 'oi_flat_or_falling', block: 'derivatives', detail: `OI change_24h_pct=${oiChange}%` });
  }

  // 3. Precio pegado a un nivel S/R con historial (>=2 toques) dentro del umbral
  //    normalizado por ATR del TF primario (antes 1.5% fijo — hallazgos 7/14).
  //    H1: exigir toques evita que cualquier pivote menor cercano dispare la contradicción.
  const sr = pTf?.support_resistance ?? null;
  const nearPct = dynamicNearLevelPct(pTf?.atr?.pct);
  const nearSup = nearStrongLevel(sr?.supports, currentPrice, CONTRADICTION_MIN_TOUCHES, nearPct);
  const nearRes = nearStrongLevel(sr?.resistances, currentPrice, CONTRADICTION_MIN_TOUCHES, nearPct);
  if (nearSup.found || nearRes.found) {
    const near = nearSup.found ? nearSup : nearRes;
    contradictions.push({
      code: 'price_near_key_level',
      block: 'structure',
      detail: `precio a ${near.distance_pct}% de un nivel S/R (${primaryTf}) con ${near.level.touches} toques (umbral ${nearPct}%)`,
    });
  }

  // 4. Conflicto entre 1W y 1D (tendencias opuestas y direccionales).
  const d1W = trendDir(technical?.['1W']?.trend);
  const d1D = trendDir(technical?.['1D']?.trend);
  if (d1W && d1D && d1W !== 'neutral' && d1D !== 'neutral' && d1W !== d1D) {
    contradictions.push({
      code: 'htf_conflict_1w_1d',
      block: 'structure',
      detail: `1W (${technical['1W'].trend}) vs 1D (${technical['1D'].trend}) opuestos`,
    });
  }

  // 5. CONFLICTO estructural activo (H1): BOS y CHoCH ambos "active" y en direcciones
  //    OPUESTAS = señal estructural en disputa → contradicción real. La mera ausencia de
  //    estructura activa NO cuenta aquí; se reporta como missing_structural_confirmation.
  const smc = pTf?.smc ?? null;
  const bos = smc?.last_bos?.signal_status === 'active' ? smc.last_bos : null;
  const choch = smc?.last_choch?.signal_status === 'active' ? smc.last_choch : null;
  const hasActiveStructure = !!(bos || choch);
  const structuralConflict =
    bos && choch && smcDir(bos.direction) && smcDir(choch.direction) &&
    smcDir(bos.direction) !== smcDir(choch.direction);
  if (structuralConflict) {
    contradictions.push({
      code: 'smc_structural_conflict',
      block: 'structure',
      detail: `BOS (${bos.direction}) vs CHoCH (${choch.direction}) activos y opuestos en ${primaryTf}`,
    });
  }
  const missing_structural_confirmation = pTf ? !hasActiveStructure : false;

  return {
    contradictions,
    // Conteo por BLOQUES distintos (no señales sueltas): varias contradicciones del mismo
    // bloque (p.ej. price_near_key_level + htf_conflict + smc_conflict = todas 'structure')
    // cuentan como UNA. Máximo 3 (volume/derivatives/structure).
    contradiction_count: countBlocks(contradictions),
    missing_structural_confirmation,
  };
}

/**
 * Orquestador: combina vetos + contradicciones y aplica DOS deduplicaciones sobre el
 * conteo que gobierna la regla de >=3 → Esperar:
 *
 *  1. DEDUPE veto↔contradicciones (H4): si un veto está activo, los hechos que ya lo
 *     construyeron (CVD 1D, cercanía a nivel, OI sin expandir) no se recuentan como
 *     evidencia independiente.
 *  2. DEDUPE por BLOQUE (B1 / ANTI-DOUBLE-COUNT): `contradiction_count` cuenta bloques
 *     analíticos DISTINTOS (volume/derivatives/structure), no señales sueltas — varias
 *     señales del mismo bloque son el mismo eje. Máximo 3.
 *
 * `contradiction_count` refleja el conteo tras ambas deduplicaciones (el que consume el
 * validador para la puerta CONVICTION DECAY). `contradictions_raw_count` es el conteo de
 * bloques ANTES del dedupe por veto (para telemetría de cuánto descuenta el veto).
 *
 * @param {object} args - { technical, openInterest, currentPrice, primaryTf }
 * @returns {object} bloque `gating` completo para el payload.
 */
export function computeGating(args) {
  const vetos = computeVetos(args);
  const contra = computeContradictions(args);

  const vetoActive = vetos.veto_long || vetos.veto_short;
  // Las TRES patas del veto se descuentan: CVD 1D, cercanía a nivel y también el OI
  // (auditoría #2, hallazgo 6 — `oi_not_expanding` con change<+1% subsume el <0 de la
  // contradicción; con veto activo, recontar el OI era recontar un hecho constituyente).
  const DEDUPE_CODES = new Set(['cvd_1d_divergence', 'price_near_key_level', 'oi_flat_or_falling']);

  let contradictions = contra.contradictions;
  let deduped = [];
  if (vetoActive) {
    deduped = contradictions.filter((c) => DEDUPE_CODES.has(c.code)).map((c) => c.code);
    contradictions = contradictions.filter((c) => !DEDUPE_CODES.has(c.code));
  }

  return {
    ...vetos,
    contradictions,
    contradiction_count: countBlocks(contradictions),
    contradiction_blocks: [...new Set(contradictions.map((c) => c.block ?? CONTRADICTION_BLOCK[c.code]))],
    contradictions_raw_count: countBlocks(contra.contradictions),
    deduped_by_veto: deduped,
    missing_structural_confirmation: contra.missing_structural_confirmation,
  };
}
