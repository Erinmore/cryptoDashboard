import { fetchOHLC, fetchCurrentPrice, fetchGlobalMarketData, fetchCoinMarketData } from '../services/coingeckoService.js';
import { fetchFearGreed } from '../services/fearGreedService.js';
import { fetchDerivativesData } from '../services/coinalyzeService.js';
import { fetchOrderBookWalls } from '../services/binanceOrderBookService.js';
import { fetchLiquidationClusters } from '../services/liquidationClustersService.js';
import { fetchOnchainMetrics } from '../services/onchainService.js';
import { fetchEtfFlows } from '../services/etfFlowsService.js';
import { fetchMacroData } from '../services/macroService.js';
import { fetchVolatilityData } from '../services/deribitService.js';
import { computeIndicators } from '../services/indicatorService.js';
import { saveAnalysis } from '../services/dbService.js';
import { getHistories } from '../services/historyService.js';
import { analyzeMarket, buildLlmRequest } from '../services/anthropicService.js';
import { applyDecisionGates } from '../services/decisionGates.js';
import env from '../config/env.js';
import { findEntryByDaysAgo, seriesHasGap, daysBetweenDates } from '../utils/timeSeries.js';
import { computeGating } from '../utils/gating.js';
import { computeExpectedScores, backendScoreTotal } from '../utils/expectedScores.js';
import { COINS, TIMEFRAMES } from '../config/constants.js';

// CVD/VWAP se persisten y pueden tener huecos tras un apagado prolongado; un salto mayor
// que esto entre snapshots diarios invalida las tendencias de 30d (mejor null que engañar).
const HISTORY_MAX_GAP_DAYS = 3;
import { ValidationError } from '../utils/errors.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../middleware/logger.js';

/**
 * Calcula distancias en porcentaje a support/resistance más cercano.
 * @param {number} price - Precio actual
 * @param {Array} supports - Array de { price, touches, strength }
 * @param {Array} resistances - Array de { price, touches, strength }
 * @returns {object}
 */
export function computeLevelDistances(price, supports, resistances) {
  let distToSupport = null;
  let distToResistance = null;
  let supportStrength = null;
  let resistanceStrength = null;

  if (supports?.length > 0) {
    const nearestSupport = supports[0]; // Ya ordenado (mayor primero)
    distToSupport = parseFloat(((price - nearestSupport.price) / price * 100).toFixed(2));
    supportStrength = nearestSupport.strength ?? null;
  }

  if (resistances?.length > 0) {
    const nearestResistance = resistances[0]; // Ya ordenado (menor primero)
    distToResistance = parseFloat(((nearestResistance.price - price) / price * 100).toFixed(2));
    resistanceStrength = nearestResistance.strength ?? null;
  }

  return {
    distance_to_nearest_support_pct: distToSupport,
    distance_to_nearest_resistance_pct: distToResistance,
    nearest_support_strength: supportStrength,
    nearest_resistance_strength: resistanceStrength,
  };
}

/**
 * Nivel numérico de SuperTrend: la banda que actúa de soporte (tendencia UP) o de
 * resistencia (tendencia DOWN). El indicador deja exactamente una de las dos no-null.
 * @param {{trend:string, support:?number, resistance:?number}|null} st
 * @returns {number|null}
 */
export function supertrendLevel(st) {
  if (!st) return null;
  return (st.trend === 'UP' ? st.support : st.resistance) ?? null;
}

/**
 * Calcula la tendencia de una serie de valores via regresión lineal simple.
 * Devuelve 'rising' | 'falling' | 'flat' según el signo de la pendiente.
 * @param {number[]} values
 * @returns {'rising'|'falling'|'flat'}
 */
