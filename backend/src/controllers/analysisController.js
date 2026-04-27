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
import { analyzeMarket } from '../services/anthropicService.js';
import { COINS, TIMEFRAMES } from '../config/constants.js';
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

function computeHistorySummaries(histories) {
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
    const closes = frHistory.map(e => e.c);
    const positiveCount = closes.filter(v => v > 0).length;
    const latestClose = frHistory.at(-1)?.c ?? 0;
    fundingRateSummary = {
      open_48h:             frHistory.at(0)?.o ?? null,
      close_current:        frHistory.at(-1)?.c ?? null,
      high_48h:             Math.max(...frHistory.map(e => e.h)),
      low_48h:              Math.min(...frHistory.map(e => e.l)),
      trend_48h:            frHistory.at(-1)?.trend ?? null,
      pct_candles_positive: Math.round((positiveCount / closes.length) * 100),
      severity_current:     latestClose > 0.5 ? 'extreme' : latestClose > 0.2 ? 'high' : latestClose > 0.05 ? 'elevated' : 'normal',
    };
  }

  // ── Open Interest summary (7d) ──────────────────────────────────────────
  const oiHistory = histories?.open_interest ?? [];
  let openInterestSummary = null;
  if (oiHistory.length >= 1) {
    const open7d  = oiHistory.at(0)?.o ?? null;
    const close7d = oiHistory.at(-1)?.c ?? null;
    const change7dPct = open7d ? ((close7d - open7d) / open7d) * 100 : null;
    const last6 = oiHistory.slice(-6); // ~24h en candles de 4h
    const last6Open  = last6.at(0)?.o ?? null;
    const last6Close = last6.at(-1)?.c ?? null;
    const change24hPct = last6Open ? ((last6Close - last6Open) / last6Open) * 100 : null;
    openInterestSummary = {
      open_7d_usd:    open7d,
      current_usd:    close7d,
      high_7d_usd:    Math.max(...oiHistory.map(e => e.h)),
      low_7d_usd:     Math.min(...oiHistory.map(e => e.l)),
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
    const totalLongs  = liqHistory.reduce((s, e) => s + e.longs_usd, 0);
    const totalShorts = liqHistory.reduce((s, e) => s + e.shorts_usd, 0);
    const last24h     = liqHistory.at(-1);
    const n = liqHistory.length;
    const recent3Avg = liqHistory.slice(-3).reduce((s, e) => s + e.longs_usd + e.shorts_usd, 0) / Math.min(n, 3);
    const older3Avg  = liqHistory.slice(0, 3).reduce((s, e)  => s + e.longs_usd + e.shorts_usd, 0) / Math.min(n, 3);
    const trendRatio = older3Avg > 0 ? recent3Avg / older3Avg : null;
    liquidationsSummary = {
      last_24h_longs_usd:         last24h?.longs_usd  ?? null,
      last_24h_shorts_usd:        last24h?.shorts_usd ?? null,
      last_24h_total_usd:         last24h ? last24h.longs_usd + last24h.shorts_usd : null,
      '7d_total_longs_usd':       parseFloat(totalLongs.toFixed(2)),
      '7d_total_shorts_usd':      parseFloat(totalShorts.toFixed(2)),
      '7d_avg_daily_longs_usd':   parseFloat((totalLongs / n).toFixed(2)),
      '7d_avg_daily_shorts_usd':  parseFloat((totalShorts / n).toFixed(2)),
      longs_vs_shorts_7d_ratio:   totalShorts > 0 ? parseFloat((totalLongs / totalShorts).toFixed(2)) : null,
      trend_7d: trendRatio === null ? null : trendRatio > 1.3 ? 'escalating' : trendRatio < 0.7 ? 'decreasing' : 'stable',
    };
  }

  // ── CVD summary (30d) ───────────────────────────────────────────────────
  const cvdHistory = histories?.cvd ?? [];
  let cvdSummary = null;
  if (cvdHistory.length >= 1) {
    const values = cvdHistory.map(e => e.value);
    const current = cvdHistory.at(-1);
    const first = cvdHistory.at(0);
    // Use 7d ago if available, else use first available data point
    const refPoint = cvdHistory.length >= 7 ? cvdHistory[cvdHistory.length - 7] : first;
    const change7dPct = (refPoint?.value != null && current.value != null && refPoint.value !== 0)
      ? parseFloat(((current.value - refPoint.value) / Math.abs(refPoint.value) * 100).toFixed(2))
      : null;
    const change30dPct = (first?.value != null && first.value !== 0)
      ? parseFloat(((current.value - first.value) / Math.abs(first.value) * 100).toFixed(2))
      : null;
    cvdSummary = {
      current_value:      current.value,
      current_trend:      current.trend,
      current_divergence: current.divergence,
      change_pct_7d:      change7dPct,
      change_pct_30d:     change30dPct,
      period_min:         Math.min(...values),
      period_max:         Math.max(...values),
      trend_30d:          computeLinearTrend(values),
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
    const first = vwapHistory.at(0);
    // Use 7d ago if available, else use first available data point
    const refPoint = vwapHistory.length >= 7 ? vwapHistory[vwapHistory.length - 7] : first;
    const change7dPct = (refPoint?.value != null && current.value != null && refPoint.value !== 0)
      ? parseFloat(((current.value - refPoint.value) / Math.abs(refPoint.value) * 100).toFixed(2))
      : null;
    const change30dPct = (first?.value != null && first.value !== 0)
      ? parseFloat(((current.value - first.value) / Math.abs(first.value) * 100).toFixed(2))
      : null;
    vwapSummary = {
      current_value:      current.value,
      current_trend:      current.trend,
      current_divergence: current.divergence,
      change_pct_7d:      change7dPct,
      change_pct_30d:     change30dPct,
      period_min:         Math.min(...values),
      period_max:         Math.max(...values),
      trend_30d:          computeLinearTrend(values),
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

  const histories = getHistories();
  const { fearGreedSummary, fundingRateSummary, openInterestSummary, longShortSummary, liquidationsSummary, cvdSummary, vwapSummary } =
    computeHistorySummaries(histories);

  const fr  = derivatives?.funding_rate    ?? null;
  const oi  = derivatives?.open_interest   ?? null;
  const lsr = derivatives?.long_short_ratio ?? null;
  const liq = derivatives?.liquidations    ?? null;
  const tfConflicts = analyzeTimeframeConflicts(technical, primaryTf);

  return {
    coin,
    primary_tf: primaryTf,
    price_current:        currentPrice != null ? parseFloat(currentPrice.toFixed(2)) : null,
    price_change_24h_pct: price?.change_24h_pct != null ? parseFloat(price.change_24h_pct.toFixed(2)) : null,

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
        trend:           fearGreed.trend,
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
        trend:              fr.trend,
        signal:             fr.signal,
        predicted_rate_pct: fr.predicted_rate_pct,
        history:            fundingRateSummary,
      } : null,

      open_interest: oi ? {
        value_usd:      oi.value_usd,
        change_24h_pct: oi.change_24h_pct,
        signal:         oi.signal,
        history:        openInterestSummary,
      } : null,

      long_short_ratio: lsr ? {
        long_pct:  lsr.long_pct,
        short_pct: lsr.short_pct,
        signal:    lsr.signal,
        history:   longShortSummary,
      } : null,

      liquidations_24h: liq ? {
        longs_usd:  liq.longs_usd,
        shorts_usd: liq.shorts_usd,
        total_usd:  liq.total_usd,
        signal:     liq.signal,
        history:    liquidationsSummary,
      } : null,

      liquidation_clusters: liquidationClusters,
    },

    onchain,

    etf_flows: etfFlows,

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

    const { recommendation, ai_metadata } = await analyzeMarket(context);

    const processingMs = Date.now() - start;
    const id = uuidv4();

    const techPrimary = context.technical[primaryTf];

    saveAnalysis({
      id,
      coin,
      primary_tf: primaryTf,
      price_current: context.price_current,
      price_change_24h: context.price_change_24h_pct,
      rsi: techPrimary?.rsi?.value ?? null,
      macd_value: techPrimary?.macd?.value ?? null,
      macd_signal: techPrimary?.macd?.signal ?? null,
      macd_histogram: techPrimary?.macd?.histogram ?? null,
      bb_upper: techPrimary?.bollinger_bands?.upper ?? null,
      bb_middle: techPrimary?.bollinger_bands?.middle ?? null,
      bb_lower: techPrimary?.bollinger_bands?.lower ?? null,
      volume_buy_pct: techPrimary?.volume_delta?.buy_pressure_pct ?? null,
      volume_sell_pct: techPrimary?.volume_delta?.sell_pressure_pct ?? null,
      recommendation: JSON.stringify(recommendation),
      recommendation_action: recommendation.action,
      recommendation_confidence: recommendation.confidence,
      ai_response: JSON.stringify({ recommendation, ai_metadata }),
      processing_time_ms: processingMs,
    });

    logger.info({ coin, action: recommendation.action, confidence: recommendation.confidence, ms: processingMs }, 'POST /api/analyze — done');

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
      recommendation,
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
    });
  } catch (err) {
    next(err);
  }
}
