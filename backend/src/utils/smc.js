/**
 * smc.js — Smart Money Concepts: swings, BOS, CHoCH, FVG.
 *
 * Funciones puras sobre candles {t, open, high, low, close, volume}.
 * Sin I/O, sin dependencias externas.
 *
 * Definiciones operativas (las del libro de SMC, simplificadas y deterministas):
 *
 *   - Swing high/low: pivote fractal. Una vela `i` es swing high si su `high`
 *     es estrictamente mayor que el `high` de las `lookback` velas a cada lado.
 *     Análogo para swing low con `low`.
 *
 *   - BOS (Break of Structure): el cierre actual rompe el último swing
 *     EN LA DIRECCIÓN DE LA TENDENCIA PREVIA. Confirma continuación.
 *     - Bullish BOS: tendencia previa = alcista (HH/HL) y close > swing_high previo.
 *     - Bearish BOS: tendencia previa = bajista (LH/LL) y close < swing_low previo.
 *
 *   - CHoCH (Change of Character): el cierre actual rompe el último swing
 *     EN DIRECCIÓN OPUESTA a la tendencia previa. Primer aviso de reversión.
 *     - Bullish CHoCH: tendencia previa bajista, close > último swing_high.
 *     - Bearish CHoCH: tendencia previa alcista, close < último swing_low.
 *
 *   - FVG (Fair Value Gap): patrón de 3 velas con hueco entre vela `i` y `i-2`.
 *     - Bullish FVG: low[i] > high[i-2]   → zona [high[i-2], low[i]]
 *     - Bearish FVG: high[i] < low[i-2]   → zona [high[i], low[i-2]]
 *     "Unmitigated" si ninguna vela posterior cubrió la zona con su rango.
 *
 * Las funciones devuelven `null` (no objetos vacíos) cuando no hay datos
 * suficientes o cuando no hay evento detectable, para alinear con el resto
 * del payload (el LLM trata `null` como "señal ausente").
 */

/**
 * Detecta swings fractales sobre el array de candles.
 *
 * @param {Array<{high:number, low:number, close:number, t:number}>} candles
 * @param {number} [lookback=2] - Velas a cada lado a comparar. 2 = pivot de 5 velas.
 * @returns {{ highs: Array<{idx,t,price}>, lows: Array<{idx,t,price}> } | null}
 */
export function detectSwings(candles, lookback = 2) {
  if (!candles || candles.length < lookback * 2 + 1) return null;
  const highs = [];
  const lows = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= h || candles[i + j].high >= h) isHigh = false;
      if (candles[i - j].low  <= l || candles[i + j].low  <= l) isLow  = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ idx: i, t: candles[i].t, price: h });
    if (isLow)  lows.push({  idx: i, t: candles[i].t, price: l });
  }

  return { highs, lows };
}

/**
 * Determina la tendencia estructural previa al cierre actual leyendo los
 * últimos dos swings high y los últimos dos swings low.
 *
 *   - HH + HL → bullish
 *   - LH + LL → bearish
 *   - cualquier otra combinación → ranging (no hay estructura definida)
 *
 * @returns {'bullish'|'bearish'|'ranging'|null}
 */
function inferStructuralTrend(swings) {
  if (!swings) return null;
  const { highs, lows } = swings;
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHigh = highs.at(-1).price;
  const prevHigh = highs.at(-2).price;
  const lastLow  = lows.at(-1).price;
  const prevLow  = lows.at(-2).price;

  const hh = lastHigh > prevHigh;
  const hl = lastLow  > prevLow;
  const lh = lastHigh < prevHigh;
  const ll = lastLow  < prevLow;

  if (hh && hl) return 'bullish';
  if (lh && ll) return 'bearish';
  return 'ranging';
}

/**
 * Detecta el último BOS (continuación de tendencia previa).
 *
 * @param {Array} candles
 * @param {{ lookback?: number, maxCandlesAgo?: number }} [opts]
 *   maxCandlesAgo: si el break_candle está más lejos del final del array que este
 *   umbral, el evento se descarta (devuelve null). Alinear con el decay del prompt
 *   según el TF: 4H→12, 1D→9, 1H→18, 1W→6. Sin límite por defecto (Infinity).
 * @returns {{
 *   direction: 'bullish'|'bearish',
 *   broken_swing_price: number,
 *   broken_swing_t: number,
 *   break_candle_idx: number,
 *   break_candle_t: number,
 *   close: number
 * } | null}
 */
