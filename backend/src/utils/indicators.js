import {
  RSI_PERIOD, MACD_FAST, MACD_SLOW, MACD_SIGNAL,
  BB_PERIOD, BB_STD_DEV, FIB_LEVELS,
  SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT,
  STOCH_RSI_RSI_PERIOD, STOCH_RSI_STOCH_PERIOD, STOCH_RSI_SMOOTH_K, STOCH_RSI_SMOOTH_D,
  WT_N1, WT_N2, WT_OVERBOUGHT, WT_OVERSOLD,
  ADX_PERIOD, ADX_TRENDING_THRESHOLD, ADX_RANGING_THRESHOLD,
  SUPERTREND_ATR_PERIOD, SUPERTREND_MULTIPLIER, SUPERTREND_ADAPTIVE_EMA,
  REGIME_ATR_MULTIPLIER,
} from '../config/constants.js';
import { bucketByPercentile, rollingSums, quantile } from './percentiles.js';

// ─── RSI (Wilder's smoothing) ─────────────────────────────────────────────────

function rsiFromAvgs(avgGain, avgLoss) {
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

export function calculateRSI(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0 && avgGain === 0) return 50; // precio totalmente flat
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

export function calculateEMA(values, period) {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const emas = [];

  // Seed con SMA de los primeros 'period' valores
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emas.push(seed);

  for (let i = period; i < values.length; i++) {
    emas.push(values[i] * k + emas[emas.length - 1] * (1 - k));
  }

  return emas;
}

// ─── MACD (12/26/9) ──────────────────────────────────────────────────────────

export function calculateMACD(closes, fast = MACD_FAST, slow = MACD_SLOW, signal = MACD_SIGNAL) {
  if (closes.length < slow + signal) return null;

  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);

  const offset = emaFast.length - emaSlow.length;
  const macdLine = emaSlow.map((val, i) => emaFast[i + offset] - val);

  const signalLine = calculateEMA(macdLine, signal);

  const lastMACD = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const histogram = lastMACD - lastSignal;

  // Histograma anterior para determinar aceleración/deceleración
  const prevMACD = macdLine[macdLine.length - 2];
  const prevSignal = signalLine[signalLine.length - 2];
  const prevHistogram = prevMACD !== undefined && prevSignal !== undefined
    ? prevMACD - prevSignal
    : histogram;

  // 4 estados según dirección y aceleración del histograma
  let momentum_state;
  if (histogram >= 0) {
    momentum_state = histogram >= prevHistogram ? 'bullish_accelerating' : 'bullish_decelerating';
  } else {
    momentum_state = histogram <= prevHistogram ? 'bearish_accelerating' : 'bearish_decelerating';
  }

  return {
    value: parseFloat(lastMACD.toFixed(2)),
    signal: parseFloat(lastSignal.toFixed(2)),
    histogram: parseFloat(histogram.toFixed(2)),
    momentum_state,
  };
}

// ─── Bollinger Bands (20/2) ───────────────────────────────────────────────────

export function calculateBollingerBands(closes, period = BB_PERIOD, stdDevMult = BB_STD_DEV) {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mean + stdDevMult * stdDev;
  const lower = mean - stdDevMult * stdDev;
  const current = closes[closes.length - 1];
  const bandWidth = upper - lower;
  const rawPosition = bandWidth > 0 ? (current - lower) / bandWidth : 0.5;
  const position = Math.max(0, Math.min(1, rawPosition)); // Clamp to [0.0, 1.0]

  return {
    upper: parseFloat(upper.toFixed(2)),
    middle: parseFloat(mean.toFixed(2)),
    lower: parseFloat(lower.toFixed(2)),
    width_pct: parseFloat(((bandWidth / mean) * 100).toFixed(2)),
    position: parseFloat(position.toFixed(4)),
    window: period,
    std_dev_mult: stdDevMult,
  };
}

// ─── Volume Delta ─────────────────────────────────────────────────────────────

