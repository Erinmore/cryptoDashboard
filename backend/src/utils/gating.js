/**
 * Gating determinista — vetos de trade precalculados en el backend.
 *
 * Traslada el bloque HARD GATING del SYSTEM_PROMPT a código: en vez de que el LLM
 * recalcule el AND de tres condiciones (con umbrales de %), el backend evalúa los
 * vetos de forma determinista y entrega flags binarios. El LLM solo obedece.
 *
 * Funciones puras (sin I/O), testeables en aislamiento.
 *
 * Decisión de diseño: la S/R del veto se toma del TF primario del análisis
 * (4h por defecto), no de un TF fijo. Ver plan de trabajo / SESSION_STATE.
 */

const NEAR_LEVEL_PCT = 1.5; // "precio dentro del 1.5% de una S/R"
const MIN_TOUCHES = 3;      // "con 3 o más toques"
const OI_EXPANSION_PCT = 1; // "OI no está expandiendo" = change_24h_pct < +1%

// ¿La tendencia (string tipo "strongly_bullish"/"bearish"/"neutral") es alcista/bajista?
function trendDir(t) {
  if (!t) return null;
  if (t.includes('bull')) return 'bull';
  if (t.includes('bear')) return 'bear';
  return 'neutral';
}

/**
 * ¿Existe algún nivel en `levels` a <= NEAR_LEVEL_PCT del precio y con >= MIN_TOUCHES
 * toques? Escanea toda la lista (no solo el más cercano): un nivel algo más lejano
 * pero con más toques es el que arma el veto, no necesariamente levels[0].
 *
 * @param {Array<{price:number, touches?:number}>} levels
 * @param {number} price
 * @returns {{ found: boolean, level: object|null, distance_pct: number|null }}
 */
export function nearStrongLevel(levels, price) {
  if (!Array.isArray(levels) || !price) {
    return { found: false, level: null, distance_pct: null };
  }
  for (const lvl of levels) {
    if (lvl?.price == null) continue;
    const distPct = (Math.abs(price - lvl.price) / price) * 100;
    if (distPct <= NEAR_LEVEL_PCT && (lvl.touches ?? 0) >= MIN_TOUCHES) {
      return { found: true, level: lvl, distance_pct: parseFloat(distPct.toFixed(2)) };
    }
  }
  return { found: false, level: null, distance_pct: null };
}

/**
 * Calcula los vetos de trade (HARD GATING) de forma determinista.
 *
 * VETO LONG — las tres a la vez:
 *   1. CVD 1D con divergence="bearish"
 *   2. Open Interest no expande (change_24h_pct < +1%)
 *   3. precio dentro del 1.5% de una resistencia (TF primario) con 3+ toques
 *
 * VETO SHORT — las tres a la vez:
 *   1. CVD 1D con divergence="bullish"
 *   2. funding severity="normal" o rate negativo
 *   3. precio dentro del 1.5% de un soporte (TF primario) con 3+ toques
 *
 * Cada condición exige el dato presente: si falta OI/funding/CVD 1D no se afirma la
 * condición (no se veta sobre datos ausentes — el veto es un statement fuerte).
 *
 * @param {object} args
 * @param {object} args.technical - bloque `technical` del contexto (por TF)
 * @param {{change_24h_pct?: number|null}|null} args.openInterest
 * @param {{severity?: string, rate_pct?: number|null}|null} args.funding
 * @param {number|null} args.currentPrice
 * @param {string} args.primaryTf
 * @returns {{ veto_long: boolean, veto_short: boolean, veto_reason: string|null, conditions: object }}
 */