export function detectLastBOS(candles, { lookback = 2, maxCandlesAgo = Infinity } = {}) {
  const swings = detectSwings(candles, lookback);
  if (!swings) return null;
  const trend = inferStructuralTrend(swings);
  if (trend !== 'bullish' && trend !== 'bearish') return null;

  const { highs, lows } = swings;
  const refSwings = trend === 'bullish' ? highs : lows;

  // Recogemos el primer break de cada swing (el que fijó el evento estructural),
  // luego nos quedamos con el de mayor break_candle_idx (más reciente en tiempo).
  // Así "last BOS" es realmente el último cronológicamente, no el primero desde
  // el swing más nuevo en posición del array.
  let best = null;
  for (const swing of refSwings) {
    for (let i = swing.idx + 1; i < candles.length; i++) {
      const close = candles[i].close;
      const breaks = (trend === 'bullish' && close > swing.price) ||
                     (trend === 'bearish' && close < swing.price);
      if (breaks) {
        if (!best || i > best.break_candle_idx) {
          best = {
            direction:          trend,
            broken_swing_price: swing.price,
            broken_swing_t:     swing.t,
            break_candle_idx:   i,
            break_candle_t:     candles[i].t,
            close,
          };
        }
        break; // primer break de este swing encontrado; pasar al siguiente swing
      }
    }
  }

  if (!best) return null;
  const candlesAgo = candles.length - 1 - best.break_candle_idx;
  return candlesAgo > maxCandlesAgo ? null : best;
}

/**
 * Detecta el último CHoCH (reversión: rompe en dirección opuesta a la
 * tendencia previa).
 *
 * @param {Array} candles
 * @param {{ lookback?: number, maxCandlesAgo?: number }} [opts]
 * @returns {{direction, broken_swing_price, broken_swing_t, break_candle_idx, break_candle_t, close} | null}
 */
export function detectLastCHoCH(candles, { lookback = 2, maxCandlesAgo = Infinity } = {}) {
  const swings = detectSwings(candles, lookback);
  if (!swings) return null;
  const trend = inferStructuralTrend(swings);
  if (trend !== 'bullish' && trend !== 'bearish') return null;

  // CHoCH: tendencia previa bajista pero close rompe swing high → bullish CHoCH
  //        tendencia previa alcista pero close rompe swing low  → bearish CHoCH
  const { highs, lows } = swings;
  const refSwings = trend === 'bearish' ? highs : lows;
  const direction = trend === 'bearish' ? 'bullish' : 'bearish';

  // Mismo patrón que detectLastBOS: primer break de cada swing, luego el más reciente.
  let best = null;
  for (const swing of refSwings) {
    for (let i = swing.idx + 1; i < candles.length; i++) {
      const close = candles[i].close;
      const breaks = (direction === 'bullish' && close > swing.price) ||
                     (direction === 'bearish' && close < swing.price);
      if (breaks) {
        if (!best || i > best.break_candle_idx) {
          best = {
            direction,
            broken_swing_price: swing.price,
            broken_swing_t:     swing.t,
            break_candle_idx:   i,
            break_candle_t:     candles[i].t,
            close,
          };
        }
        break;
      }
    }
  }

  if (!best) return null;
  const candlesAgo = candles.length - 1 - best.break_candle_idx;
  return candlesAgo > maxCandlesAgo ? null : best;
}

/**
 * Detecta FVGs no mitigados en las últimas `windowBars` velas.
 *
 * Un FVG queda mitigado si alguna vela POSTERIOR a la vela `i` (la 3ª del
 * patrón) tiene rango que se solapa con la zona del gap. Se permiten mitigaciones
 * parciales: "unmitigated" estricto requiere que el rango de toda vela posterior
 * NO toque la zona [low_zone, high_zone].
 *
 * @param {Array} candles
 * @param {{ windowBars?: number, maxResults?: number }} [opts]
 * @returns {{
 *   bullish: Array<{idx_left, idx_right, t_left, t_right, low, high, size_pct}>,
 *   bearish: Array<{idx_left, idx_right, t_left, t_right, low, high, size_pct}>
 * } | null}
 */