function computeLinearTrend(values) {
  if (!values || values.length < 2) return 'flat';
  const n = values.length;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY = values.reduce((s, v) => s + v, 0);
  const sumXY = values.reduce((s, v, i) => s + i * v, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const threshold = Math.abs(sumY / n) * 0.01; // 1% del promedio
  return slope > threshold ? 'rising' : slope < -threshold ? 'falling' : 'flat';
}

/**
 * Analiza conflictos de tendencias entre timeframes y proporciona contexto para resolver.
 * @param {object} technical - Objeto con indicadores por TF: {1h, 4h, 1D, 1W}
 * @param {string} primaryTf - TF principal seleccionado por el usuario
 * @returns {object} Contexto de conflictos y jerarquía recomendada
 */
export function analyzeTimeframeConflicts(technical, primaryTf) {
  if (!technical || Object.keys(technical).length === 0) return null;

  const trends = {};
  for (const [tf, data] of Object.entries(technical)) {
    trends[tf] = data?.trend ?? null;
  }

  // Detectar conflictos: corto plazo vs largo plazo divergen
  const shortTermTrend = trends['1h'] || trends['4h'];
  const longTermTrend = trends['1D'] || trends['1W'];

  // Dirección tri-estado. IMPORTANTE: 'neutral' NO es bajista. Antes se infería la
  // dirección con !includes('bullish'), que colapsaba neutral→bajista y fabricaba
  // conflictos falsos (p.ej. corto neutral + largo alcista se reportaba como
  // "short_term_bearish_long_term_bullish" con su reasoning engañoso, que llega al LLM).
  const dirOf = (t) => !t ? null : t.includes('bullish') ? 'bull' : t.includes('bearish') ? 'bear' : 'neutral';
  const shortDir = dirOf(shortTermTrend);
  const longDir  = dirOf(longTermTrend);

  let conflict = null;
  // Solo hay conflicto si AMBOS TFs son direccionales y OPUESTOS.
  if (shortDir && longDir && shortDir !== 'neutral' && longDir !== 'neutral' && shortDir !== longDir) {
    conflict = shortDir === 'bull' ? 'short_term_bullish_long_term_bearish' : 'short_term_bearish_long_term_bullish';
  }

  // Jerarquía: qué TF confiar según situación
  const hierarchy = {
    default: ['1D', '4h', '1W', '1h'], // largo plazo → corto plazo
    momentum: ['1h', '4h', '1D', '1W'],  // si hay movimiento rápido, corto plazo primero
    confirmation: ['1D', '1W', '4h', '1h'], // confirmación: largo plazo debe validar
  };

  return {
    primary_tf: primaryTf,
    conflict,
    reasoning: conflict
      ? conflict === 'short_term_bullish_long_term_bearish'
        ? 'Short-term momentum is bullish but longer timeframes show bearish structure. Use caution and wait for confirmation from higher timeframes.'
        : 'Short-term momentum is bearish but longer timeframes show bullish structure. This could be a pullback in an uptrend. Monitor for reversal signals.'
      : 'No major conflict between timeframes.',
    hierarchy_recommendation: 'default',
    hierarchy_tiers: hierarchy,
    guidance: 'For conflicting signals: wait for alignment before taking action. Use longer timeframes for support/resistance levels and shorter timeframes for entry/exit timing.',
  };
}

export function computeHistorySummaries(histories) {
  // ── Fear & Greed summary (30d) ──────────────────────────────────────────
  const fgHistory = histories?.fear_greed ?? [];
  let fearGreedSummary = null;
  if (fgHistory.length >= 1) {
    const values = fgHistory.map(e => e.value);

    // Calcular fechas relativas buscando por date exacta
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    const current = fgHistory.find(e => e.date === today);
    const yesterdayEntry = fgHistory.find(e => e.date === yesterday);
    const sevenDaysEntry = fgHistory.find(e => e.date === sevenDaysAgo);
    // Para 30d_ago: buscar fecha exacta, sino usar el primero (más antiguo)
    const thirtyDaysEntry = fgHistory.find(e => e.date === thirtyDaysAgo) || fgHistory.at(0);

    fearGreedSummary = {
      current:    current ? { value: current.value, classification: current.classification } : (fgHistory.at(-1) ? { value: fgHistory.at(-1).value, classification: fgHistory.at(-1).classification } : null),
      yesterday:  yesterdayEntry ? { value: yesterdayEntry.value, classification: yesterdayEntry.classification } : (fgHistory.at(-2) ? { value: fgHistory.at(-2).value, classification: fgHistory.at(-2).classification } : null),
      '7d_ago':   sevenDaysEntry ? { value: sevenDaysEntry.value, classification: sevenDaysEntry.classification } : null,
      '30d_ago':  thirtyDaysEntry ? { value: thirtyDaysEntry.value, classification: thirtyDaysEntry.classification } : null,
      period_min: Math.min(...values),
      period_max: Math.max(...values),
      period_avg: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
      // trend_30d: null si no hay un ancla 30d distinta del valor actual (con 1 punto,
      // thirtyDaysEntry === at(-1) y la comparación era espuria → 'deteriorating' falso).
      // Banda 'stable' para no reportar dirección ante igualdad exacta.
      trend_30d:  (fgHistory.length >= 2 && thirtyDaysEntry && thirtyDaysEntry !== fgHistory.at(-1))
        ? (fgHistory.at(-1).value > thirtyDaysEntry.value ? 'improving'
          : fgHistory.at(-1).value < thirtyDaysEntry.value ? 'deteriorating' : 'stable')
        : null,
    };
  }

  // ── Funding Rate summary (48h) ──────────────────────────────────────────
  const frHistory = histories?.funding_rate ?? [];
  let fundingRateSummary = null;
  if (frHistory.length >= 1) {
    // Los candles de Coinalyze (o/h/l/c) vienen YA en porcentaje, misma escala que el
    // top-level `funding_rate.rate_pct` (ver coinalyzeService: value ya es %). Por eso se
    // pasan tal cual y severity_last_candle aplica umbrales de % directamente.
    const closes = frHistory.map(e => e.c);
    const positiveCount = closes.filter(v => v > 0).length;
    const latestClose = frHistory.at(-1)?.c ?? 0;
    // Los campos 48h solo tienen sentido con al menos 2 candles de historial.
    const has48h = frHistory.length >= 2;
    fundingRateSummary = {
      open_48h:             has48h ? frHistory.at(0)?.o ?? null : null,
      close_current:        frHistory.at(-1)?.c ?? null,
      high_48h:             has48h ? Math.max(...frHistory.map(e => e.h)) : null,
      low_48h:              has48h ? Math.min(...frHistory.map(e => e.l)) : null,
      trend_48h:            has48h ? (frHistory.at(-1)?.trend ?? null) : null,
      pct_candles_positive: Math.round((positiveCount / closes.length) * 100),
      // Severidad del último candle de histórico (hasta 6h de lag) — puede diferir de
      // `funding_rate.severity` (top-level), que se calcula sobre el valor live. Simétrico:
      // el lado negativo (shorts sobrecargados) también se clasifica — antes un candle muy
      // negativo (-0.6%) se reportaba como 'normal', dato engañoso para el LLM.
      severity_last_candle:
        latestClose >  0.5 ? 'extreme'
        : latestClose >  0.2 ? 'high'
        : latestClose >  0.05 ? 'elevated'
        : latestClose < -0.5 ? 'extreme_short_overload'
        : latestClose < -0.2 ? 'high_short_overload'
        : latestClose < -0.05 ? 'elevated_short_overload'
        : 'normal',
    };
  }

  // ── Open Interest summary (7d) ──────────────────────────────────────────
  const oiHistory = histories?.open_interest ?? [];
  let openInterestSummary = null;
  if (oiHistory.length >= 1) {
    // Los campos 7d solo tienen sentido con al menos 2 candles de historial (4h c/u).
    const has7d = oiHistory.length >= 2;
    const open7d  = has7d ? oiHistory.at(0)?.o ?? null : null;
    const close7d = oiHistory.at(-1)?.c ?? null;
    const change7dPct = has7d && open7d ? ((close7d - open7d) / open7d) * 100 : null;
    // Los campos 24h necesitan ~6 candles de 4h (24h reales), no solo el punto actual.
    const has24h = oiHistory.length >= 6;
    const last6 = oiHistory.slice(-6);
    const last6Open  = has24h ? last6.at(0)?.o ?? null : null;
    const last6Close = last6.at(-1)?.c ?? null;
    const change24hPct = has24h && last6Open ? ((last6Close - last6Open) / last6Open) * 100 : null;
    // Los candles de OI de Coinalyze vienen en MONEDAS BASE, no USD (hallazgo 4 de la
    // auditoría #2) — los campos lo declaran; los % de cambio son invariantes a la unidad.
    openInterestSummary = {
      unit:            'base_coin',
      open_7d_coins:   open7d,
      current_coins:   close7d,
      high_7d_coins:   has7d ? Math.max(...oiHistory.map(e => e.h)) : null,
      low_7d_coins:    has7d ? Math.min(...oiHistory.map(e => e.l)) : null,
      change_7d_pct:  change7dPct  !== null ? parseFloat(change7dPct.toFixed(2))  : null,
      change_24h_pct: change24hPct !== null ? parseFloat(change24hPct.toFixed(2)) : null,
      trend_7d:       change7dPct === null ? null : change7dPct > 5 ? 'increasing' : change7dPct < -5 ? 'decreasing' : 'stable',
    };
  }

  // ── Long/Short Ratio summary (7d) ───────────────────────────────────────
  const lsHistory = histories?.long_short_ratio ?? [];
  let longShortSummary = null;
  if (lsHistory.length >= 1) {
    const longPcts    = lsHistory.map(e => e.long_pct);
    // Los campos *_7d solo tienen sentido con >=2 puntos — simétrico con funding (has48h)
    // y OI (has7d). Sin esto, con 1 solo punto (arranque en frío / respuesta parcial de la
    // API) se etiquetaban como "7d" un change=0/avg/max/min derivados de un único valor,
    // dato espurio para el LLM. current_* NO se gatea (es el snapshot "ahora", no ventana).
    const has7d       = lsHistory.length >= 2;
    const open7dLong  = has7d ? lsHistory.at(0)?.long_pct ?? null : null;
    const close7dLong = lsHistory.at(-1)?.long_pct ?? null;
    const change7d    = has7d && open7dLong !== null ? close7dLong - open7dLong : null;
    longShortSummary = {
      current_long_pct:   close7dLong,
      current_short_pct:  lsHistory.at(-1)?.short_pct ?? null,
      open_7d_long_pct:   open7dLong,
      change_7d_long_pct: change7d !== null ? parseFloat(change7d.toFixed(2)) : null,
      avg_7d_long_pct:    has7d ? parseFloat((longPcts.reduce((s, v) => s + v, 0) / longPcts.length).toFixed(2)) : null,
      max_7d_long_pct:    has7d ? Math.max(...longPcts) : null,
      min_7d_long_pct:    has7d ? Math.min(...longPcts) : null,
      trend_7d:           change7d === null ? null : change7d > 2 ? 'longs_increasing' : change7d < -2 ? 'longs_decreasing' : 'stable',
    };
  }

  // ── Liquidations summary (7d) ───────────────────────────────────────────
  const liqHistory = histories?.liquidations ?? [];
  let liquidationsSummary = null;
  if (liqHistory.length >= 1) {
    const last24h = liqHistory.at(-1);
    // Los campos 7d solo tienen sentido con al menos 2 días de historial.
    const has7d = liqHistory.length >= 2;
    const totalLongs  = has7d ? liqHistory.reduce((s, e) => s + e.longs_usd, 0) : null;
    const totalShorts = has7d ? liqHistory.reduce((s, e) => s + e.shorts_usd, 0) : null;
    const n = liqHistory.length;
    const recent3Avg = liqHistory.slice(-3).reduce((s, e) => s + e.longs_usd + e.shorts_usd, 0) / Math.min(n, 3);
    const older3Avg  = n >= 2 ? liqHistory.slice(0, 3).reduce((s, e) => s + e.longs_usd + e.shorts_usd, 0) / Math.min(n, 3) : 0;
    const trendRatio = has7d && older3Avg > 0 ? recent3Avg / older3Avg : null;
    liquidationsSummary = {
      last_24h_longs_usd:         last24h?.longs_usd  ?? null,
      last_24h_shorts_usd:        last24h?.shorts_usd ?? null,
      last_24h_total_usd:         last24h ? last24h.longs_usd + last24h.shorts_usd : null,
      '7d_total_longs_usd':       has7d ? parseFloat(totalLongs.toFixed(2)) : null,
      '7d_total_shorts_usd':      has7d ? parseFloat(totalShorts.toFixed(2)) : null,
      '7d_avg_daily_longs_usd':   has7d ? parseFloat((totalLongs / n).toFixed(2)) : null,
      '7d_avg_daily_shorts_usd':  has7d ? parseFloat((totalShorts / n).toFixed(2)) : null,
      longs_vs_shorts_7d_ratio:   has7d && totalShorts > 0 ? parseFloat((totalLongs / totalShorts).toFixed(2)) : null,
      trend_7d: trendRatio === null ? null : trendRatio > 1.3 ? 'escalating' : trendRatio < 0.7 ? 'decreasing' : 'stable',
    };
  }

  // ── CVD summary (30d) ───────────────────────────────────────────────────
  // El `value` persistido es el CVD acumulado sobre una ventana 1D RODANTE (90 velas),
  // así que su base se desplaza un día por barra: comparar `value`s de días distintos
  // mezcla el forward-delta real con los días que cayeron por detrás de la ventana. Para
  // que change/high/low/trend sean honestos, reconstruimos una serie acumulada con base
  // ÚNICA a partir de `delta` (delta neto diario, estacionario). Si algún entry carece de
  // `delta` (pre-fix), degradamos al `value` rodante (transitorio, se autocura al vencer
  // la ventana de 30d una vez todo el histórico es post-fix).
  const rawCvdHistory = histories?.cvd ?? [];
  const allHaveDelta = rawCvdHistory.length >= 2 && rawCvdHistory.every(e => Number.isFinite(e.delta));
  let cvdHistory = rawCvdHistory;
  let cvdBaseline = 'rolling_window';
  if (allHaveDelta) {
    // Serie acumulada con base consistente: cum_k = Σ delta_i (i<=k), anclada al primer día.
    let acc = 0;
    cvdHistory = rawCvdHistory.map((e) => { acc += e.delta; return { ...e, value: parseFloat(acc.toFixed(2)) }; });
    cvdBaseline = 'consistent';
  }
  let cvdSummary = null;
  // Mínimo 2 puntos para calcular cambios; con 1 solo punto los porcentajes serían 0 espurios.
  if (cvdHistory.length >= 2) {
    const values = cvdHistory.map(e => e.value);
    const current = cvdHistory.at(-1);
    // Gap-aware: lookups por fecha real (no por posición, que con huecos miente) y
    // deltas/tendencia de 30d a null si la serie persistida tiene agujeros grandes.
    const gapped = seriesHasGap(cvdHistory, HISTORY_MAX_GAP_DAYS);
    const ref24h = findEntryByDaysAgo(cvdHistory, 1, 1);
    const ref7d  = findEntryByDaysAgo(cvdHistory, 7, 2);
    const ref30d = findEntryByDaysAgo(cvdHistory, 30, 3) ?? cvdHistory.at(0);
    const pctChange = (from, to) => (from?.value != null && to?.value != null && from.value !== 0)
      ? parseFloat(((to.value - from.value) / Math.abs(from.value) * 100).toFixed(2))
      : null;
    const periodMin = Math.min(...values);   // ventana completa (hasta 30d)
    const periodMax = Math.max(...values);
    // high_7d/low_7d de verdad sobre los últimos 7 días por fecha (no toda la ventana,
    // que con 30 puntos diarios mentía al etiquetarse "7d").
    const inWindow = (days) => cvdHistory.filter(e => {
      const d = daysBetweenDates(e.date, current.date); return d != null && d >= 0 && d <= days;
    });
    const vals7d = inWindow(7).map(e => e.value);
    // Presión neta acumulada de la ventana (drift-free, sólo con serie consistente): suma de
    // deltas diarios. Absoluto, interpretable, sin el problema de %-sobre-base-cercana-a-cero.
    const netDelta = (days) => allHaveDelta
      ? parseFloat(inWindow(days).reduce((s, e) => s + e.delta, 0).toFixed(2))
      : null;
    cvdSummary = {
      current_value:      current.value,
      current_trend:      current.trend,
      current_divergence: current.divergence,
      change_pct_24h:     pctChange(ref24h, current),
      change_pct_7d:      pctChange(ref7d, current),
      change_pct_30d:     gapped ? null : pctChange(ref30d, current),
      net_delta_7d:       netDelta(7),
      net_delta_30d:      gapped ? null : netDelta(30),
      high_7d:            vals7d.length ? Math.max(...vals7d) : null,
      low_7d:             vals7d.length ? Math.min(...vals7d) : null,
      period_min:         periodMin,
      period_max:         periodMax,
      trend_30d:          gapped ? null : computeLinearTrend(values),
      baseline:           cvdBaseline, // 'consistent' (base única) | 'rolling_window' (legacy, con deriva)
    };
  }

  // ── VWAP summary (30d) ──────────────────────────────────────────────────
  // NOTE: VWAP cambios % pequeños (típicamente 1-3%) pero significativos.
  // Un cambio de 2% en VWAP = $2 movimiento en BTC $100k, muy relevante.
  // Mantener change_pct por compatibilidad, pero considerar future: absolute_change en USD.
  const vwapHistory = histories?.vwap ?? [];
  let vwapSummary = null;
  if (vwapHistory.length >= 1) {
    const values = vwapHistory.map(e => e.value);
    const current = vwapHistory.at(-1);
    // Con un único punto histórico, deltas y trend serían 0/espurios — requerir al menos 2.
    const hasTrend = vwapHistory.length >= 2;
    // Gap-aware: igual que CVD — lookup por fecha y null si la serie tiene agujeros grandes.
    const gapped = hasTrend && seriesHasGap(vwapHistory, HISTORY_MAX_GAP_DAYS);
    const ref7d  = findEntryByDaysAgo(vwapHistory, 7, 2);
    const ref30d = findEntryByDaysAgo(vwapHistory, 30, 3) ?? vwapHistory.at(0);
    const pctChange = (from, to) => (hasTrend && from?.value != null && to?.value != null && from.value !== 0)
      ? parseFloat(((to.value - from.value) / Math.abs(from.value) * 100).toFixed(2))
      : null;
    vwapSummary = {
      current_value:      current.value,
      current_trend:      current.trend,
      current_divergence: current.divergence,
      change_pct_7d:      gapped ? null : pctChange(ref7d, current),
      change_pct_30d:     gapped ? null : pctChange(ref30d, current),
      period_min:         hasTrend ? Math.min(...values) : null,
      period_max:         hasTrend ? Math.max(...values) : null,
      trend_30d:          (hasTrend && !gapped) ? computeLinearTrend(values) : null,
    };
  }

  return { fearGreedSummary, fundingRateSummary, openInterestSummary, longShortSummary, liquidationsSummary, cvdSummary, vwapSummary };
}

/**
 * Contexto estructural de BTC para el BTC DOMINANCE OVERRIDE del prompt.
 *
 * Bug que corrige (auditoría C3): el prompt pedía inferir la estructura de BTC de
 * `technical["1D"].trend`, pero en un análisis de ETH/SOL ese campo es el trend del
 * ALT, no de BTC → el guardrail se alimentaba del activo equivocado. Aquí se calcula
 * el trend REAL de BTC (1D/1W) y se inyecta como bloque `btc_context`.
 *
 * - coin === 'BTC': se reutiliza el `technical` ya calculado (source:'self'), sin fetch extra.
 * - alts: fetch de BTC 1D/1W + computeIndicators. Degraded mode: null en fallo (nunca rompe).
 *
 * @param {string} coin
 * @param {object} technical - bloque technical del activo analizado (para el caso BTC).
 * @returns {Promise<{trend_1d:string|null, trend_1w:string|null, source:string}|null>}
 */
async function buildBtcContext(coin, technical) {
  if (coin === 'BTC') {
    return {
      trend_1d: technical?.['1D']?.trend ?? null,
      trend_1w: technical?.['1W']?.trend ?? null,
      source: 'self',
    };
  }
  try {
    const [btc1D, btc1W] = await Promise.allSettled([fetchOHLC('BTC', '1D'), fetchOHLC('BTC', '1W')]);
    const c1D = btc1D.status === 'fulfilled' ? btc1D.value : null;
    const c1W = btc1W.status === 'fulfilled' ? btc1W.value : null;
    const trend1d = c1D?.length ? computeIndicators(c1D, '1D')?.trend ?? null : null;
    const trend1w = c1W?.length ? computeIndicators(c1W, '1W')?.trend ?? null : null;
    if (trend1d == null && trend1w == null) return null;
    return { trend_1d: trend1d, trend_1w: trend1w, source: 'btc_klines' };
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'buildBtcContext: fallo obteniendo contexto BTC');
    return null;
  }
}

