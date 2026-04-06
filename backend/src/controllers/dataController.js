import { fetchOHLC, fetchCurrentPrice, fetchGlobalMarketData, fetchCoinMarketData } from '../services/coingeckoService.js';
import { fetchFearGreed } from '../services/fearGreedService.js';
import { fetchDerivativesData } from '../services/coinalyzeService.js';
import { fetchOrderBookWalls, fetchBinanceTicker } from '../services/binanceOrderBookService.js';
import { getHistories, addCVDEntry, addVWAPEntry } from '../services/historyService.js';
import { computeIndicators } from '../services/indicatorService.js';
import { getLastAnalysis } from '../services/dbService.js';
import { COINS, TIMEFRAMES } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../middleware/logger.js';

import { COINALYZE_SYMBOLS } from '../config/constants.js';


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
      ohlc1h,
      ohlc4h,
      ohlc1D,
      ohlc1W,
      priceData,
      fearGreed,
      derivatives,
      globalMarket,
      lastAnalysis,
      binanceWalls,
      coinMarketData,
      binanceTicker,
    ] = await Promise.allSettled([
      fetchOHLC(coin, '1h'),
      fetchOHLC(coin, '4h'),
      fetchOHLC(coin, '1D'),
      fetchOHLC(coin, '1W'),
      fetchCurrentPrice(coin),
      fetchFearGreed(),
      fetchDerivativesData(coin),
      fetchGlobalMarketData(),
      Promise.resolve(getLastAnalysis(coin)),
      fetchOrderBookWalls(binanceSymbols[coin]),
      fetchCoinMarketData(coin),
      fetchBinanceTicker(binanceSymbols[coin]),
    ]);

    // Extraer valores, los fallos devuelven null
    const resolve = r => r.status === 'fulfilled' ? r.value : null;

    const candles = {
      '1h': resolve(ohlc1h),
      '4h': resolve(ohlc4h),
      '1D': resolve(ohlc1D),
      '1W': resolve(ohlc1W),
    };

    const price = resolve(priceData);

    // Calcular indicadores por timeframe
    const technical = {};
    for (const tf of TIMEFRAMES) {
      if (candles[tf]?.length) {
        technical[tf] = computeIndicators(candles[tf], tf);
      }
    }

    // Leer histórico previo ANTES de agregar nuevas entradas (para calcular change_pct_7d)
    const prevHistories = getHistories();

    // Poblar históricos CVD/VWAP desde indicadores 1D
    const today = new Date().toISOString().split('T')[0];
    const cvdIndicator = technical['1D']?.cvd;
    const vwapIndicator = technical['1D']?.vwap;

    if (cvdIndicator) {
      const cvdPrev7d = prevHistories.cvd.length >= 7
        ? prevHistories.cvd[prevHistories.cvd.length - 7]
        : null;
      const cvdChange7d = (cvdPrev7d?.value != null && cvdPrev7d.value !== 0)
        ? parseFloat(((cvdIndicator.value - cvdPrev7d.value) / Math.abs(cvdPrev7d.value) * 100).toFixed(2))
        : null;
      addCVDEntry(today, cvdIndicator.value, cvdIndicator.trend, cvdIndicator.divergence, cvdChange7d);
    }

    if (vwapIndicator) {
      const vwapPrev7d = prevHistories.vwap.length >= 7
        ? prevHistories.vwap[prevHistories.vwap.length - 7]
        : null;
      const vwapChange7d = (vwapPrev7d?.value != null && vwapPrev7d.value !== 0)
        ? parseFloat(((vwapIndicator.value - vwapPrev7d.value) / Math.abs(vwapPrev7d.value) * 100).toFixed(2))
        : null;
      addVWAPEntry(today, vwapIndicator.value, vwapIndicator.trend, vwapIndicator.divergence, vwapChange7d);
    }

    // Una sola llamada final a getHistories() — incluye las entradas recién añadidas
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
      fear_greed: resolve(fearGreed),
      derivatives: resolve(derivatives),
      global_market: resolve(globalMarket),
      btc_dominance: resolve(globalMarket)?.btc_dominance ?? null,
      coin_market_data: resolve(coinMarketData),
      last_analysis: lastAnalysis ? {
        timestamp: lastAnalysis.timestamp,
        action: lastAnalysis.recommendation_action,
        confidence: lastAnalysis.recommendation_confidence,
      } : null,
      binance_walls: resolve(binanceWalls),
      binance_ticker: resolve(binanceTicker),
      history: histories,
    });
  } catch (err) {
    next(err);
  }
}