export function calculateVolumeDelta(candles) {
  if (!candles || candles.length === 0) return null;

  // Ruta rápida: usar taker buy real de Binance si está presente y es finito en TODAS las velas.
  // typeof NaN === 'number', así que comprobamos también Number.isFinite para no aceptar
  // valores corruptos que silenciosamente romperían la suma.
  const hasRealTaker = candles.every(c =>
    Number.isFinite(c.taker_buy_base) &&
    Number.isFinite(c.volume) &&
    c.taker_buy_base >= 0 &&
    c.taker_buy_base <= c.volume
  );

  let totalBuy = 0;
  let totalSell = 0;

  for (const c of candles) {
    if (hasRealTaker) {
      totalBuy += c.taker_buy_base;
      totalSell += c.volume - c.taker_buy_base;
      continue;
    }
    // Fallback heurístico: proporción de movimiento alcista vs bajista
    const range = c.high - c.low;
    if (range === 0) {
      totalBuy += c.volume / 2;
      totalSell += c.volume / 2;
      continue;
    }
    const buyRatio = (c.close - c.low) / range;
    totalBuy += c.volume * buyRatio;
    totalSell += c.volume * (1 - buyRatio);
  }

  const total = totalBuy + totalSell;
  const buyPct = total > 0 ? (totalBuy / total) * 100 : 50;
  const sellPct = 100 - buyPct;

  const last = candles[candles.length - 1];
  let lastBuyRatio;
  if (hasRealTaker && last.volume > 0) {
    lastBuyRatio = last.taker_buy_base / last.volume;
  } else {
    const r = last.high - last.low;
    lastBuyRatio = r > 0 ? (last.close - last.low) / r : 0.5;
  }

  let lastCandleType;
  if (lastBuyRatio > 0.7) lastCandleType = 'strong_bullish';
  else if (lastBuyRatio > 0.5) lastCandleType = 'bullish';
  else if (lastBuyRatio < 0.3) lastCandleType = 'strong_bearish';
  else lastCandleType = 'bearish';

  return {
    buy_pressure_pct: parseFloat(buyPct.toFixed(1)),
    sell_pressure_pct: parseFloat(sellPct.toFixed(1)),
    last_candle_type: lastCandleType,
    anomaly: buyPct > 90 || buyPct < 10,
    source: hasRealTaker ? 'taker_real' : 'heuristic',
  };
}

// ─── Fibonacci ────────────────────────────────────────────────────────────────

export function calculateFibonacci(high, low, levels = FIB_LEVELS) {
  const range = high - low;
  return levels.map(level => ({
    level,
    price: parseFloat((high - range * level).toFixed(2)),
  }));
}

// ─── ATR (Average True Range) ─────────────────────────────────────────────────

/**
 * Serie completa del ATR de Wilder, un valor por vela desde que hay datos suficientes.
 *
 * Existe para poder situar el ATR actual en su propia distribución (detectMarketRegime)
 * sin recalcular el indicador desde cero para cada corte, que era O(n²). `calculateATR`
 * es el último elemento de esta serie, así que ambos no pueden divergir.
 *
 * @returns {Array<{idx:number, atr:number}>} idx = índice en `candles`
 */
export function calculateATRSeries(candles, period = 14) {
  if (candles.length < period + 1) return [];

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  const out = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push({ idx: period, atr });                 // trs[i] corresponde a candles[i+1]
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period; // Wilder smoothing
    out.push({ idx: i + 1, atr });
  }
  return out;
}

export function calculateATR(candles, period = 14) {
  const series = calculateATRSeries(candles, period);
  if (series.length === 0) return null;
  return parseFloat(series[series.length - 1].atr.toFixed(2));
}

// ─── Stochastic RSI ───────────────────────────────────────────────────────────

export function calculateStochRSI(
  closes,
  rsiPeriod = STOCH_RSI_RSI_PERIOD,
  stochPeriod = STOCH_RSI_STOCH_PERIOD,
  smoothK = STOCH_RSI_SMOOTH_K,
  smoothD = STOCH_RSI_SMOOTH_D,
) {
  if (closes.length < rsiPeriod + stochPeriod + smoothK + smoothD) return null;

  // Serie RSI iterativa O(n): recalculamos avgGain/avgLoss con Wilder smoothing
  // en una sola pasada en vez de invocar calculateRSI(slice) por cada vela.
  const rsiSeries = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / rsiPeriod;
  let avgLoss = losses / rsiPeriod;
  // Primer punto RSI corresponde a closes[rsiPeriod]
  rsiSeries.push(rsiFromAvgs(avgGain, avgLoss));
  for (let i = rsiPeriod + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
    avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
    rsiSeries.push(rsiFromAvgs(avgGain, avgLoss));
  }

  if (rsiSeries.length < stochPeriod) return null;

  // Estocástico sobre la serie RSI
  const stochRaw = [];
  for (let i = stochPeriod - 1; i < rsiSeries.length; i++) {
    const window = rsiSeries.slice(i - stochPeriod + 1, i + 1);
    const minRsi = Math.min(...window);
    const maxRsi = Math.max(...window);
    const range = maxRsi - minRsi;
    stochRaw.push(range === 0 ? 50 : ((rsiSeries[i] - minRsi) / range) * 100);
  }

  if (stochRaw.length < smoothK) return null;

  // %K = SMA del estocástico crudo
  const kSeries = [];
  for (let i = smoothK - 1; i < stochRaw.length; i++) {
    kSeries.push(stochRaw.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0) / smoothK);
  }

  if (kSeries.length < smoothD) return null;

  // %D = SMA de %K
  const k = kSeries[kSeries.length - 1];
  const d = kSeries.slice(-smoothD).reduce((a, b) => a + b, 0) / smoothD;
  const prevK = kSeries[kSeries.length - 2] ?? k;
  const prevD = kSeries.length >= smoothD + 1
    ? kSeries.slice(-smoothD - 1, -1).reduce((a, b) => a + b, 0) / smoothD
    : d;

  let signal = 'neutral';
  if (k < 20 && k > prevK && prevK <= prevD) signal = 'oversold_cross_up';
  else if (k > 80 && k < prevK && prevK >= prevD) signal = 'overbought_cross_down';
  else if (k > 80) signal = 'overbought';
  else if (k < 20) signal = 'oversold';

  return {
    k: parseFloat(k.toFixed(2)),
    d: parseFloat(d.toFixed(2)),
    signal,
  };
}

