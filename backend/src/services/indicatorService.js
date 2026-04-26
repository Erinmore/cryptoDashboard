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
  calculateVWAP,
  calculateFibonacci,
  calculateSupportResistance,
  detectRSIDivergence,
  detectMarketRegime,
} from '../utils/indicators.js';

import { calculateVolumeProfile } from '../utils/volumeProfile.js';
import { calculateSMC } from '../utils/smc.js';
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

  // ── VWAP ─────────────────────────────────────────────────────
  const vwap = calculateVWAP(candles);

  // ── Fibonacci ────────────────────────────────────────────────
  const high = Math.max(...highs);
  const low  = Math.min(...lows);
  const fibonacci = calculateFibonacci(high, low);

  // ── Support & Resistance ─────────────────────────────────────
  const sr = calculateSupportResistance(candles);

  // ── Volume Profile ───────────────────────────────────────────
  const volumeProfile = calculateVolumeProfile(candles);

  // ── SMC: BOS / CHoCH / FVG ───────────────────────────────────
  const smc = calculateSMC(candles, { timeframe });

  // ── Market Regime ────────────────────────────────────────────
  const regime = detectMarketRegime(candles, closes);

  // ── Trend summary ────────────────────────────────────────────
  const trend = computeTrend({ rsi, macd, adx, superTrend, waveTrend, stochRsi, volumeDelta });

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
    vwap,
    fibonacci,
    support_resistance: sr,
    volume_profile: volumeProfile,
    smc,
  };
}

/**
 * Resumen de tendencia ponderado por jerarquía del SYSTEM_PROMPT:
 *   estructura (50%) > ejecución (30%) > volumen local (20%).
 * Derivados y on-chain son macro y se incorporan al payload fuera del bloque technical.
 */
export function computeTrend({ rsi, macd, adx, superTrend, waveTrend, stochRsi, volumeDelta }) {
  // Estructura: ADX trend_direction + SuperTrend
  let structureScore = 0, structureCount = 0;
  if (adx) {
    structureScore += adx.trend_direction === 'bullish' ? 1 : -1;
    structureCount++;
  }
  if (superTrend) {
    structureScore += superTrend.trend === 'UP' ? 1 : -1;
    structureCount++;
  }
  const structure = structureCount > 0 ? structureScore / structureCount : 0;

  // Ejecución: RSI, MACD histogram, WaveTrend, StochRSI
  let execScore = 0, execCount = 0;
  if (rsi) {
    execScore += rsi.value > 55 ? 1 : rsi.value < 45 ? -1 : 0;
    execCount++;
  }
  if (macd) {
    execScore += macd.histogram > 0 ? 1 : -1;
    execCount++;
  }
  if (waveTrend) {
    execScore += waveTrend.wt1 > waveTrend.wt2 ? 1 : -1;
    execCount++;
  }
  if (stochRsi) {
    execScore += stochRsi.k > stochRsi.d ? 1 : -1;
    execCount++;
  }
  const execution = execCount > 0 ? execScore / execCount : 0;

  // Volumen local: buy_pressure_pct normalizado a [-1, +1]
  let volume = 0;
  if (volumeDelta) {
    volume = (volumeDelta.buy_pressure_pct - 50) / 50;
  }

  if (structureCount === 0 && execCount === 0 && !volumeDelta) return 'neutral';

  const bias = structure * 0.5 + execution * 0.3 + volume * 0.2;

  if (bias >= 0.6) return 'strongly_bullish';
  if (bias >= 0.2) return 'bullish';
  if (bias <= -0.6) return 'strongly_bearish';
  if (bias <= -0.2) return 'bearish';
  return 'neutral';
}