async function buildAnalyzeContext(coin, primaryTf) {
  logger.info({ coin, primaryTf }, 'Building analysis payload');

  const binanceSymbols = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
  const binanceSymbol = binanceSymbols[coin];

  const [
    ohlc1h,
    ohlc4h,
    ohlc1D,
    ohlc1W,
    priceResult,
    fearGreedResult,
    derivativesResult,
    globalMarketResult,
    coinMarketResult,
    orderBookResult,
    liquidationClustersResult,
    onchainResult,
    etfFlowsResult,
    macroResult,
    volatilityResult,
  ] = await Promise.allSettled([
    fetchOHLC(coin, '1h'),
    fetchOHLC(coin, '4h'),
    fetchOHLC(coin, '1D'),
    fetchOHLC(coin, '1W'),
    fetchCurrentPrice(coin),
    fetchFearGreed(),
    fetchDerivativesData(coin),
    fetchGlobalMarketData(),
    fetchCoinMarketData(coin),
    fetchOrderBookWalls(binanceSymbol),
    fetchLiquidationClusters(coin),
    fetchOnchainMetrics(coin),
    fetchEtfFlows(coin),
    fetchMacroData(),
    fetchVolatilityData(),
  ]);

  const resolve = (result) => (result.status === 'fulfilled' ? result.value : null);

  const candles = {
    '1h': resolve(ohlc1h),
    '4h': resolve(ohlc4h),
    '1D': resolve(ohlc1D),
    '1W': resolve(ohlc1W),
  };

  const fearGreed    = resolve(fearGreedResult);
  const derivatives  = resolve(derivativesResult);
  const globalMarket = resolve(globalMarketResult);
  const coinMarket   = resolve(coinMarketResult);
  const price        = resolve(priceResult);
  const orderBook    = resolve(orderBookResult);
  const liquidationClusters = resolve(liquidationClustersResult);
  const onchain      = resolve(onchainResult);
  const etfFlows     = resolve(etfFlowsResult);
  const macro        = resolve(macroResult);
  const volatility   = resolve(volatilityResult);

  const currentPrice = price?.price ?? null;

  const technical = {};
  for (const tf of TIMEFRAMES) {
    if (candles[tf]?.length) {
      const indicators = computeIndicators(candles[tf], tf);
      const sr = indicators?.support_resistance;
      const distances = computeLevelDistances(
        currentPrice,
        sr?.supports ?? [],
        sr?.resistances ?? []
      );

      // No reordenamos supports/resistances por valor absoluto: rompía la semántica
      // "supports[0] = más cercano por debajo / resistances[0] = más cercana por
      // encima" que ya garantiza calculateSupportResistance. Si hace falta exponer
      // niveles ordenados por distancia, hacerlo en un campo separado.
      technical[tf] = { ...indicators, ...distances };
    }
  }

  // Contexto estructural de BTC (real, no el del alt) para el BTC DOMINANCE OVERRIDE (C3).
  const btcContext = await buildBtcContext(coin, technical);

  const histories = getHistories(coin);
  const { fearGreedSummary, fundingRateSummary, openInterestSummary, longShortSummary, liquidationsSummary, cvdSummary, vwapSummary } =
    computeHistorySummaries(histories);

  const fr  = derivatives?.funding_rate    ?? null;
  const oi  = derivatives?.open_interest   ?? null;
  const lsr = derivatives?.long_short_ratio ?? null;
  const liq = derivatives?.liquidations    ?? null;
  const tfConflicts = analyzeTimeframeConflicts(technical, primaryTf);

  // Crowded trade: funding extremo en una dirección sin que el Open Interest
  // expanda en esa misma dirección — posicionamiento sobrecargado sin convicción
  // de nuevo capital entrando (squeeze risk / late-cycle trap). Mismo patrón que ya
  // aplica el FUNDING PERSISTENCE FILTER del SYSTEM_PROMPT, expuesto aquí como campo
  // explícito para consumidores fuera del LLM (frontend, futuro backtesting).
  // Fail-closed (auditoría #2, hallazgo 14): sin dato de OI el flag NO se afirma —
  // mismo criterio H2 que el gating (antes trend_7d=null activaba "crowded" a ciegas).
  const oiNotExpanding = openInterestSummary?.trend_7d != null && openInterestSummary.trend_7d !== 'increasing';
  const crowdedLong  = ['high', 'extreme'].includes(fr?.severity) && oiNotExpanding;
  const crowdedShort = ['high_short_overload', 'extreme_short_overload'].includes(fr?.severity_negative) && oiNotExpanding;
  const crowdedTradeFlag = {
    active: crowdedLong || crowdedShort,
    side: crowdedLong ? 'long' : crowdedShort ? 'short' : null,
    reason: crowdedLong
      ? `funding_severity=${fr.severity} sin expansión de OI (trend_7d=${openInterestSummary?.trend_7d ?? 'unknown'})`
      : crowdedShort
        ? `funding_severity_negative=${fr.severity_negative} sin expansión de OI (trend_7d=${openInterestSummary?.trend_7d ?? 'unknown'})`
        : null,
  };

  // HARD GATING determinista: los vetos de trade se precalculan aquí (utils/gating.js)
  // en vez de dejar que el LLM recomponga el AND de tres condiciones con umbrales de %.
  // El LLM recibe los flags en el bloque `gating` y solo obedece. S/R del TF primario.
  // computeGating combina vetos (simétricos, fail-closed) + contradicciones (5 de 6;
  // el LLM suma la 6ª) y aplica el dedupe veto↔contradicciones. Ver utils/gating.js.
  const gating = computeGating({
    technical,
    openInterest: oi ? { change_24h_pct: oi.change_24h_pct } : null,
    currentPrice,
    primaryTf,
  });

  // Guardia de divergencia de scores (auditoría C2): score direccional ESPERADO por el
  // backend para Derivatives/Volume (los bloques que abren la puerta de Comprar/Vender).
  // El validador compara el score del LLM contra este esperado y degrada si contradice
  // flagrantemente el dato → la puerta deja de validarse solo contra el auto-reporte del LLM.
  const expectedScores = computeExpectedScores(
    { derivatives: { funding_rate: fr, long_short_ratio: lsr }, technical },
    primaryTf,
  );

  // D22: fuente del precio de referencia. El timestamp es el del FETCH real del precio
  // (sobrevive al TTL de cache de 30s) — antes se fabricaba con new Date() al construir
  // el payload, fingiendo frescura (auditoría #2, hallazgo 19).
  const priceSource = 'binance_spot';
  const priceTimestampUtc = price?.fetched_at ?? new Date().toISOString();

  // D8: calcular lag de ETF flows desde as_of hasta hoy
  // #9: cuando etf_flows es null distinguimos "no aplica al activo" (SOL no
  // tiene spot ETF) de "fallo de fetch" en un activo que sí lo soporta (BTC/ETH).
  const ETF_SUPPORTED = new Set(['BTC', 'ETH']);
  let etfFlowsEnriched;
  if (etfFlows?.as_of) {
    const asOfMs = new Date(etfFlows.as_of).getTime();
    const lagDays = Math.round((Date.now() - asOfMs) / 86400000);
    etfFlowsEnriched = {
      ...etfFlows,
      data_lag_days: lagDays,
      data_freshness: lagDays > 2 ? 'stale' : 'fresh',
      freshness_warning: lagDays > 2
        ? `ETF flow data is ${lagDays} days old. Use for structural context only, not short-term signal.`
        : null,
    };
  } else {
    etfFlowsEnriched = {
      available: false,
      unavailable_reason: ETF_SUPPORTED.has(coin) ? 'fetch_failed' : 'not_supported_for_asset',
    };
  }

  // D9 + #9: on-chain solo existe para BTC; ETH/SOL no lo soportan. Cuando es
  // null exponemos el motivo en lugar de un null pelado.
  const ONCHAIN_SUPPORTED = new Set(['BTC']);
  const onchainEnriched = onchain ? {
    ...onchain,
    exchange_netflow_unavailable_reason: onchain.exchange_netflow_24h_btc == null ? 'not_in_free_tier' : null,
  } : {
    available: false,
    unavailable_reason: ONCHAIN_SUPPORTED.has(coin) ? 'fetch_failed' : 'not_supported_for_asset',
  };

  return {
    coin,
    primary_tf: primaryTf,
    price_current:        currentPrice != null ? parseFloat(currentPrice.toFixed(2)) : null,
    price_change_24h_pct: price?.change_24h_pct != null ? parseFloat(price.change_24h_pct.toFixed(2)) : null,
    price_source: priceSource,
    price_timestamp_utc: priceTimestampUtc,

    global_market: globalMarket ? {
      total_market_cap_usd:      globalMarket.total_market_cap_usd != null ? Math.round(globalMarket.total_market_cap_usd) : null,
      market_cap_change_24h_pct: globalMarket.market_cap_change_24h_pct != null ? parseFloat(globalMarket.market_cap_change_24h_pct.toFixed(2)) : null,
      btc_dominance_pct:         globalMarket.btc_dominance != null ? parseFloat(globalMarket.btc_dominance.toFixed(2)) : null,
      altcoin_market_cap_usd:    globalMarket.altcoin_market_cap_usd != null ? Math.round(globalMarket.altcoin_market_cap_usd) : null,
    } : null,

    coin_market: coinMarket ? {
      market_cap_usd: coinMarket.market_cap_usd != null ? Math.round(coinMarket.market_cap_usd) : null,
      volume_24h_usd: coinMarket.volume_24h_usd != null ? Math.round(coinMarket.volume_24h_usd) : null,
      ath_usd:        coinMarket.ath_usd != null ? parseFloat(coinMarket.ath_usd.toFixed(2)) : null,
      ath_change_pct: coinMarket.ath_change_pct != null ? parseFloat(coinMarket.ath_change_pct.toFixed(2)) : null,
      atl_usd:        coinMarket.atl_usd != null ? parseFloat(coinMarket.atl_usd.toFixed(2)) : null,
      atl_change_pct: coinMarket.atl_change_pct != null ? parseFloat(coinMarket.atl_change_pct.toFixed(2)) : null,
    } : null,

    sentiment: {
      fear_greed: fearGreed ? {
        value:           fearGreed.value,
        classification:  fearGreed.classification,
        trend_1d:        fearGreed.trend_1d,
        trend_7d_change: fearGreed.trend_7d_change,
      } : null,
      fear_greed_history: fearGreedSummary,
    },

    technical,

    // Estructura real de BTC (1D/1W) para el BTC DOMINANCE OVERRIDE del prompt. Para BTC
    // es source:'self'; para alts se calcula desde klines de BTC (no del alt). Ver C3.
    btc_context: btcContext,

    timeframe_analysis: tfConflicts,

    gating,

    // Scores esperados por el backend (guardia de divergencia, C2). buildPrompt los EXCLUYE
    // del dataset que recibe el LLM (si los viera podría copiarlos y anular la guardia —
    // auditoría #2, hallazgo 1); el validador los usa para detectar que el score de la
    // puerta contradice el dato. Se persisten para calibración (LLM vs backend).
    expected_scores: expectedScores,

    derivatives: {
      funding_rate: fr ? {
        rate_pct:           fr.rate_pct,
        annualized_pct:     fr.annualized_pct,
        severity:           fr.severity,
        severity_negative:  fr.severity_negative ?? null,
        trend:              fr.trend,
        signal:             fr.signal,
        predicted_rate_pct: fr.predicted_rate_pct,
        history:            fundingRateSummary,
        data_timestamp_utc: fr.data_timestamp_utc ?? null,
      } : null,

      open_interest: oi ? {
        value_coins:    oi.value_coins,
        unit:           oi.unit ?? 'base_coin',
        // USD real derivado (coins × spot); el exchange reporta en monedas base.
        value_usd:      currentPrice != null && oi.value_coins != null
          ? Math.round(oi.value_coins * currentPrice) : null,
        value_usd_basis: 'derived_coins_x_spot',
        change_24h_pct: oi.change_24h_pct,
        signal:         oi.signal,
        history:        openInterestSummary,
        data_timestamp_utc: oi.data_timestamp_utc ?? null,
      } : null,

      long_short_ratio: lsr ? {
        long_pct:  lsr.long_pct,
        short_pct: lsr.short_pct,
        signal:    lsr.signal,
        // Desde v7_1 la señal es relativa a la base del propio activo (terciles de 7d): el
        // corte fijo 60/40 daba `contrarian_bear` el 95,7 % del tiempo en SOL, cuya mediana
        // de long% es 72,7 %. Sin estos campos la etiqueta no sería auditable a posteriori.
        long_pct_percentile: lsr.long_pct_percentile ?? null,
        signal_cuts:         lsr.signal_cuts ?? null,
        signal_basis:        lsr.signal_basis ?? null,
        source:    lsr.source ?? 'coinalyze',
        history:   longShortSummary,
        data_timestamp_utc: lsr.data_timestamp_utc ?? null,
      } : null,

      liquidations_24h: liq ? {
        longs_usd:  liq.longs_usd,
        shorts_usd: liq.shorts_usd,
        total_usd:  liq.total_usd,
        signal:     liq.signal,
        history:    liquidationsSummary,
        data_timestamp_utc: liq.data_timestamp_utc ?? null,
      } : null,

      liquidation_clusters: liquidationClusters,

      crowded_trade_flag: crowdedTradeFlag,
    },

    onchain: onchainEnriched,

    etf_flows: etfFlowsEnriched,

    macro,

    volatility,

    order_book: orderBook ? {
      buy_wall:             orderBook.buyWall,
      sell_wall:            orderBook.sellWall,
      spread_usd:           parseFloat(orderBook.spread.toFixed(4)),
      spread_pct:           parseFloat(orderBook.spread_pct.toFixed(6)),
      imbalance_ratio:      orderBook.imbalance_ratio,
      imbalance_top5_ratio: orderBook.imbalance_top5_ratio,
      imbalance_signal:     orderBook.imbalance_signal,
    } : null,

    volume_history: {
      cvd: cvdSummary ? { ...cvdSummary, source_tf: '1D', role: 'trend_context' } : null,
      vwap: vwapSummary,
    },
  };
}

