import {
  calculateRSI,
  calculateATR,
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
import { RSI_OVERBOUGHT, RSI_OVERSOLD, VOLUME_PROFILE_VALID_THRESHOLD_PCT, TIMEFRAME_MINUTES } from '../config/constants.js';

/** Fuerza del desequilibrio CVD según |cvd_delta_vs_volume_pct| (regla del prompt). */
function cvdStrength(pct) {
  if (pct == null) return null;
  const a = Math.abs(pct);
  if (a < 2) return 'marginal';
  if (a <= 8) return 'moderate';
  return 'strong';
}

/** Lado del precio respecto a un nivel: 'above' / 'below' / 'at' (dentro de 0.05%). */
function priceSide(price, level) {
  if (price == null || level == null) return null;
  const diffPct = ((price - level) / level) * 100;
  if (diffPct > 0.05) return 'above';
  if (diffPct < -0.05) return 'below';
  return 'at';
}

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

  // Precio de referencia (último cierre) — usado por varios flags precalculados.
  const currentPrice = closes[closes.length - 1];

  // ── CVD ──────────────────────────────────────────────────────
  // divergence_window_candles no es comparable directamente entre TFs (20 velas
  // de 1h ≈ 20h, 20 velas de 1W ≈ 140 días) — se añade el equivalente en minutos.
  // cvd_strength precalcula la fuerza del desequilibrio (antes el LLM bucketizaba
  // cvd_delta_vs_volume_pct a mano): <2% marginal, 2-8% moderate, >8% strong.
  const cvdRaw = calculateCVD(candles);
  const cvd = cvdRaw ? {
    ...cvdRaw,
    divergence_window_minutes: cvdRaw.divergence_window_candles * TIMEFRAME_MINUTES[timeframe],
    cvd_strength: cvdStrength(cvdRaw.cvd_delta_vs_volume_pct),
  } : null;

  // ── VWAP ─────────────────────────────────────────────────────
  // price_vs_vwap precalculado (above/below/at) — antes el LLM comparaba precio y VWAP.
  const vwapRaw = calculateVWAP(candles);
  const vwap = vwapRaw ? {
    ...vwapRaw,
    price_vs_vwap: priceSide(currentPrice, vwapRaw.value),
  } : null;

  // ── Fibonacci ────────────────────────────────────────────────
  const high = Math.max(...highs);
  const low  = Math.min(...lows);
  const highIdx = highs.indexOf(high);
  const lowIdx  = lows.indexOf(low);
  const fibLevels = calculateFibonacci(high, low);
  const fibonacci = {
    swing_high: high,
    swing_low: low,
    swing_high_date: candles[highIdx]?.t ? new Date(candles[highIdx].t).toISOString().split('T')[0] : null,
    swing_low_date:  candles[lowIdx]?.t  ? new Date(candles[lowIdx].t).toISOString().split('T')[0] : null,
    type: 'retracement',
    levels: fibLevels,
  };

  // ── Support & Resistance ─────────────────────────────────────
  const sr = calculateSupportResistance(candles);

  // ── Volume Profile ───────────────────────────────────────────
  const vpRaw = calculateVolumeProfile(candles);
  let volumeProfile = vpRaw;
  if (vpRaw && currentPrice) {
    const pocDistPct = Math.abs((vpRaw.poc - currentPrice) / currentPrice * 100);
    const vpValid = pocDistPct <= VOLUME_PROFILE_VALID_THRESHOLD_PCT[timeframe];
    volumeProfile = {
      ...vpRaw,
      poc_distance_pct: parseFloat(pocDistPct.toFixed(2)),
      valid: vpValid,
      invalid_reason: vpValid ? null : 'poc_distance_pct_exceeds_threshold',
      // Flags precalculados (antes el LLM comparaba precio vs POC/VAH/VAL a mano):
      price_vs_poc: priceSide(currentPrice, vpRaw.poc),
      // Excursión: precio >2% por encima del VAH (alcista) o >2% por debajo del VAL (bajista).
      excursion: vpRaw.vah != null && currentPrice > vpRaw.vah * 1.02 ? 'above_vah'
               : vpRaw.val != null && currentPrice < vpRaw.val * 0.98 ? 'below_val'
               : null,
    };
  }

  // ── SMC: BOS / CHoCH / FVG ───────────────────────────────────
  const smc = calculateSMC(candles, { timeframe });

  // Anotar validez del BOS según si el precio actual ha retrocedido por debajo del nivel roto.
  if (smc?.last_bos && currentPrice) {
    const bos = smc.last_bos;
    const retracedBelow = bos.direction === 'bullish'
      ? currentPrice < bos.broken_swing_price
      : currentPrice > bos.broken_swing_price;
    bos.valid = !retracedBelow;
    bos.invalid_reason = retracedBelow ? 'price_retraced_below_broken_level' : null;
    bos.retracement_pct = retracedBelow
      ? parseFloat(((currentPrice - bos.broken_swing_price) / bos.broken_swing_price * 100).toFixed(2))
      : null;
  }

  // ── ATR (volatilidad realizada del TF) ───────────────────────
  // Auditoría #2 (hallazgos 7/14/16): expone la volatilidad del TF para (a) normalizar
  // el umbral de cercanía a niveles del gating (antes 1.5% fijo para BTC y SOL por igual)
  // y (b) dar un proxy de régimen de volatilidad a activos sin DVOL (SOL).
  const atrValue = calculateATR(candles);
  const atr = atrValue !== null ? {
    value: atrValue,
    pct: currentPrice ? parseFloat((atrValue / currentPrice * 100).toFixed(2)) : null,
    period: 14,
  } : null;

  // ── Market Regime ────────────────────────────────────────────
  const regime = detectMarketRegime(candles, closes);

  // ── Trend summary ────────────────────────────────────────────
  const trend = computeTrend({ rsi, macd, adx, superTrend, waveTrend, stochRsi, volumeDelta });

  // momentum_alignment: true si el computeTrend (momentum) coincide con la tendencia estructural de precio.
  const momentumAlignedWithTrend = (() => {
    if (!trend || !superTrend) return null;
    const trendBullish = trend === 'bullish' || trend === 'strongly_bullish';
    const trendBearish = trend === 'bearish' || trend === 'strongly_bearish';
    const stBullish = superTrend.trend === 'UP';
    if (trendBullish && stBullish) return true;
    if (trendBearish && !stBullish) return true;
    if (trend === 'neutral') return null;
    return false;
  })();

  return {
    timeframe,
    trend,
    trend_basis: 'ema_cross_swing',
    momentum_alignment: momentumAlignedWithTrend,
    regime,
    rsi,
    stoch_rsi: stochRsi,
    macd,
    wave_trend: waveTrend,
    adx,
    atr,
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
 * Signo con zona muerta: +1 si diff>band, -1 si diff<-band, 0 en la banda [-band, band].
 * Evita que una diferencia marginal vuelque un ±1 completo (H5). Función pura.
 * @param {number} diff
 * @param {number} band - semi-ancho de la zona muerta (>=0)
 * @returns {number} -1 | 0 | 1
 */
export function signWithDeadband(diff, band) {
  if (!Number.isFinite(diff)) return 0;
  if (diff > band) return 1;
  if (diff < -band) return -1;
  return 0;
}

/**
 * Resumen de tendencia ponderado por jerarquía del SYSTEM_PROMPT:
 *   estructura (50%) > ejecución (30%) > volumen local (20%).
 * Derivados y on-chain son macro y se incorporan al payload fuera del bloque technical.
 */
export function computeTrend({ rsi, macd, adx, superTrend, waveTrend, stochRsi, volumeDelta }) {
  // Estructura: ADX trend_direction + SuperTrend.
  // En ranging el trend_direction es ruido estadístico (DI+ vs DI- por diferencia
  // mínima), así que ADX no contribuye al score estructural — sólo cuenta cuando
  // hay tendencia (trending o weak_trend).
  let structureScore = 0, structureCount = 0;
  if (adx && adx.regime !== 'ranging') {
    structureScore += adx.trend_direction === 'bullish' ? 1 : -1;
    structureCount++;
  }
  if (superTrend) {
    structureScore += superTrend.trend === 'UP' ? 1 : -1;
    structureCount++;
  }
  const structure = structureCount > 0 ? structureScore / structureCount : 0;

  // Ejecución: RSI, MACD histogram, WaveTrend, StochRSI.
  // H5 (auditoría) · DEAD-BANDS: los cruces binarios (histogram>0, wt1>wt2, k>d) sin zona
  // muerta volcaban un ±1 completo ante diferencias sub-tick → la etiqueta parpadeaba con
  // ruido. Ahora una diferencia marginal cuenta como 0 (neutral). Nota: esto amortigua el
  // flicker de borde; una histéresis temporal real exigiría estado por-TF que la arquitectura
  // de render-bajo-demanda no arrastra — el dead-band es el arreglo sin estado equivalente.
  let execScore = 0, execCount = 0;
  if (rsi) {
    execScore += rsi.value > 55 ? 1 : rsi.value < 45 ? -1 : 0; // RSI ya tenía dead-band 45–55
    execCount++;
  }
  if (macd) {
    // Dead-band relativo a la escala de la MACD (2% de max(|macd|,|signal|)) → invariante
    // a la escala del activo. Si faltan value/signal, band≈0 y degrada al signo (como antes).
    const scale = Math.max(Math.abs(macd.value ?? 0), Math.abs(macd.signal ?? 0), 1e-9);
    execScore += signWithDeadband(macd.histogram, 0.02 * scale);
    execCount++;
  }
  if (waveTrend) {
    execScore += signWithDeadband(waveTrend.wt1 - waveTrend.wt2, 2); // WT oscila ~±60
    execCount++;
  }
  if (stochRsi) {
    execScore += signWithDeadband(stochRsi.k - stochRsi.d, 3); // StochRSI 0–100
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