// ─── WaveTrend Oscillator ─────────────────────────────────────────────────────

export function calculateWaveTrend(candles, n1 = WT_N1, n2 = WT_N2) {
  if (candles.length < n1 + n2 + 4) return null;

  const ap = candles.map(c => (c.high + c.low + c.close) / 3);
  const esa = calculateEMA(ap, n1);

  // d = EMA(|ap - esa|, n1) — alineamos ap con esa
  const apAligned = ap.slice(ap.length - esa.length);
  const absDeviation = apAligned.map((v, i) => Math.abs(v - esa[i]));
  const d = calculateEMA(absDeviation, n1);

  // ci = (ap - esa) / (0.015 * d) — alinear todo
  const len = Math.min(esa.length, d.length);
  const esaA = esa.slice(esa.length - len);
  const dA = d.slice(d.length - len);
  const apA = ap.slice(ap.length - len);
  const ci = apA.map((v, i) => {
    const denom = 0.015 * dA[i];
    return denom < 1e-10 ? 0 : (v - esaA[i]) / denom;
  });

  const tci = calculateEMA(ci, n2);
  if (tci.length < 4) return null;

  const wt1 = tci[tci.length - 1];
  const wt1Arr = tci.slice(-4);
  const wt2 = wt1Arr.reduce((a, b) => a + b, 0) / 4;
  const prevWt1 = tci[tci.length - 2];
  const prevWt1Arr = tci.slice(-5, -1);
  const prevWt2 = prevWt1Arr.length === 4
    ? prevWt1Arr.reduce((a, b) => a + b, 0) / 4
    : wt2;

  let signal = 'neutral';
  if (wt1 < WT_OVERSOLD && wt1 > wt2 && prevWt1 <= prevWt2) signal = 'oversold_cross_up';
  else if (wt1 > WT_OVERBOUGHT && wt1 < wt2 && prevWt1 >= prevWt2) signal = 'overbought_cross_down';
  else if (wt1 > WT_OVERBOUGHT) signal = 'overbought';
  else if (wt1 < WT_OVERSOLD) signal = 'oversold';

  return {
    wt1: parseFloat(wt1.toFixed(2)),
    wt2: parseFloat(wt2.toFixed(2)),
    signal,
  };
}

// ─── ADX + DMI ────────────────────────────────────────────────────────────────

/**
 * Núcleo compartido del ADX: recorre las velas una sola vez y devuelve la SERIE de ADX
 * además del estado final de los suavizados. `calculateADX` (escalar público) y
 * `calculateADXSeries` (distribución para el régimen por percentil) salen ambos de aquí,
 * así que no pueden divergir ni hay que recalcular O(n²) para situar el valor actual.
 *
 * @returns {{series:number[], plusDI:number, minusDI:number}|null}
 */
function adxCore(candles, period) {
  if (candles.length < period * 2 + 1) return null;

  const trArr = [], plusDM = [], minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    trArr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothed sums (no medias): mantiene la misma escala en numerador y
  // denominador, así que +DI/-DI quedan correctos como ratio de sumas suavizadas.
  let smTR = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr = [];

  for (let i = period; i < trArr.length; i++) {
    smTR = smTR - smTR / period + trArr[i];
    smPlusDM = smPlusDM - smPlusDM / period + plusDM[i];
    smMinusDM = smMinusDM - smMinusDM / period + minusDM[i];

    const plusDI = smTR > 0 ? (smPlusDM / smTR) * 100 : 0;
    const minusDI = smTR > 0 ? (smMinusDM / smTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    dxArr.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }

  if (dxArr.length < period) return null;

  // ADX = Wilder smoothing del DX. Se guarda cada paso: el último es el ADX actual y el
  // conjunto es la distribución contra la que se mide el régimen.
  const series = [];
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  series.push(adx);
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
    series.push(adx);
  }

  return {
    series,
    plusDI: smTR > 0 ? (smPlusDM / smTR) * 100 : 0,
    minusDI: smTR > 0 ? (smMinusDM / smTR) * 100 : 0,
  };
}

