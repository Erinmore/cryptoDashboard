import {
  calculateRSI,
  calculateATR,
  calculateATRSeries,
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

import { percentileRank } from '../utils/percentiles.js';
import { calculateVolumeProfile } from '../utils/volumeProfile.js';
import { calculateSMC } from '../utils/smc.js';
import {
  RSI_OVERBOUGHT, RSI_OVERSOLD, VOLUME_PROFILE_VALID_THRESHOLD_PCT, TIMEFRAME_MINUTES,
  SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT, SR_TOLERANCE_ATR_MULT,
} from '../config/constants.js';

// `cvdStrength` vivía aquí con cortes fijos 2 %/8 %. Se retiró en la auditoría de umbrales
// (2026-07-26, T3): el corte caía sobre la mediana del 4h y dejaba "strong" vacío por encima
// de 1h. Ahora la etiqueta la calcula `calculateCVD` por percentiles de la propia serie.

/**
 * Lado del precio respecto a un nivel: 'above' / 'below' / 'at'.
 *
 * La banda neutral se expresa en fracción del ATR% del TF, no en un 0,05 % fijo: medido en la
 * auditoría (T6), con el corte fijo el estado 'at' salía al 0,0-2,5 % según TF — el campo era
 * binario de facto y la frontera, arbitraria. Un cuarto del ATR es una banda comparable entre
 * TFs y activos. Sin ATR se cae al 0,05 % de antes.
 */
function priceSide(price, level, atrPct = null) {
  if (price == null || level == null) return null;
  const band = Number.isFinite(atrPct) && atrPct > 0 ? atrPct * 0.25 : 0.05;
  const diffPct = ((price - level) / level) * 100;
  if (diffPct > band) return 'above';
  if (diffPct < -band) return 'below';
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

  // ── ATR (volatilidad realizada del TF) ───────────────────────
  // Auditoría #2 (hallazgos 7/14/16): expone la volatilidad del TF para (a) normalizar
  // el umbral de cercanía a niveles del gating (antes 1.5% fijo para BTC y SOL por igual)
  // y (b) dar un proxy de régimen de volatilidad a activos sin DVOL (SOL).
  // Se calcula ANTES que CVD/VWAP/VolumeProfile porque `priceSide` lo usa para dimensionar
  // su banda neutral (auditoría de umbrales T6).
  const atrValue = calculateATR(candles);
  // `pct_percentile`: posición del ATR% actual dentro de SU PROPIA ventana (telemetría de
  // calibración, 2026-08-01). Sin él no se puede saber a posteriori en qué régimen de
  // volatilidad se tomó cada decisión, y esa es la covariable que el checkpoint necesita
  // para condicionar cualquier tasa base: el ATR% ABSOLUTO no sirve porque ordena por
  // MONEDA (SOL es estructuralmente más volátil que BTC) y confundiría activo con régimen.
  // Se calcula aquí porque las velas ya están en memoria — cero peticiones nuevas.
  // NO decide nada: no entra en ningún umbral ni viaja al LLM (se poda en `buildPrompt`,
  // misma regla que `width_pctile` y `cvd_strength_pctile`).
  const atrPctSeries = (calculateATRSeries(candles) ?? [])
    .map(({ idx, atr: a }) => {
      const c = candles[idx]?.close;
      return Number.isFinite(a) && c > 0 ? (a / c) * 100 : null;
    })
    .filter(Number.isFinite);
  // El percentil se rankea contra el ÚLTIMO ELEMENTO DE LA PROPIA SERIE, no contra un ATR%
  // recalculado desde `calculateATR`. Motivo medido: `calculateATR` devuelve el valor
  // REDONDEADO a 2 decimales (3.87) mientras `calculateATRSeries` va sin redondear
  // (3.873507…), así que el escalar puede caer a cualquiera de los dos lados de su propia
  // entrada en la muestra y el percentil se movía medio punto según la ESCALA del activo —
  // exactamente lo contrario de lo que este campo existe para dar. Lo destapó el test de
  // invariancia de escala. Así el valor rankeado pertenece a la muestra por construcción.
  const atrPctNow = atrPctSeries.length ? atrPctSeries[atrPctSeries.length - 1] : null;
  const atr = atrValue !== null ? {
    value: atrValue,
    pct: currentPrice ? parseFloat((atrValue / currentPrice * 100).toFixed(2)) : null,
    pct_percentile: atrPctSeries.length >= 20 ? percentileRank(atrPctSeries, atrPctNow) : null,
    period: 14,
  } : null;

  // ── CVD ──────────────────────────────────────────────────────
  // divergence_window_candles no es comparable directamente entre TFs (20 velas
  // de 1h ≈ 20h, 20 velas de 1W ≈ 140 días) — se añade el equivalente en minutos.
  // `cvd_strength` lo calcula ya `calculateCVD` por percentiles de la propia serie
  // (auditoría de umbrales T3); aquí solo se enriquece con la equivalencia temporal.
  const cvdRaw = calculateCVD(candles);
  const cvd = cvdRaw ? {
    ...cvdRaw,
    divergence_window_minutes: cvdRaw.divergence_window_candles * TIMEFRAME_MINUTES[timeframe],
  } : null;

  // ── VWAP ─────────────────────────────────────────────────────
  // price_vs_vwap precalculado (above/below/at) — antes el LLM comparaba precio y VWAP.
  const vwapRaw = calculateVWAP(candles);
  const vwap = vwapRaw ? {
    ...vwapRaw,
    price_vs_vwap: priceSide(currentPrice, vwapRaw.value, atr?.pct),
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
  // F2 (2026-08-09): tolerancia de agrupamiento normalizada por ATR (k=0.30, medido en
  // `auditSrTolerance.mjs`) en vez del 0.5% absoluto — antes BTC agrupaba el doble de
  // agresivo que SOL en unidades de volatilidad. Sin ATR (candles insuficientes) se cae al
  // fallback fijo `SR_TOLERANCE_PCT`, igual que el resto de umbrales normalizados del proyecto.
  const srTolerancePct = atr?.pct ? (SR_TOLERANCE_ATR_MULT * atr.pct) / 100 : SR_TOLERANCE_PCT;
  const sr = calculateSupportResistance(candles, SR_LOOKBACK, SR_MIN_TOUCHES, srTolerancePct);

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
      price_vs_poc: priceSide(currentPrice, vpRaw.poc, atr?.pct),
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
// B4 (2026-08-09) · banda muerta del voto de ADX en la pata ESTRUCTURAL de `computeTrend`.
// Medido sobre klines reales (180d, 4h, SOL/BTC/ETH, n=625 ventanas no-ranging):
// |plus_di - minus_di| tiene p10≈3.3 / p20≈5.75 / mediana≈12.8 — hay una franja real de
// empates ruidosos por debajo de ~3 puntos (ver scripts/auditComputeTrend.mjs, sección de
// banda muerta). 3 puntos es del mismo orden que la banda de StochRSI (3, escala 0-100
// compartida con el DI). SIN esta banda, `adx.trend_direction` volcaba un ±1 completo ante
// diferencias mínimas de DI+/DI-, igual que hacía la pata de ejecución antes de H5.
//
// SuperTrend se midió igual (distancia del close al nivel de flip, en unidades de ATR:
// p5≈0.43 / p10≈0.74 / mediana≈2.18) y NO se le añade banda muerta: no hay cúmulo cerca de
// cero — su propio mecanismo de bandas (ratchet) ya actúa como histéresis y no muestra
// evidencia de parpadeo. No tocar sin datos nuevos (mismo criterio que DVOL o la banda de
// precio 0.50×: medido y descartado).
// Exportada para que `scripts/auditComputeTrend.mjs` mida contra la MISMA constante en vez
// de duplicarla — dos "3" que puedan divergir es justo la clase de bug que este proyecto
// lleva sprints eliminando (dueño único).
export const ADX_DI_DEADBAND = 3;

export function computeTrend({ rsi, macd, adx, superTrend, waveTrend, stochRsi, volumeDelta }) {
  // Estructura: ADX trend_direction + SuperTrend.
  // En ranging el trend_direction es ruido estadístico (DI+ vs DI- por diferencia
  // mínima), así que ADX no contribuye al score estructural — sólo cuenta cuando
  // hay tendencia (trending o weak_trend).
  let structureScore = 0, structureCount = 0;
  if (adx && adx.regime !== 'ranging') {
    structureScore += signWithDeadband(adx.plus_di - adx.minus_di, ADX_DI_DEADBAND);
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
