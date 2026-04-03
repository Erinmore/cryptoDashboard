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
const REQUEST_TIMEOUT = 5000; // 5s

/**
 * Obtiene los mayores muros de compra y venta del order book de Binance.
 *
 * @param {string} symbol - Símbolo en Binance (ej: 'BTCUSDT')
 * @returns {Promise<Object|null>} { buyWall: {price, volume}, sellWall: {price, volume} } o null si falla
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

    return {
      buyWall,
      sellWall,
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
