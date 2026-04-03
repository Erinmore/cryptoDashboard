import {
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateStochRSI,
  calculateWaveTrend,
  calculateADX,
  calculateSuperTrend,
  calculateVolumeDelta,
  calculateCVD,
  calculateOBV,
  calculateFibonacci,
  calculateSupportResistance,
  detectRSIDivergence,
  detectMarketRegime,
} from '../utils/indicators.js';

import { RSI_OVERBOUGHT, RSI_OVERSOLD } from '../config/constants.js';

/**
 * Calcula todos los indicadores técnicos para un conjunto de candles.
 * @param {Array} candles  Array de {t, o, h, l, c, v}
 * @param {string} timeframe  '1h' | '4h' | '1D' | '1W'
 * @returns {object}  Objeto con todos los indicadores
 */
export function computeIndicators(candles, timeframe) {
  if (!candles || candles.length < 30) return null;

  const closes = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);

  // ── RSI ──────────────────────────────────────────────────────
  const rsiValue = calculateRSI(closes);
  const rsiDivergence = detectRSIDivergence(closes);
  const rsi = rsiValue !== null ? {
    value: rsiValue,
    signal: rsiValue > RSI_OVERBOUGHT ? 'overbought'
      : rsiValue < RSI_OVERSOLD ? 'oversold'
      : 'healthy',
    divergence: rsiDivergence,
  } : null;

  // ── StochRSI ─────────────────────────────────────────────────
  const stochRsi = calculateStochRSI(closes);

  // ── MACD ─────────────────────────────────────────────────────
  const macd = calculateMACD(closes);

  // ── WaveTrend ────────────────────────────────────────────────
  const waveTrend = calculateWaveTrend(candles);

  // ── ADX + DMI ────────────────────────────────────────────────
  const adx = calculateADX(candles);

  // ── Bollinger Bands ──────────────────────────────────────────
  const bb = calculateBollingerBands(closes);

  // ── SuperTrend ───────────────────────────────────────────────
  const superTrend = calculateSuperTrend(candles);

  // ── Volume Delta ─────────────────────────────────────────────
  const volumeDelta = calculateVolumeDelta(candles);

  // ── CVD ──────────────────────────────────────────────────────
  const cvd = calculateCVD(candles);

  // ── OBV ──────────────────────────────────────────────────────
  const obv = calculateOBV(candles);

  // ── Fibonacci ────────────────────────────────────────────────
  const high = Math.max(...highs);
  const low  = Math.min(...lows);
  const fibonacci = calculateFibonacci(high, low);

  // ── Support & Resistance ─────────────────────────────────────
  const sr = calculateSupportResistance(candles);

  // ── Market Regime ────────────────────────────────────────────
  const regime = detectMarketRegime(candles, closes);

  // ── Trend summary ────────────────────────────────────────────
  const trend = computeTrend({ rsi, macd, adx, superTrend, waveTrend });

  return {
    timeframe,
    trend,
    regime,
    rsi,
    stoch_rsi: stochRsi,
    macd,
    wave_trend: waveTrend,
    adx,
    bollinger_bands: bb,
    super_trend: superTrend,
    volume_delta: volumeDelta,
    cvd,
    obv,
    fibonacci,
    support_resistance: sr,
  };
}

/**
 * Genera un resumen de tendencia combinando varios indicadores.
 */
function computeTrend({ rsi, macd, adx, superTrend, waveTrend }) {
  let bullScore = 0;
  let total = 0;

  if (rsi) {
    total++;
    if (rsi.value > 50) bullScore++;
  }
  if (macd) {
    total++;
    if (macd.histogram > 0) bullScore++;
  }
  if (adx) {
    total++;
    if (adx.trend_direction === 'bullish') bullScore++;
  }
  if (superTrend) {
    total++;
    if (superTrend.trend === 'UP') bullScore++;
  }
  if (waveTrend) {
    total++;
    if (waveTrend.wt1 > 0) bullScore++;
  }

  if (total === 0) return 'neutral';
  const ratio = bullScore / total;
  if (ratio >= 0.8) return 'strongly_bullish';
  if (ratio >= 0.6) return 'bullish';
  if (ratio <= 0.2) return 'strongly_bearish';
  if (ratio <= 0.4) return 'bearish';
  return 'neutral';
}