/**
 * Builds the header object for the `analyses` table from context + LLM output.
 */
function buildAnalysisHeader(id, coin, primaryTf, context, structured, ai_metadata, processingMs) {
  const fg    = context.sentiment?.fear_greed ?? null;
  const fgH   = context.sentiment?.fear_greed_history ?? null;
  const macro = context.macro ?? null;
  const vol   = context.volatility ?? null;
  const oc    = context.onchain ?? null;
  const fr    = context.derivatives?.funding_rate ?? null;
  const oi    = context.derivatives?.open_interest ?? null;
  const lsr   = context.derivatives?.long_short_ratio ?? null;
  const liq   = context.derivatives?.liquidations_24h ?? null;
  const etf   = context.etf_flows ?? null;
  const ob    = context.order_book ?? null;
  const setup = structured.setup ?? null;

  return {
    id,
    coin,
    primary_tf: primaryTf,
    timestamp: new Date().toISOString(),
    prompt_version: ai_metadata.prompt_version,

    price_current:            context.price_current ?? null,
    price_change_24h_pct:     context.price_change_24h_pct ?? null,
    btc_dominance_pct:        context.global_market?.btc_dominance_pct ?? null,
    market_cap_change_24h_pct: context.global_market?.market_cap_change_24h_pct ?? null,

    fear_greed_value:    fg?.value ?? null,
    fear_greed_class:    fg?.classification ?? null,
    fear_greed_trend_30d: fgH?.trend_30d ?? null,
    fear_greed_30d_avg:  fgH?.period_avg ?? null,

    macro_regime:  macro?.macro_regime ?? null,
    dxy_value:     macro?.dxy?.value ?? null,
    dxy_trend_5d:  macro?.dxy?.trend_5d ?? null,
    spx_trend_5d:  macro?.spx?.trend_5d ?? null,
    gold_trend_5d: macro?.gold?.trend_5d ?? null,

    btc_dvol_value:  vol?.btc_dvol?.value ?? null,
    btc_dvol_regime: vol?.btc_dvol?.regime ?? null,
    eth_dvol_value:  vol?.eth_dvol?.value ?? null,

    mvrv:        oc?.mvrv ?? null,
    mvrv_zscore: oc?.mvrv_zscore ?? null,
    mvrv_signal: oc?.mvrv_signal ?? null,
    nupl:        oc?.nupl ?? null,
    nupl_signal: oc?.nupl_signal ?? null,
    sopr:        oc?.sopr ?? null,
    sopr_signal: oc?.sopr_signal ?? null,

    funding_rate_pct:          fr?.rate_pct ?? null,
    funding_severity:          fr?.severity ?? null,
    funding_severity_negative: fr?.severity_negative ?? null,
    funding_trend:             fr?.trend ?? null,
    predicted_rate_pct:        fr?.predicted_rate_pct ?? null,
    oi_value_usd:              oi?.value_usd ?? null,   // USD real DERIVADO (coins × spot)
    oi_value_coins:            oi?.value_coins ?? null, // medida canónica del exchange
    oi_change_24h_pct:         oi?.change_24h_pct ?? null,
    oi_trend_7d:               oi?.history?.trend_7d ?? null,
    long_pct:                  lsr?.long_pct ?? null,
    short_pct:                 lsr?.short_pct ?? null,
    liq_longs_24h_usd:         liq?.longs_usd ?? null,
    liq_shorts_24h_usd:        liq?.shorts_usd ?? null,

    etf_trend_7d:          etf?.trend_7d ?? null,
    etf_net_inflow_7d_usd: etf?.net_inflow_usd_7d_sum ?? null,
    etf_data_freshness:    etf?.data_freshness ?? null,

    ob_imbalance_ratio:       ob?.imbalance_ratio ?? null,
    ob_imbalance_top5_ratio:  ob?.imbalance_top5_ratio ?? null,
    ob_imbalance_signal:      ob?.imbalance_signal ?? null,

    tf_conflict: context.timeframe_analysis?.conflict ?? null,

    action:               structured.action ?? null,
    confidence:           structured.confidence ?? null,
    risk_score:           structured.risk_score ?? null,
    conviction:           structured.conviction ?? null,
    primary_driver:       structured.primary_driver ?? null,
    has_executable_setup: structured.has_executable_setup ? 1 : 0,
    // El veto del backend ya se impuso sobre `structured` en applyDecisionGates (antes de
    // validar), así que aquí basta con persistir el flag tal cual — ya es autoritativo.
    gating_active:        structured.gating_active ? 1 : 0,
    gating_reason:        structured.gating_reason ?? null,
    contradictions_found: structured.contradictions_found ? 1 : 0,
    missing_confirmations: Array.isArray(structured.missing_confirmations) && structured.missing_confirmations.length > 0
      ? JSON.stringify(structured.missing_confirmations)
      : null,
    // Contradicciones deterministas del backend (utils/gating.js) — telemetría separada
    // del booleano contradictions_found del LLM. Persistimos conteo + códigos.
    contradiction_count: context.gating?.contradiction_count ?? null,
    // OJO: esta lista es POST-dedupe. Lo que el veto absorbió va en `deduped_by_veto`.
    contradiction_codes: Array.isArray(context.gating?.contradictions) && context.gating.contradictions.length > 0
      ? JSON.stringify(context.gating.contradictions.map((c) => c.code))
      : null,
    // Códigos que el veto absorbió (desaparecen de `contradiction_codes` al activarse) y
    // conteo crudo sin deduplicar. Juntos permiten reconstruir a posteriori el efecto de
    // cada dedupe, que es lo que el checkpoint necesita para falsar H1.
    deduped_by_veto: Array.isArray(context.gating?.deduped_by_veto) && context.gating.deduped_by_veto.length > 0
      ? JSON.stringify(context.gating.deduped_by_veto)
      : null,
    contradictions_signal_count: context.gating?.contradictions_signal_count ?? null,

    score_derivatives: structured.scores?.derivatives ?? null,
    score_structure:   structured.scores?.structure ?? null,
    score_volume:      structured.scores?.volume ?? null,
    score_onchain:     structured.scores?.onchain ?? null,
    score_total:       structured.scores?.total ?? null,
    // B2: total reproducible desde los componentes del LLM (no el decimal libre del LLM).
    score_total_backend: backendScoreTotal(structured.scores),
    // C2: scores esperados por el backend (guardia de divergencia) — telemetría LLM vs dato.
    score_derivatives_expected: context.expected_scores?.derivatives?.score ?? null,
    score_volume_expected:      context.expected_scores?.volume?.score ?? null,

    setup_entry_price:      setup?.entry_price ?? null,
    setup_stop_price:       setup?.stop_price ?? null,
    setup_tp1_price:        setup?.tp1_price ?? null,
    setup_tp2_price:        setup?.tp2_price ?? null,
    setup_validity_candles: setup?.validity_candles ?? null,
    setup_tf_execution:     setup?.tf_execution ?? null,

    executive_summary: structured.executive_summary ?? null,
    ai_response_full:  null, // se rellena en analyze() con {structured, narrative} (narrative no llega aquí)
    validation_warnings: null, // se rellena en analyze() tras validar (Fase 1: log + flag)

    processing_time_ms: processingMs,
    input_tokens:       ai_metadata.input_tokens ?? null,
    output_tokens:      ai_metadata.output_tokens ?? null,
    model_used:         ai_metadata.model ?? null,
  };
}