/** Serie histórica de ADX (para situar el valor actual en su propia distribución). */
export function calculateADXSeries(candles, period = ADX_PERIOD) {
  return adxCore(candles, period)?.series ?? [];
}

export function calculateADX(candles, period = ADX_PERIOD) {
  const core = adxCore(candles, period);
  if (!core) return null;

  const adx = core.series[core.series.length - 1];
  const { plusDI, minusDI } = core;

  let regime;
  if (adx >= ADX_TRENDING_THRESHOLD) regime = 'trending';
  else if (adx <= ADX_RANGING_THRESHOLD) regime = 'ranging';
  else regime = 'weak_trend';

  return {
    adx: parseFloat(adx.toFixed(2)),
    plus_di: parseFloat(plusDI.toFixed(2)),
    minus_di: parseFloat(minusDI.toFixed(2)),
    trend_direction: plusDI > minusDI ? 'bullish' : 'bearish',
    regime,
  };
}

// ─── SuperTrend (adaptativo) ──────────────────────────────────────────────────

export function calculateSuperTrend(
  candles,
  atrPeriod = SUPERTREND_ATR_PERIOD,
  multiplier = SUPERTREND_MULTIPLIER,
  adaptiveEmaPeriod = SUPERTREND_ADAPTIVE_EMA,
) {
  if (candles.length < atrPeriod * 2 + 1) return null;

  // ATR serie completa (Wilder)
  const atrSeries = [];
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let atr = trs.slice(0, atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;
  atrSeries.push(atr);
  for (let i = atrPeriod; i < trs.length; i++) {
    atr = (atr * (atrPeriod - 1) + trs[i]) / atrPeriod;
    atrSeries.push(atr);
  }

  // EMA del ATR para multiplicador adaptativo
  const atrEma = calculateEMA(atrSeries, Math.min(adaptiveEmaPeriod, atrSeries.length));
  const currentAtr = atrSeries[atrSeries.length - 1];
  const atrEmaLast = atrEma[atrEma.length - 1];
  const adaptiveMultiplier = atrEmaLast > 0
    ? multiplier * (currentAtr / atrEmaLast)
    : multiplier;

  // SuperTrend canónico con multiplicador adaptativo aplicado a TODA la serie.
  // Antes el adaptive solo se aplicaba a la última vela, lo que producía saltos
  // discontinuos entre la penúltima banda histórica y la final, pudiendo invertir
  // el `trend` artificialmente. Ahora todo el cálculo es consistente.
  const candlesAligned = candles.slice(candles.length - atrSeries.length - 1);
  const mult = adaptiveMultiplier;

  // Inicializar bandas con la primera vela (en vez de 0) para que el "stickiness"
  // funcione desde la iteración 1. Antes upperBand=0/lowerBand=0 hacía trivialmente
  // verdaderas las condiciones de reset en la primera iteración.
  const firstAtr = atrSeries[0];
  const firstMid = (candlesAligned[1].high + candlesAligned[1].low) / 2;
  let upperBand = firstMid + mult * firstAtr;
  let lowerBand = firstMid - mult * firstAtr;
  let trend = candlesAligned[1].close > upperBand ? 1
    : candlesAligned[1].close < lowerBand ? -1 : 1;

  for (let i = 2; i < candlesAligned.length; i++) {
    const atrVal = atrSeries[i - 1];
    const mid = (candlesAligned[i].high + candlesAligned[i].low) / 2;

    const basicUpper = mid + mult * atrVal;
    const basicLower = mid - mult * atrVal;

    upperBand = basicUpper < upperBand || candlesAligned[i - 1].close > upperBand
      ? basicUpper : upperBand;
    lowerBand = basicLower > lowerBand || candlesAligned[i - 1].close < lowerBand
      ? basicLower : lowerBand;

    if (candlesAligned[i].close > upperBand) trend = 1;
    else if (candlesAligned[i].close < lowerBand) trend = -1;
  }

  const supportLevel = trend === 1 ? lowerBand : null;
  const resistanceLevel = trend === -1 ? upperBand : null;

  return {
    trend: trend === 1 ? 'UP' : 'DOWN',
    support: supportLevel !== null ? parseFloat(supportLevel.toFixed(2)) : null,
    resistance: resistanceLevel !== null ? parseFloat(resistanceLevel.toFixed(2)) : null,
    atr: parseFloat(currentAtr.toFixed(8)),
    adaptive_multiplier: parseFloat(adaptiveMultiplier.toFixed(3)),
  };
}

// ─── CVD — Cumulative Volume Delta ───────────────────────────────────────────

export function calculateCVD(candles) {
  if (!candles || candles.length === 0) return null;

  // Mismo guard que calculateVolumeDelta: bloquea NaN y valores fuera de rango.
  const hasRealTaker = candles.every(c =>
    Number.isFinite(c.taker_buy_base) &&
    Number.isFinite(c.volume) &&
    c.taker_buy_base >= 0 &&
    c.taker_buy_base <= c.volume
  );

  let cvd = 0;
  const series = [];

  for (const c of candles) {
    let delta;
    if (hasRealTaker) {
      // delta real: 2*taker_buy_base - volume = taker_buy - taker_sell
      delta = 2 * c.taker_buy_base - c.volume;
    } else {
      const range = c.high - c.low;
      const buyRatio = range > 0 ? (c.close - c.low) / range : 0.5;
      delta = c.volume * (buyRatio * 2 - 1);
    }
    cvd += delta;
    series.push(cvd);
  }

  if (process.env.DEBUG_CVD_OBV === 'true') {
    console.log('[CVD] series.slice(0,3):', series.slice(0, 3));
    console.log('[CVD] series[-3:]:', series.slice(-3));
  }

  const current = series[series.length - 1];
  // Ventana de 20 velas para divergencia (captura desviaciones estructurales, no ruido de 5 barras).
  const DIVERGENCE_WINDOW = 20;
  const windowIdx = Math.max(0, series.length - DIVERGENCE_WINDOW - 1);
  const prev = series[windowIdx];
  const trend = current > prev ? 'rising' : current < prev ? 'falling' : 'flat';

  const prevClose = candles[windowIdx].close;
  const lastClose = candles[candles.length - 1].close;
  const priceChange = lastClose - prevClose;
  // Threshold 0.1% para evitar marcar divergence con ruido de precio mínimo.
  const priceThreshold = Math.abs(prevClose) * 0.001;
  let divergence = 'none';
  if (priceChange > priceThreshold && trend === 'falling') divergence = 'bearish';
  if (priceChange < -priceThreshold && trend === 'rising') divergence = 'bullish';

  const priceChangePct = prevClose !== 0 ? priceChange / prevClose * 100 : 0;

  // CVD es una serie acumulativa con signo: un % sobre Math.abs(prev) explota
  // cuando prev pasó cerca de cero (artefacto de base pequeña, no señal real).
  // Reportamos el delta absoluto de la ventana y su magnitud normalizada por el
  // volumen total de la ventana — interpretable y comparable entre activos.
  const cvdDelta = current - prev;
  let windowVolume = 0;
  for (let i = windowIdx; i < candles.length; i++) windowVolume += candles[i].volume;
  const cvdDeltaVsVolumePct = windowVolume > 0 ? (cvdDelta / windowVolume) * 100 : 0;

  // Delta neto de la ÚLTIMA vela (cantidad estacionaria, independiente del origen de la
  // ventana). `value` es acumulativo desde candles[0]; si la serie proviene de una ventana
  // rodante (p.ej. 90 velas 1D), su base se desplaza cada barra. `last_candle_delta` NO
  // sufre esa deriva y es la primitiva correcta para persistir snapshots diarios y luego
  // reconstruir una serie acumulada con base consistente (ver cvdSummary).
  const lastCandleDelta = series.length >= 2 ? series[series.length - 1] - series[series.length - 2] : series[0];

  // Fuerza AUTO-NORMALIZADA (auditoría de umbrales 2026-07-26, hallazgo T3).
  //
  // Antes se bucketizaba |cvd_delta_vs_volume_pct| con cortes fijos 2 %/8 % iguales para los
  // cuatro TFs. Medido sobre ~830 ventanas por TF y las tres monedas, el corte del 2 % caía
  // en el percentil ~52 del 4h (SOL 52,5 · BTC 53,2 · ETH 50,3) — partía la muestra por la
  // mitad sin discriminar — y el bucket "strong" salía al 0,0 % en 4h, 1D y 1W: rama muerta.
  // El ratio se aplasta al subir de TF porque en ventanas largas el flujo neto se cancela.
  //
  // Ahora el corte sale de la propia serie: se reconstruye la distribución de la MISMA
  // magnitud sobre ventanas rodantes del array disponible y se clasifica por terciles.
  // Con eso el reparto es ~33/33/33 en todo TF y moneda, sin tablas que mantener.
  const deltas = [];
  for (let i = 0; i < series.length; i++) {
    deltas.push(i === 0 ? series[0] : series[i] - series[i - 1]);
  }
  const volumes = candles.map((c) => c.volume);
  const dSums = rollingSums(deltas, DIVERGENCE_WINDOW);
  const vSums = rollingSums(volumes, DIVERGENCE_WINDOW);
  const ratioSample = dSums
    .map((d, i) => (vSums[i] > 0 ? Math.abs(d / vSums[i]) * 100 : null))
    .filter((v) => v != null);

  // Suelo absoluto: por debajo del 0,25 % del volumen de la ventana el desequilibrio es
  // ruido aunque su percentil sea alto. Sin él, un mercado muerto produciría "strong" por
  // ser el tercio superior de casi nada (ver percentiles.js).
  const strength = bucketByPercentile(Math.abs(cvdDeltaVsVolumePct), ratioSample, {
    labels: ['marginal', 'moderate', 'strong'],
    absoluteFloor: 0.25,
  });

  return {
    value: parseFloat(current.toFixed(2)),
    last_candle_delta: parseFloat(lastCandleDelta.toFixed(2)),
    trend,
    divergence,
    divergence_window_candles: Math.min(DIVERGENCE_WINDOW, series.length - 1),
    price_change_pct_window: parseFloat(priceChangePct.toFixed(2)),
    cvd_delta_window: parseFloat(cvdDelta.toFixed(2)),
    cvd_delta_vs_volume_pct: parseFloat(cvdDeltaVsVolumePct.toFixed(2)),
    // Fuerza + su trazabilidad: percentil que ocupa y cortes vigentes en esta serie. Los dos
    // últimos son telemetría — permiten auditar la calibración a posteriori sin re-fetchear.
    cvd_strength: strength.label,
    cvd_strength_pctile: strength.percentile,
    cvd_strength_cuts: strength.cuts,
    source: hasRealTaker ? 'taker_real' : 'heuristic',
  };
}

// ─── VWAP — Volume-Weighted Average Price (rolling 20-period) ──────────────────

export function calculateVWAP(candles, period = 20) {
  if (!candles || candles.length < 2) return null;

  const vwapSeries = [];
  for (let i = 0; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - period + 1), i + 1);
    let tpv = 0, vol = 0;
    for (const c of slice) {
      const tp = (c.high + c.low + c.close) / 3;
      tpv += tp * c.volume;
      vol += c.volume;
    }
    vwapSeries.push(vol > 0 ? tpv / vol : candles[i].close);
  }

  const n = vwapSeries.length;
  const prevIndex = Math.max(0, n - 7);  // 6 velas atrás reales (n-1=actual, n-7=6 atrás)
  const currentVwap = vwapSeries[n - 1];
  const prevVwap = vwapSeries[prevIndex];
  const threshold = prevVwap * 0.001;   // 0.1%
  const trend = currentVwap > prevVwap + threshold ? 'rising'
              : currentVwap < prevVwap - threshold ? 'falling'
              : 'flat';

  // Divergence based on price-VWAP distance (with noise threshold)
  const closeCurrent = candles[n - 1].close;
  const closePrev = candles[prevIndex].close;
  const priceChange = closeCurrent - closePrev;
  const distNow = (closeCurrent - currentVwap) / currentVwap;
  const distPrev = (closePrev - prevVwap) / prevVwap;
  const distThreshold = 0.001;  // 0.1% — evitar divergencias falsas por ruido

  let divergence = 'none';
  if (priceChange > 0 && distNow < distPrev - distThreshold) divergence = 'bearish';
  if (priceChange < 0 && distNow > distPrev + distThreshold) divergence = 'bullish';

  return {
    value: parseFloat(currentVwap.toFixed(2)),
    trend,
    divergence,
  };
}