export function computeVetos({ technical, openInterest, funding, currentPrice, primaryTf }) {
  const cvd1D = technical?.['1D']?.cvd ?? null;
  const primarySr = technical?.[primaryTf]?.support_resistance ?? null;

  // --- VETO LONG ---
  const oiChange = openInterest?.change_24h_pct ?? null;
  const cvd1DBearish = cvd1D?.divergence === 'bearish';
  const oiNotExpanding = oiChange != null && oiChange < OI_EXPANSION_PCT;
  const nearResistance = nearStrongLevel(primarySr?.resistances, currentPrice);
  const vetoLong = cvd1DBearish && oiNotExpanding && nearResistance.found;

  // --- VETO SHORT ---
  const cvd1DBullish = cvd1D?.divergence === 'bullish';
  const fundingNotSupportive =
    funding != null && (funding.severity === 'normal' || (funding.rate_pct ?? 0) < 0);
  const nearSupport = nearStrongLevel(primarySr?.supports, currentPrice);
  const vetoShort = cvd1DBullish && fundingNotSupportive && nearSupport.found;

  let veto_reason = null;
  if (vetoLong) {
    veto_reason =
      `VETO LONG: CVD 1D bearish divergence + OI sin expandir (change_24h_pct=${oiChange}%) ` +
      `+ resistencia ${primaryTf} a ${nearResistance.distance_pct}% con ${nearResistance.level.touches} toques`;
  } else if (vetoShort) {
    veto_reason =
      `VETO SHORT: CVD 1D bullish divergence + funding no favorable ` +
      `+ soporte ${primaryTf} a ${nearSupport.distance_pct}% con ${nearSupport.level.touches} toques`;
  }

  return {
    veto_long: vetoLong,
    veto_short: vetoShort,
    veto_reason,
    conditions: {
      sr_timeframe: primaryTf,
      long: {
        cvd_1d_bearish: cvd1DBearish,
        oi_not_expanding: oiNotExpanding,
        near_resistance_3plus_touches: nearResistance.found,
      },
      short: {
        cvd_1d_bullish: cvd1DBullish,
        funding_not_supportive: fundingNotSupportive,
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
 * @param {object} args
 * @param {object} args.technical
 * @param {{change_24h_pct?: number|null}|null} args.openInterest
 * @param {string} args.primaryTf
 * @returns {{ contradictions: Array<{code:string, detail:string}>, contradiction_count: number }}
 */
export function computeContradictions({ technical, openInterest, primaryTf }) {
  const contradictions = [];

  // 1. CVD 1D en divergencia con el precio.
  const cvd1DDiv = technical?.['1D']?.cvd?.divergence ?? null;
  if (cvd1DDiv && cvd1DDiv !== 'none') {
    contradictions.push({ code: 'cvd_1d_divergence', detail: `CVD 1D divergence="${cvd1DDiv}"` });
  }

  // 2. OI plano o cayendo (change_24h_pct < 0).
  const oiChange = openInterest?.change_24h_pct ?? null;
  if (oiChange != null && oiChange < 0) {
    contradictions.push({ code: 'oi_flat_or_falling', detail: `OI change_24h_pct=${oiChange}%` });
  }

  // 3. Resistencia o soporte relevante a menos del 1.5% (TF primario).
  const pTf = technical?.[primaryTf] ?? null;
  const dS = pTf?.distance_to_nearest_support_pct;
  const dR = pTf?.distance_to_nearest_resistance_pct;
  const nearLevel = (dS != null && dS <= NEAR_LEVEL_PCT) || (dR != null && dR <= NEAR_LEVEL_PCT);
  if (nearLevel) {
    contradictions.push({
      code: 'price_near_key_level',
      detail: `precio a <=${NEAR_LEVEL_PCT}% de S/R (${primaryTf}): support=${dS}%, resistance=${dR}%`,
    });
  }

  // 4. Conflicto entre 1W y 1D (tendencias opuestas y direccionales).
  const d1W = trendDir(technical?.['1W']?.trend);
  const d1D = trendDir(technical?.['1D']?.trend);
  if (d1W && d1D && d1W !== 'neutral' && d1D !== 'neutral' && d1W !== d1D) {
    contradictions.push({
      code: 'htf_conflict_1w_1d',
      detail: `1W (${technical['1W'].trend}) vs 1D (${technical['1D'].trend}) opuestos`,
    });
  }

  // 6. Señal SMC estructural principal ausente / fuera del umbral táctico del TF primario.
  //    El backend descarta (null) los BOS/CHoCH fuera de umbral, así que ambos null =
  //    no hay confirmación estructural activa.
  const smc = pTf?.smc ?? null;
  if (smc && !smc.last_bos && !smc.last_choch) {
    contradictions.push({
      code: 'no_active_smc_structure',
      detail: `sin BOS/CHoCH dentro del umbral táctico en ${primaryTf}`,
    });
  }

  return { contradictions, contradiction_count: contradictions.length };
}
