/**
 * deribitService.js — Deribit Volatility Index (DVOL)
 *
 * Endpoint público sin auth: GET /api/v2/public/get_volatility_index_data
 * Cubre BTC y ETH. SOL no tiene DVOL en Deribit → null natural.
 *
 * resolution=43200 (12h) — pedimos 48h de historia para calcular change_24h_pct
 * comparando el último close vs el close de hace ~24h.
 *
 * Cache 5min (Deribit es fiable, sin cuota free). Sin sentinel de cache negativo.
 */

import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const REQUEST_TIMEOUT = 8000;
const CACHE_TTL = 300; // 5 min

const DERIBIT_CURRENCY = { BTC: 'BTC', ETH: 'ETH' };

/**
 * @param {string} coin — 'BTC' | 'ETH' | 'SOL'
 * @returns {Promise<{value:number,regime:string,change_24h_pct:number|null}|null>}
 */
async function fetchDvol(coin) {
  const currency = DERIBIT_CURRENCY[coin];
  if (!currency) return null; // SOL — sin DVOL en Deribit

  const cacheKey = `deribit_dvol:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  const endTs = Date.now();
  const startTs = endTs - 48 * 3600 * 1000; // 48h de historia

  try {
    const resp = await axios.get(BASE_URL, {
      params: { currency, start_timestamp: startTs, end_timestamp: endTs, resolution: 43200 },
      timeout: REQUEST_TIMEOUT,
    });

    const data = resp.data?.result?.data; // [[t_ms, open, high, low, close], ...]
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn({ coin }, 'Deribit DVOL: empty data array');
      return null;
    }

    const lastCandle = data.at(-1);
    const value = lastCandle?.[4] ?? null; // close del último candle
    if (value === null) return null;

    // change_24h_pct: comparar último close vs close de ~24h atrás
    // Con resolution=43200 (12h): hace 24h ≈ índice data.length - 3 (2 candles atrás)
    let change24hPct = null;
    if (data.length >= 2) {
      const refCandle = data.length >= 3 ? data.at(-3) : data.at(0);
      const refClose = refCandle?.[4] ?? null;
      if (refClose !== null && refClose !== 0) {
        change24hPct = parseFloat(((value - refClose) / refClose * 100).toFixed(2));
      }
    }

    const result = {
      value:            parseFloat(value.toFixed(2)),
      regime:           classifyDvol(value),
      change_24h_pct:   change24hPct,
      source:           'deribit',
    };

    cacheSet(cacheKey, result, CACHE_TTL);
    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Deribit DVOL fetch failed');
    return null;
  }
}

function classifyDvol(v) {
  if (v === null) return null;
  if (v > 80) return 'panic';
  if (v > 60) return 'elevated';
  if (v > 40) return 'normal';
  return 'complacent';
}

/**
 * Fetcha DVOL para BTC, ETH y SOL en paralelo.
 * @returns {Promise<{btc_dvol:object|null, eth_dvol:object|null, sol_dvol:null}>}
 */
export async function fetchVolatilityData() {
  const [btcRes, ethRes] = await Promise.allSettled([
    fetchDvol('BTC'),
    fetchDvol('ETH'),
  ]);

  return {
    btc_dvol: btcRes.status === 'fulfilled' ? btcRes.value : null,
    eth_dvol: ethRes.status === 'fulfilled' ? ethRes.value : null,
    sol_dvol: null, // Deribit no tiene DVOL para SOL
  };
}