/**
 * Builds the array of TF snapshot rows from context.technical.
 */
export function buildTfSnapshots(analysisId, technical) {
  const snapshots = [];
  for (const [tf, data] of Object.entries(technical ?? {})) {
    if (!data) continue;
    const rsi   = data.rsi ?? null;
    const macd  = data.macd ?? null;
    const adx   = data.adx ?? null;
    const st    = data.super_trend ?? null;
    const bb    = data.bollinger_bands ?? null;
    const vd    = data.volume_delta ?? null;
    const cvd   = data.cvd ?? null;
    const vwap  = data.vwap ?? null;
    const stoch = data.stoch_rsi ?? null;
    const wt    = data.wave_trend ?? null;
    const smc   = data.smc ?? null;
    const vp    = data.volume_profile ?? null;

    snapshots.push({
      analysis_id: analysisId,
      tf,

      trend:               data.trend ?? null,
      momentum_alignment:  data.momentum_alignment != null ? (data.momentum_alignment ? 1 : 0) : null,
      regime:              data.regime ?? null,

      rsi_value:           rsi?.value ?? null,
      rsi_signal:          rsi?.signal ?? null,
      rsi_divergence:      data.rsi_divergence?.type ?? null,
      stochrsi_k:          stoch?.k ?? null,
      stochrsi_d:          stoch?.d ?? null,
      stochrsi_signal:     stoch?.signal ?? null,
      macd_histogram:      macd?.histogram ?? null,
      macd_momentum_state: macd?.momentum_state ?? null,
      adx_value:           adx?.adx ?? null,
      adx_trend_direction: adx?.trend_direction ?? null,
      adx_regime:          adx?.regime ?? null,
      supertrend_direction: st?.trend ?? null,
      supertrend_level:     supertrendLevel(st),
      wave_trend_signal:   wt?.signal ?? null,
      bb_position:         bb?.position ?? null,
      bb_width_pct:        bb?.width_pct ?? null,

      volume_delta_buy_pct: vd?.buy_pressure_pct ?? null,
      cvd_trend:            cvd?.trend ?? null,
      cvd_divergence:       cvd?.divergence ?? null,
      // Covariable decisiva: con cvd_strength="marginal" en el TF primario el Volume Flow
      // Score se anula y Comprar/Vender son inalcanzables. Sin persistirla no se puede
      // separar "eligió Esperar" de "no pudo decir otra cosa" (revisión 2026-07-26, C3).
      cvd_strength:            cvd?.cvd_strength ?? null,
      cvd_delta_vs_volume_pct: cvd?.cvd_delta_vs_volume_pct ?? null,
      // Los cortes vigentes en ESTA serie: sin ellos la etiqueta no es auditable a posteriori.
      cvd_strength_pctile:     cvd?.cvd_strength_pctile ?? null,
      cvd_strength_cuts:       Array.isArray(cvd?.cvd_strength_cuts) ? JSON.stringify(cvd.cvd_strength_cuts) : null,
      vwap_trend:           vwap?.trend ?? null,
      vwap_divergence:      vwap?.divergence ?? null,

      bos_direction:    smc?.last_bos?.direction ?? null,
      bos_valid:        smc?.last_bos?.valid != null ? (smc.last_bos.valid ? 1 : 0) : null,
      choch_direction:  smc?.last_choch?.direction ?? null,
      fvg_bullish_count: (smc?.unmitigated_fvgs?.bullish ?? []).length,
      fvg_bearish_count: (smc?.unmitigated_fvgs?.bearish ?? []).length,

      nearest_support_pct:         data.distance_to_nearest_support_pct ?? null,
      nearest_resistance_pct:      data.distance_to_nearest_resistance_pct ?? null,
      nearest_support_strength:    data.nearest_support_strength ?? null,
      nearest_resistance_strength: data.nearest_resistance_strength ?? null,

      vp_poc_distance_pct: vp?.poc_distance_pct ?? null,
      vp_valid:            vp?.valid != null ? (vp.valid ? 1 : 0) : null,
    });
  }
  return snapshots;
}

