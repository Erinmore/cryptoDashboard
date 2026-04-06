import { fetchOHLC, fetchCurrentPrice, fetchBTCDominance } from '../services/coingeckoService.js';
import { fetchFearGreed } from '../services/fearGreedService.js';
import { fetchDerivativesData } from '../services/coinalyzeService.js';
import { computeIndicators } from '../services/indicatorService.js';
import { getLastAnalysis, saveAnalysis } from '../services/dbService.js';
import { analyzeMarket } from '../services/anthropicService.js';
import { COINS, TIMEFRAMES } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../middleware/logger.js';

async function buildAnalyzeContext(coin, primaryTf) {
  logger.info({ coin, primaryTf }, 'Building analysis payload');

  const [
    ohlc1h,
    ohlc4h,
    ohlc1D,
    priceResult,
    fearGreedResult,
    derivativesResult,
    btcDominanceResult,
    lastAnalysisResult,
  ] = await Promise.allSettled([
    fetchOHLC(coin, '1h'),
    fetchOHLC(coin, '4h'),
    fetchOHLC(coin, '1D'),
    fetchCurrentPrice(coin),
    fetchFearGreed(),
    fetchDerivativesData(coin),
    fetchBTCDominance(),
    Promise.resolve(getLastAnalysis(coin)),
  ]);

  const resolve = (result) => (result.status === 'fulfilled' ? result.value : null);

  const candles = {
    '1h': resolve(ohlc1h),
    '4h': resolve(ohlc4h),
    '1D': resolve(ohlc1D),
  };

  const technical = {};
  for (const tf of TIMEFRAMES) {
    if (candles[tf]?.length) {
      technical[tf] = computeIndicators(candles[tf], tf);
    }
  }

  return {
    coin,
    primary_tf: primaryTf,
    price_current: resolve(priceResult)?.price ?? null,
    price_change_24h_pct: resolve(priceResult)?.change_24h_pct ?? null,
    technical,
    fear_greed: resolve(fearGreedResult),
    derivatives: resolve(derivativesResult),
    btc_dominance: resolve(btcDominanceResult),
    last_analysis: resolve(lastAnalysisResult),
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

    // Lanza AppError 503/501 si Anthropic no está configurado o implementado
    const { recommendation, ai_metadata } = await analyzeMarket(context);

    const processingMs = Date.now() - start;
    const id = uuidv4();

    // Extraer métricas del TF principal para persistencia en SQLite
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
