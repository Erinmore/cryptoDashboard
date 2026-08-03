/**
 * liquidationClustersService.js — Inferencia de "magnetic zones" por liquidaciones
 *
 * IMPORTANTE: esta es una APROXIMACIÓN, no datos reales tipo CoinGlass.
 * Coinalyze sólo expone los USD totales de longs/shorts liquidados por bucket
 * horario, sin precio asociado. Inferimos el precio cruzando cada bucket
 * con la vela 1h de Binance del mismo timestamp:
 *   - Los longs se liquidan en el swing low (precio cae a su stop)
 *   - Los shorts se liquidan en el swing high (precio sube a su stop)
 *
 * Después agrupamos por bins de precio (rango 7d / 50 bins) y devolvemos
 * los top 5 clusters de cada lado por USD acumulado.
 *
 * Documentar honestamente el origen en el campo `source` para que el LLM
 * sepa que no es CoinGlass real.
 *
 * 2026-08-02: el CÁLCULO vive ahora en `utils/liquidationClusters.js` (función pura). Aquí
 * queda solo el I/O — fetch, cache y degraded mode. El motivo es que
 * `scripts/backfillLiquidationClusters.mjs` reconstruye clusters de análisis pasados y tiene
 * que usar exactamente el mismo algoritmo, no una copia.
 */

import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import { fetchOHLC } from './coingeckoService.js';
import { COINALYZE_SYMBOLS } from '../config/constants.js';
import { computeLiquidationClusters } from '../utils/liquidationClusters.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://api.coinalyze.net/v1';
const HOURS = 7 * 24;

export async function fetchLiquidationClusters(coin) {
  if (!env.hasDerivativesData) return null;

  const symbol = COINALYZE_SYMBOLS[coin.toUpperCase()];
  if (!symbol) return null;

  const cacheKey = `liq_clusters:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - HOURS * 3600;

    const [liqSettled, candlesSettled] = await Promise.allSettled([
      axios.get(`${BASE_URL}/liquidation-history`, {
        params: { api_key: env.coinalyzeApiKey, symbols: symbol, interval: '1hour', from, to: now },
        timeout: 8000,
      }),
      fetchOHLC(coin, '1h'),
    ]);

    const buckets = liqSettled.status === 'fulfilled' ? (liqSettled.value.data?.[0]?.history ?? []) : [];
    const candles = candlesSettled.status === 'fulfilled' ? candlesSettled.value : null;

    const result = computeLiquidationClusters(buckets, candles);
    if (!result) return null;

    cacheSet(cacheKey, result, env.cache.liquidationClustersTtl);
    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Liquidation clusters fetch failed');
    return null;
  }
}