/**
 * Distancia con signo (%) del precio al borde más cercano de una zona FVG.
 *   precio por ENCIMA de la zona → negativo (hay que caer para rellenarla)
 *   precio por DEBAJO de la zona → positivo (hay que subir)
 *   precio DENTRO de la zona     → 0 (mitigándose ahora)
 * Función pura, exportada para test.
 * @returns {number|null}
 */
export function fvgDistancePct(price, low, high) {
  if (price == null || low == null || high == null || !price) return null;
  if (price > high) return parseFloat(((high - price) / price * 100).toFixed(2));
  if (price < low)  return parseFloat(((low  - price) / price * 100).toFixed(2));
  return 0;
}

/**
 * Builds the FVG snapshot rows from context.technical[tf].smc.unmitigated_fvgs.
 *
 * Cierra la deuda §6: el TF snapshot solo guardaba el conteo, así que a posteriori no se
 * podía comprobar si el precio llegó a rellenar el gap (la tesis del FVG como imán). Aquí
 * persistimos la geometría de cada uno: zona, tamaño, mitigación, antigüedad, signal_status
 * y distancia al precio en el momento del análisis.
 *
 * @param {string} analysisId
 * @param {object} technical - context.technical (por TF)
 * @param {number|null} currentPrice
 */
export function buildFvgRows(analysisId, technical, currentPrice) {
  const rows = [];
  for (const [tf, data] of Object.entries(technical ?? {})) {
    const fvgs = data?.smc?.unmitigated_fvgs;
    if (!fvgs) continue;

    for (const type of ['bullish', 'bearish']) {
      const list = fvgs[type] ?? [];
      list.forEach((f, rank) => {
        rows.push({
          analysis_id:    analysisId,
          tf,
          fvg_type:       type,
          fvg_rank:       rank,           // 0 = más reciente (detectUnmitigatedFVGs ya los ordena)
          zone_low:       f.low ?? null,
          zone_high:      f.high ?? null,
          size_pct:       f.size_pct ?? null,
          mitigation_pct: f.mitigation_pct ?? null,
          candles_ago:    f.candles_ago ?? null,
          signal_status:  f.signal_status ?? null,
          formed_t:       f.t_right ?? null,
          distance_pct:   fvgDistancePct(currentPrice, f.low, f.high),
        });
      });
    }
  }
  return rows;
}

