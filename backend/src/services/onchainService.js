/**
 * onchainService.js — Métricas on-chain de Bitcoin (BGeometrics / bitcoin-data.com)
 *
 * Free tier: 8 req/h, 15 req/día, históricos 4 años. Cacheamos a 1h por defecto
 * para no consumir el cupo. ETH/SOL no tienen fuente gratuita confiable: null.
 *
 * Métricas obtenidas (las 4 son endpoints `/last`, devuelven el dato más reciente):
 *   - mvrv         → ratio Market Value / Realized Value
 *   - mvrv-zscore  → desviación estandarizada del MVRV (mejor señal de techos)
 *   - nupl         → Net Unrealized Profit/Loss (algunos valores vienen como string)
 *   - sopr         → Spent Output Profit Ratio (>1 profit, <1 loss)
 *
 * Sin endpoint de exchange netflow en el free tier visible → exchange_netflow_24h_btc = null.
 */

import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://api.bitcoin-data.com/v1';
const REQUEST_TIMEOUT = 8000;

/**
 * @param {string} coin — sólo BTC tiene cobertura completa.
 *   ETH/SOL: la fuente no expone equivalentes, devolvemos null.
 * @returns {Promise<object|null>}
 */
export async function fetchOnchainMetrics(coin) {
  if (!env.onchainEnabled) return null;
  if (coin !== 'BTC') return null;

  const cacheKey = `onchain:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    // Sentinel para cache negativo: cacheGet trata null como miss, así que
    // guardamos { __empty: true } para distinguir "fetch falló recientemente"
    // de "no hay entrada" y evitar martillear la API free-tier (15 req/día).
    return cached.__empty ? null : cached;
  }

  try {
    const [mvrvRes, zscoreRes, nuplRes, soprRes] = await Promise.allSettled([
      axios.get(`${BASE_URL}/mvrv/last`,        { timeout: REQUEST_TIMEOUT }),
      axios.get(`${BASE_URL}/mvrv-zscore/last`, { timeout: REQUEST_TIMEOUT }),
      axios.get(`${BASE_URL}/nupl/last`,        { timeout: REQUEST_TIMEOUT }),
      axios.get(`${BASE_URL}/sopr/last`,        { timeout: REQUEST_TIMEOUT }),
    ]);

    const num = (v) => (v === null || v === undefined ? null : parseFloat(v));

    const mvrv         = mvrvRes.status   === 'fulfilled' ? num(mvrvRes.value.data?.mvrv)             : null;
    const mvrvZscore   = zscoreRes.status === 'fulfilled' ? num(zscoreRes.value.data?.mvrvZscore)     : null;
    const nupl         = nuplRes.status   === 'fulfilled' ? num(nuplRes.value.data?.nupl)             : null;
    const sopr         = soprRes.status   === 'fulfilled' ? num(soprRes.value.data?.sopr)             : null;
    const asOf         = [mvrvRes, zscoreRes, nuplRes, soprRes]
      .find(r => r.status === 'fulfilled')?.value.data?.d ?? null;

    if (mvrv === null && mvrvZscore === null && nupl === null && sopr === null) {
      // Fallo total: cachear null para no quemar cuota en cada /api/analyze/payload
      logger.warn({ coin }, 'Onchain: all metrics null, caching negative');
      cacheSet(cacheKey, { __empty: true }, env.cache.onchainNegativeTtl);
      return null;
    }

    const result = {
      mvrv,
      mvrv_zscore:    mvrvZscore,
      mvrv_signal:    classifyMvrv(mvrv),
      nupl,
      nupl_signal:    classifyNupl(nupl),
      sopr,
      sopr_signal:    classifySopr(sopr),
      exchange_netflow_24h_btc: null, // no expuesto en free tier
      source: 'bitcoin-data.com',
      as_of:  asOf,
    };

    // Mismo TTL completo o parcial: los datos son diarios, no tiene sentido un TTL
    // corto que provoque ráfagas repetidas y consuma la cuota de 15 req/día.
    cacheSet(cacheKey, result, env.cache.onchainTtl);
    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Onchain fetch failed, caching negative');
    cacheSet(cacheKey, null, env.cache.onchainNegativeTtl);
    return null;
  }
}

function classifyMvrv(v) {
  if (v === null) return null;
  if (v < 1) return 'low';
  if (v < 2) return 'fair';
  if (v < 3) return 'elevated';
  return 'extreme';
}

function classifyNupl(v) {
  if (v === null) return null;
  if (v < 0)    return 'capitulation';
  if (v < 0.25) return 'hope';
  if (v < 0.5)  return 'optimism';
  if (v < 0.75) return 'belief';
  return 'euphoria';
}

function classifySopr(v) {
  if (v === null) return null;
  if (v < 0.99) return 'loss';
  if (v < 1.01) return 'neutral';
  return 'profit_taking';
}
