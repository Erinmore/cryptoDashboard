import { fetchOHLC, fetchCurrentPrice, fetchGlobalMarketData, fetchCoinMarketData } from '../services/coingeckoService.js';
import { fetchFearGreed } from '../services/fearGreedService.js';
import { fetchDerivativesData, withDerivedOiUsd, withDerivedLiqUsd } from '../services/coinalyzeService.js';
import { fetchOrderBookWalls, fetchBinanceTicker } from '../services/binanceOrderBookService.js';
import { getHistories, addCVDEntry, addVWAPEntry } from '../services/historyService.js';
import { computeIndicators } from '../services/indicatorService.js';
import { getLastAnalysis } from '../services/dbService.js';
import { COINS, TIMEFRAMES } from '../config/constants.js';
import { ValidationError } from '../utils/errors.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../middleware/logger.js';

import { COINALYZE_SYMBOLS } from '../config/constants.js';

/** Parsea `ai_response_full` (JSON string) a {structured, narrative}; null si falta o es inválido. */
function parseAiResponseFull(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.structured ? parsed : null;
  } catch {
    return null;
  }
}


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
    // getLastAnalysis va DENTRO del Promise.allSettled → hay que desenvolverlo con
    // resolve() como el resto; usarlo crudo dejaba `last_analysis: {}` (campos undefined).
    const lastAnalysisRow = resolve(lastAnalysis);

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

    // Poblar históricos CVD/VWAP desde indicadores 1D
    const today = new Date().toISOString().split('T')[0];
    const cvdIndicator = technical['1D']?.cvd;
    const vwapIndicator = technical['1D']?.vwap;

    if (cvdIndicator) {
      addCVDEntry(coin, today, cvdIndicator.value, cvdIndicator.trend, cvdIndicator.divergence, cvdIndicator.last_candle_delta);
    }

    if (vwapIndicator) {
      addVWAPEntry(coin, today, vwapIndicator.value, vwapIndicator.trend, vwapIndicator.divergence);
    }

    // Una sola llamada final a getHistories() — incluye las entradas recién añadidas
    const processingMs = Date.now() - start;
    const histories = getHistories(coin);

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
      // OI: Coinalyze lo da en monedas base; se deriva el USD real para el sidebar
      // (antes value_usd traía monedas etiquetadas como USD — auditoría #2, hallazgo 4).
      // Coinalyze reporta OI **y liquidaciones** en monedas base: ambos USD se DERIVAN del
      // spot. Faltaba el de liquidaciones (2026-07-29) y el sidebar hacía `longs_usd.toFixed()`
      // sobre undefined → excepción en `updateSentiment` → y como `renderChart()` es lo último
      // de `updateUI`, el GRÁFICO dejaba de dibujarse. Un contrato de datos cambiado con dos
      // consumidores y solo uno actualizado.
      derivatives: withDerivedLiqUsd(withDerivedOiUsd(resolve(derivatives), price?.price), price?.price),
      global_market: resolve(globalMarket),
      btc_dominance: resolve(globalMarket)?.btc_dominance ?? null,
      coin_market_data: resolve(coinMarketData),
      // Columnas del schema nuevo: `action`/`confidence` (antes recommendation_*,
      // renombradas en el Sprint Schema → por eso "Análisis Previo" salía "—").
      last_analysis: lastAnalysisRow ? {
        timestamp: lastAnalysisRow.timestamp,
        action: lastAnalysisRow.action,
        confidence: lastAnalysisRow.confidence,
        // Análisis completo {structured, narrative} para hidratar el panel "Análisis IA"
        // en cualquier dispositivo (el panel rico vivía solo en localStorage del navegador
        // que lo lanzó → no se veía en la Pi). Se parsea aquí; null si falta o no parsea.
        full: parseAiResponseFull(lastAnalysisRow.ai_response_full),
      } : null,
      binance_walls: resolve(binanceWalls),
      binance_ticker: resolve(binanceTicker),
      history: histories,
    });
  } catch (err) {
    next(err);
  }
}
