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
 */

import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import { fetchOHLC } from './coingeckoService.js';
import { COINALYZE_SYMBOLS } from '../config/constants.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://api.coinalyze.net/v1';
const BINS = 50;
const TOP_N = 5;
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

    const [liqRes, candles] = await Promise.all([
      axios.get(`${BASE_URL}/liquidation-history`, {
        params: { api_key: env.coinalyzeApiKey, symbols: symbol, interval: '1hour', from, to: now },
        timeout: 8000,
      }),
      fetchOHLC(coin, '1h'),
    ]);

    const buckets = liqRes.data?.[0]?.history ?? [];
    if (!buckets.length || !candles?.length) return null;

    // Indexar candles por timestamp en segundos (Binance entrega ms)
    const candleByT = new Map();
    for (const c of candles) {
      const tSec = Math.floor(c.t / 1000);
      candleByT.set(tSec, c);
    }

    // Determinar rango de precio del periodo (sólo velas que tengan match con un bucket)
    let rangeLow = Infinity;
    let rangeHigh = -Infinity;
    for (const b of buckets) {
      const c = candleByT.get(b.t);
      if (!c) continue;
      if (c.low  < rangeLow)  rangeLow  = c.low;
      if (c.high > rangeHigh) rangeHigh = c.high;
    }
    if (!isFinite(rangeLow) || !isFinite(rangeHigh) || rangeHigh <= rangeLow) return null;

    const binSize = (rangeHigh - rangeLow) / BINS;
    const longBins  = new Array(BINS).fill(null).map(() => ({ usd: 0, count: 0 }));
    const shortBins = new Array(BINS).fill(null).map(() => ({ usd: 0, count: 0 }));

    for (const b of buckets) {
      const c = candleByT.get(b.t);
      if (!c) continue;
      const longsUsd  = b.l ?? 0;
      const shortsUsd = b.s ?? 0;

      if (longsUsd > 0) {
        const idx = Math.min(BINS - 1, Math.max(0, Math.floor((c.low - rangeLow) / binSize)));
        longBins[idx].usd += longsUsd;
        longBins[idx].count++;
      }
      if (shortsUsd > 0) {
        const idx = Math.min(BINS - 1, Math.max(0, Math.floor((c.high - rangeLow) / binSize)));
        shortBins[idx].usd += shortsUsd;
        shortBins[idx].count++;
      }
    }

    const binCenter = (idx) => parseFloat((rangeLow + binSize * (idx + 0.5)).toFixed(2));

    const toClusters = (bins) => bins
      .map((b, i) => ({ price: binCenter(i), total_usd: parseFloat(b.usd.toFixed(2)), count: b.count }))
      .filter(x => x.total_usd > 0)
      .sort((a, b) => b.total_usd - a.total_usd)
      .slice(0, TOP_N);

    const long_clusters  = toClusters(longBins);
    const short_clusters = toClusters(shortBins);

    // Distancia al cluster más cercano respecto al precio actual
    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle?.close ?? null;

    let nearest_long_cluster_pct = null;
    let nearest_short_cluster_pct = null;
    if (currentPrice) {
      // Long clusters: buscar el más cercano POR DEBAJO del precio actual
      const longsBelow = long_clusters.filter(c => c.price < currentPrice);
      if (longsBelow.length) {
        const closest = longsBelow.reduce((a, b) => (currentPrice - a.price) < (currentPrice - b.price) ? a : b);
        nearest_long_cluster_pct = parseFloat(((closest.price - currentPrice) / currentPrice * 100).toFixed(2));
      }
      // Short clusters: buscar el más cercano POR ENCIMA del precio actual
      const shortsAbove = short_clusters.filter(c => c.price > currentPrice);
      if (shortsAbove.length) {
        const closest = shortsAbove.reduce((a, b) => (a.price - currentPrice) < (b.price - currentPrice) ? a : b);
        nearest_short_cluster_pct = parseFloat(((closest.price - currentPrice) / currentPrice * 100).toFixed(2));
      }
    }

    const result = {
      long_clusters,
      short_clusters,
      nearest_long_cluster_pct,
      nearest_short_cluster_pct,
      source: 'coinalyze_inferred',
    };

    cacheSet(cacheKey, result, env.cache.liquidationClustersTtl);
    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Liquidation clusters fetch failed');
    return null;
  }
}
