import { fetchOHLC, fetchCurrentPrice, fetchBTCDominance } from '../services/coingeckoService.js';
import { fetchSentiment } from '../services/cryptopanicService.js';
import { fetchFearGreed } from '../services/fearGreedService.js';
import { fetchDerivativesData } from '../services/coinalyzeService.js';
import { fetchOrderBookWalls } from '../services/binanceOrderBookService.js';
import { getHistories } from '../services/historyService.js';
import { computeIndicators } from '../services/indicatorService.js';
import { getLastAnalysis } from '../services/dbService.js';
import { COINS, TIMEFRAMES } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../middleware/logger.js';

export async function getData(req, res, next) {
  const start = Date.now();

  try {
    const coin = (req.query.coin ?? 'BTC').toUpperCase();
    const primaryTf = req.query.tf ?? '4h';

    if (!COINS.includes(coin)) {
      throw new ValidationError(`coin must be one of: ${COINS.join(', ')}`);
    }
    if (!TIMEFRAMES.includes(primaryTf)) {
      throw new ValidationError(`tf must be one of: ${TIMEFRAMES.join(', ')}`);
    }

    logger.debug({ coin, primaryTf }, 'GET /api/data');

    // Mapeo de coins a símbolos Binance
    const binanceSymbols = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };

    // Fetch todo en paralelo
    const [
      ohlc15m,
      ohlc1h,
      ohlc4h,
      ohlc8h,
      ohlc1D,
      priceData,
      sentiment,
      fearGreed,
      derivatives,
      btcDominance,
      lastAnalysis,
      binanceWalls,
    ] = await Promise.allSettled([
      fetchOHLC(coin, '15m'),
      fetchOHLC(coin, '1h'),
      fetchOHLC(coin, '4h'),
      fetchOHLC(coin, '8h'),
      fetchOHLC(coin, '1D'),
      fetchCurrentPrice(coin),
      fetchSentiment(coin),
      fetchFearGreed(),
      fetchDerivativesData(coin),
      fetchBTCDominance(),
      Promise.resolve(getLastAnalysis(coin)),
      fetchOrderBookWalls(binanceSymbols[coin]),
    ]);

    // Extraer valores, los fallos devuelven null
    const resolve = r => r.status === 'fulfilled' ? r.value : null;

    const candles = {
      '15m': resolve(ohlc15m),
      '1h':  resolve(ohlc1h),
      '4h':  resolve(ohlc4h),
      '8h':  resolve(ohlc8h),
      '1D':  resolve(ohlc1D),
    };

    const price = resolve(priceData);

    // Calcular indicadores por timeframe
    const technical = {};
    for (const tf of TIMEFRAMES) {
      if (candles[tf]?.length) {
        technical[tf] = computeIndicators(candles[tf], tf);
      }
    }

    const processingMs = Date.now() - start;
    const histories = getHistories();

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
      candles: candles[primaryTf] ?? null,
      technical,
      sentiment: resolve(sentiment),
      fear_greed: resolve(fearGreed),
      derivatives: resolve(derivatives),
      btc_dominance: resolve(btcDominance),
      last_analysis: lastAnalysis ? {
        timestamp: lastAnalysis.timestamp,
        action: lastAnalysis.recommendation_action,
        confidence: lastAnalysis.recommendation_confidence,
      } : null,
      binance_walls: resolve(binanceWalls),
      history: histories,
    });
  } catch (err) {
    next(err);
  }
}