export function detectUnmitigatedFVGs(candles, { windowBars = 100, maxResults = 5 } = {}) {
  if (!candles || candles.length < 3) return null;

  const start = Math.max(2, candles.length - windowBars);
  const bullish = [];
  const bearish = [];

  // El FVG necesita las velas i-2, i-1 (cuerpo intermedio, no se evalúa) y i.
  // El "gap" se mide entre vela `i-2` y vela `i`; la vela `i-1` simplemente
  // marca el momentum que abrió el hueco.
  for (let i = start; i < candles.length; i++) {
    const left  = candles[i - 2];
    const right = candles[i];

    // Bullish FVG: low de la vela actual > high de la vela de hace 2
    if (right.low > left.high) {
      const lowZone  = left.high;
      const highZone = right.low;
      const mitPct = calcMitigationPct(candles, i + 1, lowZone, highZone);
      if (mitPct < 100) {
        bullish.push({
          idx_left:       i - 2,
          idx_right:      i,
          t_left:         left.t,
          t_right:        right.t,
          candles_ago:    candles.length - 1 - i,
          low:            parseFloat(lowZone.toFixed(2)),
          high:           parseFloat(highZone.toFixed(2)),
          size_pct:       parseFloat(((highZone - lowZone) / lowZone * 100).toFixed(3)),
          mitigation_pct: mitPct,
        });
      }
    }

    // Bearish FVG: high actual < low de hace 2
    if (right.high < left.low) {
      const lowZone  = right.high;
      const highZone = left.low;
      const mitPct = calcMitigationPct(candles, i + 1, lowZone, highZone);
      if (mitPct < 100) {
        bearish.push({
          idx_left:       i - 2,
          idx_right:      i,
          t_left:         left.t,
          t_right:        right.t,
          candles_ago:    candles.length - 1 - i,
          low:            parseFloat(lowZone.toFixed(2)),
          high:           parseFloat(highZone.toFixed(2)),
          size_pct:       parseFloat(((highZone - lowZone) / lowZone * 100).toFixed(3)),
          mitigation_pct: mitPct,
        });
      }
    }
  }

  // Más recientes primero, top N
  bullish.reverse();
  bearish.reverse();

  return {
    bullish: bullish.slice(0, maxResults),
    bearish: bearish.slice(0, maxResults),
  };
}

/**
 * Calcula el porcentaje de mitigación de un FVG por velas posteriores.
 * 0 = intacto, 100 = completamente cubierto.
 * Mide cuánto del gap [lowZone, highZone] ha sido solapado acumulativamente.
 * @returns {number} mitigation_pct entre 0 y 100
 */
function calcMitigationPct(candles, fromIdx, lowZone, highZone) {
  const gapSize = highZone - lowZone;
  if (gapSize <= 0) return 100;
  let maxOverlap = 0;
  for (let j = fromIdx; j < candles.length; j++) {
    const c = candles[j];
    const overlapLow  = Math.max(c.low, lowZone);
    const overlapHigh = Math.min(c.high, highZone);
    if (overlapHigh > overlapLow) {
      maxOverlap = Math.max(maxOverlap, overlapHigh - overlapLow);
    }
  }
  return parseFloat(((maxOverlap / gapSize) * 100).toFixed(1));
}

function isMitigated(candles, fromIdx, lowZone, highZone) {
  for (let j = fromIdx; j < candles.length; j++) {
    const c = candles[j];
    // Solapamiento de rangos: si [c.low, c.high] intersecta [lowZone, highZone]
    if (c.low <= highZone && c.high >= lowZone) return true;
  }
  return false;
}

// Umbrales de maxCandlesAgo por TF — alineados con la tabla de decay del SYSTEM_PROMPT v4.
// Señales más antiguas que este umbral se descartan (devuelven null) en vez de
// llegar al LLM como ruido envejecido.
const MAX_CANDLES_AGO_BY_TF = {
  '1h': 18,
  '4h': 12,
  '1D': 9,
  '1W': 6,
};

/**
 * Helper de alto nivel: empaqueta last_bos, last_choch y unmitigated_fvgs en
 * un solo objeto. Devuelve null si no hay datos suficientes para ningún cálculo.
 *
 * Añade `candles_ago` a BOS y CHoCH. Si la ruptura supera el umbral táctico del
 * TF, detectLastBOS/CHoCH devuelven null — así el LLM recibe ausencia de señal
 * en vez de eventos obsoletos. `break_candle_t` se mantiene para referencia absoluta.
 *
 * @param {Array} candles
 * @param {{ lookback?: number, timeframe?: string }} [opts]
 *   timeframe: '1h' | '4h' | '1D' | '1W' — determina maxCandlesAgo.
 *   Sin timeframe → sin límite (comportamiento anterior, compatible con tests).
 */
export function calculateSMC(candles, opts = {}) {
  if (!candles || candles.length < 10) return null;

  const maxCandlesAgo = opts.timeframe
    ? (MAX_CANDLES_AGO_BY_TF[opts.timeframe] ?? Infinity)
    : Infinity;

  const smcOpts = { lookback: opts.lookback ?? 2, maxCandlesAgo };

  const last_bos   = detectLastBOS(candles, smcOpts);
  const last_choch = detectLastCHoCH(candles, smcOpts);
  const fvgs       = detectUnmitigatedFVGs(candles, opts);
  if (!last_bos && !last_choch && !fvgs) return null;

  const addCandlesAgo = (event) => {
    if (!event) return null;
    return { ...event, candles_ago: candles.length - 1 - event.break_candle_idx };
  };

  return {
    last_bos:         addCandlesAgo(last_bos),
    last_choch:       addCandlesAgo(last_choch),
    unmitigated_fvgs: fvgs,
  };
}