// ─── RSI Divergence ───────────────────────────────────────────────────────────

export function detectRSIDivergence(closes, rsiPeriod = RSI_PERIOD, lookback = 20) {
  if (closes.length < rsiPeriod + lookback) return 'none';

  // Serie RSI iterativa O(n) — ver calculateStochRSI para la misma técnica.
  const rsiSeries = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / rsiPeriod;
  let avgLoss = losses / rsiPeriod;
  rsiSeries.push(rsiFromAvgs(avgGain, avgLoss));
  for (let i = rsiPeriod + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
    avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
    rsiSeries.push(rsiFromAvgs(avgGain, avgLoss));
  }

  const priceSlice = closes.slice(-lookback);
  const rsiSlice = rsiSeries.slice(-lookback);

  // Pivot fractal lookback=2 (pivote de 5 velas) — alineado con SMC, reduce
  // falsos positivos vs el pivot de 3 velas en mercados con ruido.
  const PIVOT_LB = 2;
  const priceHighs = [], priceLows = [], rsiHighs = [], rsiLows = [];
  for (let i = PIVOT_LB; i < priceSlice.length - PIVOT_LB; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= PIVOT_LB; j++) {
      if (priceSlice[i - j] >= priceSlice[i] || priceSlice[i + j] >= priceSlice[i]) isHigh = false;
      if (priceSlice[i - j] <= priceSlice[i] || priceSlice[i + j] <= priceSlice[i]) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) {
      priceHighs.push({ i, v: priceSlice[i] });
      rsiHighs.push({ i, v: rsiSlice[i] });
    }
    if (isLow) {
      priceLows.push({ i, v: priceSlice[i] });
      rsiLows.push({ i, v: rsiSlice[i] });
    }
  }

  // Divergencia bearish: precio hace higher high pero RSI hace lower high
  if (priceHighs.length >= 2 && rsiHighs.length >= 2) {
    const p1 = priceHighs[priceHighs.length - 2], p2 = priceHighs[priceHighs.length - 1];
    const r1 = rsiHighs[rsiHighs.length - 2], r2 = rsiHighs[rsiHighs.length - 1];
    if (p2.v > p1.v && r2.v < r1.v) return 'bearish';
  }

  // Divergencia bullish: precio hace lower low pero RSI hace higher low
  if (priceLows.length >= 2 && rsiLows.length >= 2) {
    const p1 = priceLows[priceLows.length - 2], p2 = priceLows[priceLows.length - 1];
    const r1 = rsiLows[rsiLows.length - 2], r2 = rsiLows[rsiLows.length - 1];
    if (p2.v < p1.v && r2.v > r1.v) return 'bullish';
  }

  return 'none';
}