/**
 * Builds the liquidation cluster rows from context.derivatives.liquidation_clusters.
 */
function buildClusterRows(analysisId, liquidationClusters) {
  const rows = [];
  if (!liquidationClusters) return rows;

  for (const type of ['long', 'short']) {
    const clusters = liquidationClusters[`top_${type}_clusters`] ?? [];
    clusters.slice(0, 5).forEach((c, rank) => {
      rows.push({
        analysis_id:  analysisId,
        cluster_type: type,
        cluster_rank: rank,
        price:        c.price ?? null,
        total_usd:    c.total_usd ?? null,
        distance_pct: c.distance_pct ?? null,
      });
    });
  }
  return rows;
}

export async function analyze(req, res, next) {
  const start = Date.now();

  try {
    const { coin: rawCoin = 'BTC', primary_tf: primaryTf = '4h', model } = req.body ?? {};
    const coin = String(rawCoin).toUpperCase();

    if (!COINS.includes(coin)) {
      throw new ValidationError(`coin must be one of: ${COINS.join(', ')}`);
    }
    if (!TIMEFRAMES.includes(primaryTf)) {
      throw new ValidationError(`primary_tf must be one of: ${TIMEFRAMES.join(', ')}`);
    }

    const context = await buildAnalyzeContext(coin, primaryTf);

    logger.info({ coin, primaryTf, model }, 'POST /api/analyze — calling Anthropic');

    // `model` viene del desplegable del frontend; analyzeMarket lo valida contra la
    // whitelist (ANALYSIS_MODELS) y cae al default si no es válido.
    const { structured: rawStructured, narrative, ai_metadata } = await analyzeMarket(context, model);

    // Puertas de decisión sobre el output crudo (§6.4 + HARD GATING). Los hard gates del
    // backend (veto determinista + conviction decay >=3) fuerzan Esperar SIEMPRE; las demás
    // violaciones de reglas del prompt degradan solo con el fail-safe activo (flag de
    // observación). Ver services/decisionGates.js.
    const { structured, validation, degraded } = applyDecisionGates(
      rawStructured,
      context.gating,
      env.analysisFailsafeEnabled,
      env.gatingFailClosedOnMissing,
      context.expected_scores,
      context.price_current,
    );
    if (validation.warnings.length > 0) {
      logger.warn(
        { coin, action: rawStructured.action, hasSevere: validation.hasSevere, warnings: validation.warnings },
        'POST /api/analyze — output del LLM viola reglas del prompt',
      );
    }
    if (degraded) {
      logger.warn(
        { coin, original_action: rawStructured.action, rules: structured.fail_safe_rules },
        'POST /api/analyze — FAIL-SAFE aplicado: acción degradada a Esperar',
      );
    }

    const processingMs = Date.now() - start;
    const id = uuidv4();

    const header = buildAnalysisHeader(id, coin, primaryTf, context, structured, ai_metadata, processingMs);
    // Guardamos el structured final (ya con fail-safe si aplicó) junto al narrative.
    header.ai_response_full = JSON.stringify({ structured, narrative });
    header.validation_warnings = validation.warnings.length > 0 ? JSON.stringify(validation.warnings) : null;

    const tfSnapshots = buildTfSnapshots(id, context.technical);
    const clusters    = buildClusterRows(id, context.derivatives?.liquidation_clusters);
    const fvgs        = buildFvgRows(id, context.technical, context.price_current);

    saveAnalysis({ header, tfSnapshots, clusters, fvgs });

    logger.info({ coin, action: structured.action, confidence: structured.confidence, ms: processingMs }, 'POST /api/analyze — done');

    res.json({
      meta: {
        request_id: uuidv4(),
        timestamp: new Date().toISOString(),
        processing_time_ms: processingMs,
        version: '1.0',
      },
      coin,
      price_current: context.price_current,
      price_change_24h_pct: context.price_change_24h_pct,
      primary_tf: primaryTf,
      structured,
      narrative,
      ai_metadata,
    });

  } catch (err) {
    next(err);
  }
}

export async function analyzePayload(req, res, next) {
  try {
    const { coin: rawCoin = 'BTC', primary_tf: primaryTfQuery, tf: tfQuery } = req.query ?? {};
    const primaryTf = String(primaryTfQuery ?? tfQuery ?? '4h');
    const coin = String(rawCoin).toUpperCase();

    if (!COINS.includes(coin)) {
      throw new ValidationError(`coin must be one of: ${COINS.join(', ')}`);
    }
    if (!TIMEFRAMES.includes(primaryTf)) {
      throw new ValidationError(`primary_tf must be one of: ${TIMEFRAMES.join(', ')}`);
    }

    const context = await buildAnalyzeContext(coin, primaryTf);

    res.json({
      meta: {
        request_id: uuidv4(),
        timestamp: new Date().toISOString(),
        version: '1.0',
      },
      payload: context,
      // Request exacto que se remitiría al LLM (system prompt + user message con el
      // dataset serializado). Permite descargar desde el frontend el prompt completo.
      llm_request: buildLlmRequest(context),
    });
  } catch (err) {
    next(err);
  }
}
