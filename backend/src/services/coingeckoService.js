import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import { COINGECKO_IDS } from '../config/constants.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';
import { ExternalApiError } from '../utils/errors.js';

const BASE_URL = 'https://api.coingecko.com/api/v3';

const rawClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: env.coingeckoApiKey
    ? { 'x-cg-demo-api-key': env.coingeckoApiKey }
    : {},
});

// ─── Rate limiter: retry automático en 429 ───────────────────────────────────

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1500;

/**
 * Wrapper que reintenta automáticamente si CoinGecko devuelve 429.
 * No serializa requests — solo añade retry con backoff exponencial.
 */
async function requestWithRetry(method, url, config) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await rawClient.request({ method, url, ...config });
    } catch (err) {
      if (err.response?.status === 429 && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * (attempt + 1);
        logger.warn({ url, attempt: attempt + 1, delay }, 'CoinGecko 429, retrying');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/** Client with automatic 429 retry */
const client = {
  get(url, config) {
    return requestWithRetry('get', url, config);
  },
};

/**
 * CoinGecko free tier granularidades:
 *   /ohlc: days=30 → 4h candles, days=365 → daily candles
 *   /market_chart: days≤90 hourly, days>90 daily
 *
 * Para 1h: market_chart hourly (7d) → buckets de 1h.
 * Para 1W: market_chart daily (365d, CoinGecko devuelve diario para days>90) → buckets de 168h.
 */
const TF_CONFIG = {
  '1h': { source: 'market_chart', days: 7,   bucketHours: 1,   label: '1h' },
  '4h': { source: 'ohlc',         days: 30,  label: '4h' },
  '1D': { source: 'ohlc',         days: 365, label: '1D' },
  '1W': { source: 'market_chart', days: 365, bucketHours: 168, label: '1W' },
};

/** Cache TTL por TF (segundos) — TFs altos cambian menos. */
const TF_CACHE_TTL = {
  '1h': 60,
  '4h': 300,
  '1D': 600,
  '1W': 1800,
};

// ─── OHLC ─────────────────────────────────────────────────────────────────────

export async function fetchOHLC(coin, timeframe) {
  const coinId = COINGECKO_IDS[coin.toUpperCase()];
  if (!coinId) throw new ExternalApiError('CoinGecko', `Unknown coin: ${coin}`);

  const config = TF_CONFIG[timeframe];
  if (!config) throw new ExternalApiError('CoinGecko', `Unknown timeframe: ${timeframe}`);

  const cacheKey = `ohlc:${coin}:${timeframe}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    let candles;

    if (config.source === 'ohlc') {
      // Fetch OHLC y volúmenes en paralelo
      const [ohlcCandles, volumeMap] = await Promise.all([
        fetchOHLCEndpoint(coinId, config.days),
        fetchVolumeMap(coinId, config.days),
      ]);
      // Enriquecer cada vela con el volumen más cercano disponible
      candles = ohlcCandles.map(c => ({
        ...c,
        volume: volumeMap.get(c.t) ?? 0,
      }));
    } else {
      candles = await fetchMarketChartAggregated(coinId, config.days, config.bucketHours);
    }

    cacheSet(cacheKey, candles, TF_CACHE_TTL[timeframe] ?? env.cache.ohlcTtl);
    return candles;
  } catch (err) {
    if (err instanceof ExternalApiError) throw err;
    logger.warn({ coin, timeframe, err: err.message }, 'CoinGecko OHLC failed');
    throw new ExternalApiError('CoinGecko', err.message);
  }
}

async function fetchOHLCEndpoint(coinId, days) {
  const { data } = await client.get(`/coins/${coinId}/ohlc`, {
    params: { vs_currency: 'usd', days },
  });

  // Respuesta: [[timestamp, open, high, low, close], ...]
  return data.map(([t, o, h, l, c]) => ({
    t,
    open: o, high: h, low: l, close: c,
    volume: 0, // CoinGecko OHLC no incluye volumen
  }));
}

/**
 * Devuelve un Map<timestamp, volume> con los volúmenes del market_chart.
 * Se usa para enriquecer las candles del endpoint /ohlc que no tiene volumen.
 */
async function fetchVolumeMap(coinId, days) {
  try {
    const { data } = await client.get(`/coins/${coinId}/market_chart`, {
      params: { vs_currency: 'usd', days, interval: 'daily' },
    });
    const map = new Map();
    const DAY_MS = 86400 * 1000;
    for (const [ts, vol] of data.total_volumes ?? []) {
      // Mapear el volumen a cada timestamp dentro del día
      for (let offset = 0; offset < DAY_MS; offset += 1800 * 1000) {
        map.set(ts - (ts % DAY_MS) + offset, vol / 48); // ~48 candles de 30min por día
      }
    }
    return map;
  } catch {
    return new Map(); // No crítico, CVD/OBV quedarán en 0
  }
}

/**
 * Construye OHLCV desde market_chart (hourly) agrupando en buckets de bucketHours horas.
 *
 * - Para buckets de 1h (un único tick de precio por bucket): el open se fija al close
 *   de la vela anterior para evitar dojis planos. High/low derivan de open y close.
 * - Para buckets de 8h+: hay múltiples ticks por bucket → open/high/low se calculan
 *   correctamente desde los precios reales dentro de la ventana.
 */
async function fetchMarketChartAggregated(coinId, days, bucketHours) {
  const { data } = await client.get(`/coins/${coinId}/market_chart`, {
    params: { vs_currency: 'usd', days, interval: 'hourly' },
  });

  const { prices, total_volumes } = data;
  const BUCKET_MS = bucketHours * 3600 * 1000;

  const buckets = new Map();

  for (const [ts, price] of prices) {
    const key = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    if (!buckets.has(key)) {
      buckets.set(key, { t: key, open: price, high: price, low: price, close: price, volume: 0 });
    }
    const candle = buckets.get(key);
    candle.high  = Math.max(candle.high, price);
    candle.low   = Math.min(candle.low, price);
    candle.close = price;
  }

  for (const [ts, vol] of total_volumes) {
    const key = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    if (buckets.has(key)) buckets.get(key).volume += vol;
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.t - b.t);

  // Para buckets de 1h hay un único tick → open=close=high=low.
  // Usar el close anterior como open da cuerpos visibles y correctos.
  if (bucketHours === 1) {
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      curr.open = prev.close;
      curr.high = Math.max(curr.open, curr.close);
      curr.low  = Math.min(curr.open, curr.close);
    }
  }

  return sorted;
}

// ─── Precio actual ────────────────────────────────────────────────────────────

export async function fetchCurrentPrice(coin) {
  const coinId = COINGECKO_IDS[coin.toUpperCase()];
  if (!coinId) throw new ExternalApiError('CoinGecko', `Unknown coin: ${coin}`);

  const cacheKey = `price:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await client.get('/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
        include_24hr_change: true,
      },
    });

    const result = {
      price: data[coinId].usd,
      change_24h_pct: data[coinId].usd_24h_change ?? 0,
    };

    cacheSet(cacheKey, result, 30); // 30 seg
    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'CoinGecko price failed');
    throw new ExternalApiError('CoinGecko', err.message);
  }
}

// ─── BTC Dominance ────────────────────────────────────────────────────────────

export async function fetchBTCDominance() {
  const cacheKey = 'btc_dominance';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await client.get('/global');
    const dominance = data.data.market_cap_percentage.btc ?? null;

    cacheSet(cacheKey, dominance, env.cache.btcDominanceTtl);
    return dominance;
  } catch (err) {
    logger.warn({ err: err.message }, 'CoinGecko BTC dominance failed');
    return null; // No crítico, no lanza error
  }
}
