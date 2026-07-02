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
import { findEntryByDaysAgo, seriesHasGap } from '../utils/timeSeries.js';
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
function computeLevelDistances(price, supports, resistances) {
  let distToSupport = null;
  let distToResistance = null;

  if (supports?.length > 0) {
    const nearestSupport = supports[0]; // Ya ordenado (mayor primero)
    distToSupport = parseFloat(((price - nearestSupport.price) / price * 100).toFixed(2));
  }

  if (resistances?.length > 0) {
    const nearestResistance = resistances[0]; // Ya ordenado (menor primero)
    distToResistance = parseFloat(((nearestResistance.price - price) / price * 100).toFixed(2));
  }

  return {
    distance_to_nearest_support_pct: distToSupport,
    distance_to_nearest_resistance_pct: distToResistance,
  };
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
function analyzeTimeframeConflicts(technical, primaryTf) {
  if (!technical || Object.keys(technical).length === 0) return null;

  const trends = {};
  for (const [tf, data] of Object.entries(technical)) {
    trends[tf] = data?.trend ?? null;
  }

  // Detectar conflictos: corto plazo vs largo plazo divergen
  const shortTermTrend = trends['1h'] || trends['4h'];
  const longTermTrend = trends['1D'] || trends['1W'];

  let conflict = null;
  if (shortTermTrend && longTermTrend) {
    const shortBullish = shortTermTrend.includes('bullish');
    const longBullish = longTermTrend.includes('bullish');
    if (shortBullish !== longBullish) {
      conflict = shortBullish ? 'short_term_bullish_long_term_bearish' : 'short_term_bearish_long_term_bullish';
    }
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
      trend_30d:  (fgHistory.at(-1)?.value ?? 0) > (thirtyDaysEntry?.value ?? 0) ? 'improving' : 'deteriorating',
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
      // `funding_rate.severity` (top-level), que se calcula sobre el valor live.
      severity_last_candle: latestClose > 0.5 ? 'extreme' : latestClose > 0.2 ? 'high' : latestClose > 0.05 ? 'elevated' : 'normal',
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
    openInterestSummary = {
      open_7d_usd:    open7d,
      current_usd:    close7d,
      high_7d_usd:    has7d ? Math.max(...oiHistory.map(e => e.h)) : null,
      low_7d_usd:     has7d ? Math.min(...oiHistory.map(e => e.l)) : null,
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
    const open7dLong  = lsHistory.at(0)?.long_pct ?? null;
    const close7dLong = lsHistory.at(-1)?.long_pct ?? null;
    const change7d    = open7dLong !== null ? close7dLong - open7dLong : null;
    longShortSummary = {
      current_long_pct:   close7dLong,
      current_short_pct:  lsHistory.at(-1)?.short_pct ?? null,
      open_7d_long_pct:   open7dLong,
      change_7d_long_pct: change7d !== null ? parseFloat(change7d.toFixed(2)) : null,
      avg_7d_long_pct:    parseFloat((longPcts.reduce((s, v) => s + v, 0) / longPcts.length).toFixed(2)),
      max_7d_long_pct:    Math.max(...longPcts),
      min_7d_long_pct:    Math.min(...longPcts),
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
  const cvdHistory = histories?.cvd ?? [];
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
    const periodMin = Math.min(...values);
    const periodMax = Math.max(...values);
    cvdSummary = {
      current_value:      current.value,
      current_trend:      current.trend,
      current_divergence: current.divergence,
      change_pct_24h:     pctChange(ref24h, current),
      change_pct_7d:      pctChange(ref7d, current),
      change_pct_30d:     gapped ? null : pctChange(ref30d, current),
      high_7d:            periodMax,
      low_7d:             periodMin,
      period_min:         periodMin,
      period_max:         periodMax,
      trend_30d:          gapped ? null : computeLinearTrend(values),
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
  const oiNotExpanding = openInterestSummary?.trend_7d == null || openInterestSummary.trend_7d !== 'increasing';
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

  // D22: fuente del precio de referencia
  const priceSource = 'binance_spot';
  const priceTimestampUtc = new Date().toISOString();

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

    timeframe_analysis: tfConflicts,

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
        value_usd:      oi.value_usd,
        change_24h_pct: oi.change_24h_pct,
        signal:         oi.signal,
        history:        openInterestSummary,
        data_timestamp_utc: oi.data_timestamp_utc ?? null,
      } : null,

      long_short_ratio: lsr ? {
        long_pct:  lsr.long_pct,
        short_pct: lsr.short_pct,
        signal:    lsr.signal,
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
    oi_value_usd:              oi?.value_usd ?? null,
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
    gating_active:        structured.gating_active ? 1 : 0,
    gating_reason:        structured.gating_reason ?? null,
    contradictions_found: structured.contradictions_found ? 1 : 0,

    score_derivatives: structured.scores?.derivatives ?? null,
    score_structure:   structured.scores?.structure ?? null,
    score_volume:      structured.scores?.volume ?? null,
    score_onchain:     structured.scores?.onchain ?? null,
    score_total:       structured.scores?.total ?? null,

    setup_entry_price:      setup?.entry_price ?? null,
    setup_stop_price:       setup?.stop_price ?? null,
    setup_tp1_price:        setup?.tp1_price ?? null,
    setup_tp2_price:        setup?.tp2_price ?? null,
    setup_validity_candles: setup?.validity_candles ?? null,
    setup_tf_execution:     setup?.tf_execution ?? null,

    executive_summary: structured.executive_summary ?? null,
    ai_response_full:  JSON.stringify({ structured, narrative: structured._narrative }),

    processing_time_ms: processingMs,
    input_tokens:       ai_metadata.input_tokens ?? null,
    output_tokens:      ai_metadata.output_tokens ?? null,
    model_used:         ai_metadata.model ?? null,
  };
}

/**
 * Builds the array of TF snapshot rows from context.technical.
 */
function buildTfSnapshots(analysisId, technical) {
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
      wave_trend_signal:   wt?.signal ?? null,
      bb_position:         bb?.position ?? null,
      bb_width_pct:        bb?.width_pct ?? null,

      volume_delta_buy_pct: vd?.buy_pressure_pct ?? null,
      cvd_trend:            cvd?.trend ?? null,
      cvd_divergence:       cvd?.divergence ?? null,
      vwap_trend:           vwap?.trend ?? null,
      vwap_divergence:      vwap?.divergence ?? null,

      bos_direction:    smc?.last_bos?.direction ?? null,
      bos_valid:        smc?.last_bos?.valid != null ? (smc.last_bos.valid ? 1 : 0) : null,
      choch_direction:  smc?.last_choch?.direction ?? null,
      fvg_bullish_count: (smc?.unmitigated_fvgs?.bullish ?? []).length,
      fvg_bearish_count: (smc?.unmitigated_fvgs?.bearish ?? []).length,

      nearest_support_pct:    data.distance_to_nearest_support_pct ?? null,
      nearest_resistance_pct: data.distance_to_nearest_resistance_pct ?? null,

      vp_poc_distance_pct: vp?.poc_distance_pct ?? null,
      vp_valid:            vp?.valid != null ? (vp.valid ? 1 : 0) : null,
    });
  }
  return snapshots;
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
    const { coin: rawCoin = 'BTC', primary_tf: primaryTf = '4h' } = req.body ?? {};
    const coin = String(rawCoin).toUpperCase();

    if (!COINS.includes(coin)) {
      throw new ValidationError(`coin must be one of: ${COINS.join(', ')}`);
    }
    if (!TIMEFRAMES.includes(primaryTf)) {
      throw new ValidationError(`primary_tf must be one of: ${TIMEFRAMES.join(', ')}`);
    }

    const context = await buildAnalyzeContext(coin, primaryTf);

    logger.info({ coin, primaryTf }, 'POST /api/analyze — calling Anthropic');

    const { structured, narrative, ai_metadata } = await analyzeMarket(context);

    const processingMs = Date.now() - start;
    const id = uuidv4();

    const header = buildAnalysisHeader(id, coin, primaryTf, context, structured, ai_metadata, processingMs);
    // Store narrative inside ai_response_full
    header.ai_response_full = JSON.stringify({ structured, narrative });

    const tfSnapshots = buildTfSnapshots(id, context.technical);
    const clusters    = buildClusterRows(id, context.derivatives?.liquidation_clusters);

    saveAnalysis({ header, tfSnapshots, clusters });

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
