/**
 * binanceOrderBookService.js — Análisis de muros del order book de Binance
 *
 * Integración con API pública de Binance para obtener profundidad (depth)
 * y detectar los mayores "muros" de compra/venta que actúan como resistencia psicológica.
 *
 * Funciones exportadas:
 *   fetchOrderBookWalls(symbol) → { buyWall, sellWall } | null
 */

import axios from 'axios';
import logger from '../middleware/logger.js';

const BINANCE_API_BASE = 'https://api.binance.com/api/v3';
const DEPTH_LIMIT = 20; // Top 20 niveles de bid/ask
const REQUEST_TIMEOUT = 8000; // 8s — tiempo realista para latencia de Binance + carga concurrente

/**
 * Obtiene los mayores muros de compra y venta del order book de Binance,
 * además de spread, top 5 niveles y otros datos de microestructura.
 *
 * @param {string} symbol - Símbolo en Binance (ej: 'BTCUSDT')
 * @returns {Promise<Object|null>} { buyWall, sellWall, spread, spread_pct, bids_top5, asks_top5, timestamp } o null si falla
 */
export async function fetchOrderBookWalls(symbol) {
  if (!symbol) {
    logger.warn('fetchOrderBookWalls: símbolo vacío');
    return null;
  }

  try {
    const response = await axios.get(`${BINANCE_API_BASE}/depth`, {
      params: { symbol, limit: DEPTH_LIMIT },
      timeout: REQUEST_TIMEOUT,
    });

    const { bids, asks } = response.data;

    if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
      logger.warn(`fetchOrderBookWalls: datos inválidos para ${symbol}`);
      return null;
    }

    // Encontrar el muro más grande en los bids (compra)
    const buyWall = findLargestWall(bids);

    // Encontrar el muro más grande en los asks (venta)
    const sellWall = findLargestWall(asks);

    // Calcular spread y porcentaje de spread
    const bestBid = parseFloat(bids[0][0]);
    const bestAsk = parseFloat(asks[0][0]);
    const spread = bestAsk - bestBid;
    const spread_pct = (spread / bestBid) * 100;

    // Top 5 bids y asks con estructura {price, volume}
    const bids_top5 = bids.slice(0, 5).map(([p, v]) => ({
      price: parseFloat(p),
      volume: parseFloat(v),
    }));

    const asks_top5 = asks.slice(0, 5).map(([p, v]) => ({
      price: parseFloat(p),
      volume: parseFloat(v),
    }));

    return {
      buyWall,
      sellWall,
      spread,
      spread_pct,
      bids_top5,
      asks_top5,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.warn(
      `fetchOrderBookWalls error (${symbol}): ${error.message}`,
      { symbol, statusCode: error.response?.status }
    );
    // Retorna null en modo degraded — no rompe /api/data
    return null;
  }
}

/**
 * Obtiene datos de ticker 24h de Binance (volumen, cambio de precio, highs/lows).
 *
 * @param {string} symbol - Símbolo en Binance (ej: 'BTCUSDT')
 * @returns {Promise<Object|null>} { volume_24h_base, volume_24h_quote, price_change_pct, high_24h, low_24h } o null si falla
 */
export async function fetchBinanceTicker(symbol) {
  if (!symbol) {
    logger.warn('fetchBinanceTicker: símbolo vacío');
    return null;
  }

  try {
    const response = await axios.get(`${BINANCE_API_BASE}/ticker/24hr`, {
      params: { symbol },
      timeout: REQUEST_TIMEOUT,
    });

    const d = response.data;
    return {
      volume_24h_base: parseFloat(d.volume),      // en la crypto base (ej: BTC)
      volume_24h_quote: parseFloat(d.quoteVolume), // en USD
      price_change_pct: parseFloat(d.priceChangePercent),
      high_24h: parseFloat(d.highPrice),
      low_24h: parseFloat(d.lowPrice),
    };
  } catch (error) {
    logger.warn(`fetchBinanceTicker error (${symbol}): ${error.message}`);
    return null; // No crítico, no lanza error
  }
}

/**
 * Encuentra el nivel con el mayor volumen acumulado en un array de niveles.
 *
 * @param {Array<[price, quantity]>} levels - Array de [precio, cantidad] de Binance
 * @returns {Object} { price, volume }
 */
function findLargestWall(levels) {
  let maxWall = { price: 0, volume: 0 };

  levels.forEach((level) => {
    const price = parseFloat(level[0]);
    const volume = parseFloat(level[1]);

    if (volume > maxWall.volume) {
      maxWall = { price, volume };
    }
  });

  return maxWall;
}