// ─── Market Regime ────────────────────────────────────────────────────────────

export function detectMarketRegime(candles, closes) {
  if (candles.length < 30 || closes.length < 30) return 'unknown';

  const adxResult = calculateADX(candles);
  const bbResult = calculateBollingerBands(closes);
  const atrCurrent = calculateATR(candles);

  if (!adxResult || !bbResult || !atrCurrent) return 'unknown';

  // ATR histórico (últimas 20 velas) para detectar alta volatilidad
  const recentCandles = candles.slice(-20);
  const atrValues = recentCandles.slice(1).map((c, i) => {
    const prev = recentCandles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const atrSma = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;

  // ── Volatilidad: percentil del ATR% contra su propia historia ──────────────
  //
  // Antes: `atrCurrent > atrSma * REGIME_ATR_MULTIPLIER` (multiplicador 2). Medido en la
  // auditoría de umbrales (T1), `high_volatility` salía al 0,0 % en las DOCE combinaciones
  // moneda × TF, sobre ~9.000 ventanas: rama muerta. Y no por un umbral alto, sino por un
  // error de planteamiento — el ATR de Wilder es él mismo una media suavizada, así que está
  // autocorrelacionado con su propia SMA(20) y el cociente no llega a despegarse de 1.
  //
  // Ahora se compara el ATR% actual contra la distribución del ATR% de la propia ventana:
  // "alta volatilidad" = decil superior de lo que este activo hace en este TF. Definición
  // relativa y honesta, y no depende de la escala del activo.
  const atrPctSeries = [];
  for (let i = ADX_PERIOD + 1; i < candles.length; i++) {
    const a = calculateATR(candles.slice(0, i + 1));
    const c = candles[i].close;
    if (a !== null && c > 0) atrPctSeries.push(a / c * 100);
  }
  const lastClose = candles[candles.length - 1].close;
  const atrPctNow = lastClose > 0 ? atrCurrent / lastClose * 100 : null;
  const volCut = quantile(atrPctSeries, 0.90);
  const volMedian = quantile(atrPctSeries, 0.50);
  // DOS condiciones, no una. El percentil solo no basta: en un mercado plano el decil
  // superior sigue siendo casi-nada y se etiquetaría como "alta volatilidad" por pura
  // posición relativa (lo destapó el test de mercado lateral sintético). Se exige además
  // un salto REAL sobre la mediana — expansión de al menos 1,5×. Es un criterio de escala
  // libre: no fija un ATR% absoluto, que dependería del activo.
  const VOL_EXPANSION_MULT = 1.5;
  if (atrPctNow != null && volCut != null && volMedian > 0 && atrPctSeries.length >= 20
      && atrPctNow >= volCut && atrPctNow >= volMedian * VOL_EXPANSION_MULT) {
    return 'high_volatility';
  }

  // ── Tendencia: percentil del ADX, con los cortes clásicos como suelo ───────
  //
  // Los cortes 25/20 de Wilder caían en el percentil ~50 (T2): "trending" era una moneda al
  // aire, y eso decide si computeTrend pondera ADX o no. Se pasa a terciles de la propia
  // distribución, PERO conservando el criterio absoluto como suelo: un ADX de 12 no es
  // tendencia por muy alto que quede respecto a una racha plana. Así el campo discrimina
  // sin dejar de significar lo que significa en cualquier manual.
  const adxSeries = [];
  for (let i = ADX_PERIOD * 2; i < candles.length; i++) {
    const r = calculateADX(candles.slice(0, i + 1));
    if (r && Number.isFinite(r.adx)) adxSeries.push(r.adx);
  }
  const bucket = bucketByPercentile(adxResult.adx, adxSeries, {
    labels: ['ranging', 'weak_trend', 'trending'],
    absoluteFloor: ADX_RANGING_THRESHOLD,
  });
  if (bucket.label === 'trending' && adxResult.adx < ADX_RANGING_THRESHOLD) return 'weak_trend';
  return bucket.label
    ?? (adxResult.adx >= ADX_TRENDING_THRESHOLD ? 'trending'
      : adxResult.adx <= ADX_RANGING_THRESHOLD ? 'ranging' : 'weak_trend');
}

// ─── Support & Resistance ─────────────────────────────────────────────────────

/**
 * Pivotes fractales: máximos/mínimos locales estrictos con `lb` velas a cada lado.
 * Mismo criterio que `detectSwings` de smc.js (lookback=2), replicado aquí para no crear
 * una dependencia circular entre utils.
 */
function pivotPrices(candles, lb = 2) {
  const out = [];
  for (let i = lb; i < candles.length - lb; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push(candles[i].high);
    if (isLow) out.push(candles[i].low);
  }
  return out;
}

/**
 * Soportes y resistencias por clustering de PIVOTES.
 *
 * Reescrito en la auditoría de umbrales (2026-07-26, hallazgo T4). La versión anterior tenía
 * dos defectos que se reforzaban entre sí y hacían que `touches` no midiera lo que su nombre
 * promete:
 *
 *  1. Alimentaba el `high` Y el `low` de TODAS las velas, sin filtrar. No eran pivotes: eran
 *     los extremos de cada barra. En una ventana de 50 velas son 100 precios repartidos por
 *     el rango, así que cualquier banda del 0,5 % recogía 10-20 por pura densidad. `touches`
 *     acababa midiendo TIEMPO DE PERMANENCIA en la banda, no rechazos del nivel.
 *  2. El cluster se re-centraba con media incremental sobre precios ordenados ascendentemente,
 *     así que el ancla derivaba hacia arriba y admitía precios cada vez más lejos del origen
 *     (encadenamiento). Medido: 100 candidatos colapsaban en 8 clusters y el 88 % de ellos
 *     excedían su propia tolerancia, hasta ×2,2.
 *
 * Consecuencia: el 89-92 % de los niveles superaban el filtro de "3+ toques" en 4h — el
 * criterio de "nivel fuerte" del veto no seleccionaba nada. Ahora se agrupan solo pivotes
 * fractales, con ancla FIJA (sin deriva), sobre una ventana más larga que compensa que los
 * pivotes sean más escasos. Con eso "3+ toques" pasa a seleccionar el ~12 % superior.
 */
export function calculateSupportResistance(candles, lookback = SR_LOOKBACK, minTouches = SR_MIN_TOUCHES, tolerancePct = SR_TOLERANCE_PCT) {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return { supports: [], resistances: [] };

  // Solo pivotes: un "toque" pasa a ser un rechazo local real, no una vela cualquiera
  // cuyo extremo cayó dentro de la banda.
  const levels = pivotPrices(slice).sort((a, b) => a - b);

  const grouped = [];
  for (const price of levels) {
    // Ancla FIJA: la pertenencia se mide siempre contra el primer precio del cluster, así
    // que su anchura total no puede superar la tolerancia. Con media móvil el cluster
    // "caminaba" y encadenaba precios arbitrariamente lejanos.
    const existing = grouped.find(g =>
      Math.abs(g.anchor - price) / g.anchor <= tolerancePct
    );
    if (existing) {
      existing.touches++;
      existing.sum += price;
    } else {
      grouped.push({ anchor: price, sum: price, touches: 1 });
    }
  }
  // El precio representativo es la media de sus miembros; el ancla solo define pertenencia.
  for (const g of grouped) g.price = g.sum / g.touches;

  const currentPrice = slice[slice.length - 1].close;

  // Reclasificar por posición real respecto al precio actual: un cluster de highs
  // que tras promediar quedó por debajo del precio se considera soporte. Antes se
  // descartaba silenciosamente.
  const filtered = grouped
    .filter(g => g.touches >= minTouches)
    .map(g => ({
      price: g.price,
      touches: g.touches,
      strength: Math.min(Math.floor(g.touches / 2), 5),
    }));

  const supports = filtered
    .filter(g => g.price < currentPrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);

  const resistances = filtered
    .filter(g => g.price >= currentPrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);

  return { supports, resistances };
}
