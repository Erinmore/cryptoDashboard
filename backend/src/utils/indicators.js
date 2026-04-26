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

// ─── RSI (Wilder's smoothing) ─────────────────────────────────────────────────

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
    value: parseFloat(lastMACD.toFixed(8)),
    signal: parseFloat(lastSignal.toFixed(8)),
    histogram: parseFloat(histogram.toFixed(8)),
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
  };
}

// ─── Volume Delta ─────────────────────────────────────────────────────────────

export function calculateVolumeDelta(candles) {
  if (!candles || candles.length === 0) return null;

  // Ruta rápida: usar taker buy real de Binance si está presente en TODAS las velas.
  const hasRealTaker = candles.every(c => typeof c.taker_buy_base === 'number');

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

export function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // Wilder smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return parseFloat(atr.toFixed(8));
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

  // Calcular serie completa de RSI (un valor por cada vela desde rsiPeriod+1)
  const rsiSeries = [];
  for (let end = rsiPeriod + 1; end <= closes.length; end++) {
    rsiSeries.push(calculateRSI(closes.slice(0, end), rsiPeriod));
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

export function calculateADX(candles, period = ADX_PERIOD) {
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

  // Wilder smoothing inicial
  let atr = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr = [];

  for (let i = period; i < trArr.length; i++) {
    atr = atr - atr / period + trArr[i];
    smPlusDM = smPlusDM - smPlusDM / period + plusDM[i];
    smMinusDM = smMinusDM - smMinusDM / period + minusDM[i];

    const plusDI = atr > 0 ? (smPlusDM / atr) * 100 : 0;
    const minusDI = atr > 0 ? (smMinusDM / atr) * 100 : 0;
    const diSum = plusDI + minusDI;
    dxArr.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }

  if (dxArr.length < period) return null;

  // ADX = Wilder smoothing del DX
  let adx = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }

  // +DI y -DI finales (última iteración)
  const lastAtr = atr;
  const plusDI = lastAtr > 0 ? (smPlusDM / lastAtr) * 100 : 0;
  const minusDI = lastAtr > 0 ? (smMinusDM / lastAtr) * 100 : 0;

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

  // Calcular SuperTrend con el multiplicador adaptativo
  const candlesAligned = candles.slice(candles.length - atrSeries.length - 1);
  let upperBand = 0, lowerBand = 0, trend = 1; // 1=UP, -1=DOWN

  for (let i = 1; i < candlesAligned.length; i++) {
    const atrVal = atrSeries[i - 1];
    const mid = (candlesAligned[i].high + candlesAligned[i].low) / 2;
    const mult = i === candlesAligned.length - 1 ? adaptiveMultiplier : multiplier;

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

  const hasRealTaker = candles.every(c => typeof c.taker_buy_base === 'number');

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
  const prev = series[Math.max(0, series.length - 6)]; // ventana 5 velas
  const trend = current > prev ? 'rising' : current < prev ? 'falling' : 'flat';

  const priceChange = candles[candles.length - 1].close - candles[Math.max(0, candles.length - 6)].close;
  let divergence = 'none';
  if (priceChange > 0 && trend === 'falling') divergence = 'bearish';
  if (priceChange < 0 && trend === 'rising') divergence = 'bullish';

  return {
    value: parseFloat(current.toFixed(4)),
    trend,
    divergence,
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
    value: parseFloat(currentVwap.toFixed(4)),
    trend,
    divergence,
  };
}

// ─── RSI Divergence ───────────────────────────────────────────────────────────

export function detectRSIDivergence(closes, rsiPeriod = RSI_PERIOD, lookback = 20) {
  if (closes.length < rsiPeriod + lookback) return 'none';

  // Serie RSI completa
  const rsiSeries = [];
  for (let end = rsiPeriod + 1; end <= closes.length; end++) {
    rsiSeries.push(calculateRSI(closes.slice(0, end), rsiPeriod));
  }

  const priceSlice = closes.slice(-lookback);
  const rsiSlice = rsiSeries.slice(-lookback);

  // Detectar pivots simples (valor mayor/menor que sus vecinos inmediatos)
  const priceHighs = [], priceLows = [], rsiHighs = [], rsiLows = [];
  for (let i = 1; i < priceSlice.length - 1; i++) {
    if (priceSlice[i] > priceSlice[i - 1] && priceSlice[i] > priceSlice[i + 1]) {
      priceHighs.push({ i, v: priceSlice[i] });
      rsiHighs.push({ i, v: rsiSlice[i] });
    }
    if (priceSlice[i] < priceSlice[i - 1] && priceSlice[i] < priceSlice[i + 1]) {
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

  if (atrCurrent > atrSma * REGIME_ATR_MULTIPLIER) return 'high_volatility';
  if (adxResult.adx >= ADX_TRENDING_THRESHOLD) return 'trending';
  if (adxResult.adx <= ADX_RANGING_THRESHOLD) return 'ranging';
  return 'weak_trend';
}

// ─── Support & Resistance ─────────────────────────────────────────────────────

export function calculateSupportResistance(candles, lookback = SR_LOOKBACK, minTouches = SR_MIN_TOUCHES, tolerancePct = SR_TOLERANCE_PCT) {
  const slice = candles.slice(-lookback);
  const levels = [];

  // Recogemos highs y lows como candidatos
  for (const candle of slice) {
    levels.push({ price: candle.high, isResistance: true });
    levels.push({ price: candle.low, isResistance: false });
  }

  // Agrupamos niveles cercanos (dentro de tolerance)
  const grouped = [];
  for (const candidate of levels) {
    const existing = grouped.find(g =>
      Math.abs(g.price - candidate.price) / g.price <= tolerancePct
    );
    if (existing) {
      existing.touches++;
      existing.price = (existing.price + candidate.price) / 2; // promedio
    } else {
      grouped.push({ price: candidate.price, isResistance: candidate.isResistance, touches: 1, strength: 1 });
    }
  }

  // Filtrar por mínimo de toques y calcular fuerza
  const filtered = grouped
    .filter(g => g.touches >= minTouches)
    .map(g => ({ ...g, strength: Math.min(Math.floor(g.touches / 2), 5) }));

  const currentPrice = slice[slice.length - 1].close;

  const supports = filtered
    .filter(g => !g.isResistance && g.price < currentPrice)
    .sort((a, b) => b.price - a.price)
    .map(g => ({ price: g.price, touches: g.touches, strength: g.strength }))
    .slice(0, 3);

  const resistances = filtered
    .filter(g => g.isResistance && g.price >= currentPrice)
    .sort((a, b) => a.price - b.price)
    .map(g => ({ price: g.price, touches: g.touches, strength: g.strength }))
    .slice(0, 3);

  return { supports, resistances };
}
