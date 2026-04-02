import { fetchOHLC, fetchCurrentPrice, fetchBTCDominance } from '../services/coingeckoService.js';
import { fetchSentiment } from '../services/cryptopanicService.js';
import { fetchFearGreed } from '../services/fearGreedService.js';
import { fetchDerivativesData } from '../services/coinalyzeService.js';
import { computeIndicators } from '../services/indicatorService.js';
import { getLastAnalysis, saveAnalysis } from '../services/dbService.js';
import { analyzeMarket } from '../services/anthropicService.js';
import { COINS, TIMEFRAMES } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../middleware/logger.js';

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

    logger.info({ coin, primaryTf }, 'POST /api/analyze — fetching market data');

    // Fetch todo en paralelo (mismo patrón que dataController)
    const [
      ohlc15m,
      ohlc1h,
      ohlc4h,
      priceResult,
      sentimentResult,
      fearGreedResult,
      derivativesResult,
      btcDominanceResult,
      lastAnalysisResult,
    ] = await Promise.allSettled([
      fetchOHLC(coin, '15m'),
      fetchOHLC(coin, '1h'),
      fetchOHLC(coin, '4h'),
      fetchCurrentPrice(coin),
      fetchSentiment(coin),
      fetchFearGreed(),
      fetchDerivativesData(coin),
      fetchBTCDominance(),
      Promise.resolve(getLastAnalysis(coin)),
    ]);

    const resolve = r => r.status === 'fulfilled' ? r.value : null;

    const candles = {
      '15m': resolve(ohlc15m),
      '1h':  resolve(ohlc1h),
      '4h':  resolve(ohlc4h),
    };

    const price      = resolve(priceResult);
    const sentiment  = resolve(sentimentResult);
    const fearGreed  = resolve(fearGreedResult);
    const derivatives = resolve(derivativesResult);
    const btcDominance = resolve(btcDominanceResult);
    const lastAnalysis = resolve(lastAnalysisResult);

    // Calcular indicadores por timeframe
    const technical = {};
    for (const tf of TIMEFRAMES) {
      if (candles[tf]?.length) {
        technical[tf] = computeIndicators(candles[tf], tf);
      }
    }

    // Contexto completo para el prompt de Claude
    const context = {
      coin,
      primary_tf: primaryTf,
      price_current: price?.price ?? null,
      price_change_24h_pct: price?.change_24h_pct ?? null,
      technical,
      sentiment,
      fear_greed: fearGreed,
      derivatives,
      btc_dominance: btcDominance,
      last_analysis: lastAnalysis,
    };

    logger.info({ coin, primaryTf }, 'POST /api/analyze — calling Anthropic');

    // Lanza AppError 503/501 si Anthropic no está configurado o implementado
    const { recommendation, ai_metadata } = await analyzeMarket(context);

    const processingMs = Date.now() - start;
    const id = uuidv4();

    // Extraer métricas del TF principal para persistencia en SQLite
    const techPrimary = technical[primaryTf];

    saveAnalysis({
      id,
      coin,
      primary_tf: primaryTf,
      price_current: price?.price ?? null,
      price_change_24h: price?.change_24h_pct ?? null,
      rsi: techPrimary?.rsi?.value ?? null,
      macd_value: techPrimary?.macd?.value ?? null,
      macd_signal: techPrimary?.macd?.signal ?? null,
      macd_histogram: techPrimary?.macd?.histogram ?? null,
      bb_upper: techPrimary?.bollinger_bands?.upper ?? null,
      bb_middle: techPrimary?.bollinger_bands?.middle ?? null,
      bb_lower: techPrimary?.bollinger_bands?.lower ?? null,
      volume_buy_pct: techPrimary?.volume_delta?.buy_pressure_pct ?? null,
      volume_sell_pct: techPrimary?.volume_delta?.sell_pressure_pct ?? null,
      sentiment_score: sentiment?.score ?? null,
      bullish_votes: sentiment?.bullish_votes ?? null,
      bearish_votes: sentiment?.bearish_votes ?? null,
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
      price_current: price?.price ?? null,
      price_change_24h_pct: price?.change_24h_pct ?? null,
      primary_tf: primaryTf,
      recommendation,
      ai_metadata,
    });

  } catch (err) {
    next(err);
  }
}
