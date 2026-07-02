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
 * OHLCV via Binance klines — fuente única para todos los timeframes.
 *
 * CoinGecko market_chart solo devuelve precios puntuales (snapshots), no OHLCV real.
 * Los high/low calculados desde snapshots siempre pierden movimientos intrahorarios.
 * Binance klines provee OHLCV verdadero (misma fuente para 1h/4h/1D/1W), gratis, sin API key.
 * Las velas semanales de Binance están alineadas a lunes UTC natively.
 *
 * Respuesta Binance klines: [openTime, open, high, low, close, volume, closeTime, ...]
 */
const BINANCE_BASE    = 'https://api.binance.com/api/v3';
const BINANCE_SYMBOLS = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
const TF_INTERVAL     = { '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };
const TF_LIMIT        = { '1h': 168,  '4h': 180,  '1D': 90,   '1W': 52  };

/** Cache TTL por TF (segundos) — TFs altos cambian menos. */
const TF_CACHE_TTL = {
  '1h': 60,
  '4h': 300,
  '1D': 600,
  '1W': 1800,
};

// ─── OHLC ─────────────────────────────────────────────────────────────────────

export async function fetchOHLC(coin, timeframe) {
  const symbol   = BINANCE_SYMBOLS[coin.toUpperCase()];
  const interval = TF_INTERVAL[timeframe];

  if (!symbol)   throw new ExternalApiError('Binance', `Unknown coin: ${coin}`);
  if (!interval) throw new ExternalApiError('Binance', `Unknown timeframe: ${timeframe}`);

  const cacheKey = `ohlc:${coin}:${timeframe}`;
  const cached   = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const candles = await fetchBinanceKlines(symbol, interval, TF_LIMIT[timeframe]);
    cacheSet(cacheKey, candles, TF_CACHE_TTL[timeframe] ?? env.cache.ohlcTtl);
    return candles;
  } catch (err) {
    if (err instanceof ExternalApiError) throw err;
    logger.warn({ coin, timeframe, err: err.message }, 'Binance klines failed');
    throw new ExternalApiError('Binance', err.message);
  }
}

/**
 * Obtiene velas OHLCV reales desde Binance klines (API pública, sin auth).
 * Cada elemento del array: [openTime, open, high, low, close, volume, ...]
 */
async function fetchBinanceKlines(symbol, interval, limit) {
  const { data } = await axios.get(`${BINANCE_BASE}/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000,
  });
  return data.map(k => ({
    t:               k[0],
    open:            parseFloat(k[1]),
    high:            parseFloat(k[2]),
    low:             parseFloat(k[3]),
    close:           parseFloat(k[4]),
    volume:          parseFloat(k[5]),
    quote_volume:    parseFloat(k[7]),
    taker_buy_base:  parseFloat(k[9]),
    taker_buy_quote: parseFloat(k[10]),
  }));
}

/**
 * Velas OHLC históricas en un rango temporal (para backtesting / analysis_outcome).
 * @param {string} coin
 * @param {string} interval - Formato Binance ('1m', '1h', '4h', '1d'…)
 * @param {number} startTime - epoch ms
 * @param {number} endTime   - epoch ms
 * @param {number} [limit=1000]
 * @returns {Promise<Array<{t:number, open:number, high:number, low:number, close:number, volume:number}>>}
 */
export async function fetchHistoricalKlines(coin, interval, startTime, endTime, limit = 1000) {
  const symbol = BINANCE_SYMBOLS[coin.toUpperCase()];
  if (!symbol) throw new ExternalApiError('Binance', `Unknown coin: ${coin}`);

  const { data } = await axios.get(`${BINANCE_BASE}/klines`, {
    params: { symbol, interval, startTime, endTime, limit },
    timeout: 10000,
  });
  return data.map(k => ({
    t:      k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

/**
 * Precio (close) en un instante concreto — vela de 1 minuto que arranca en/después
 * de `targetMs`. Devuelve null si Binance no devuelve datos.
 * @param {string} coin
 * @param {number} targetMs - epoch ms
 * @returns {Promise<number|null>}
 */
export async function fetchHistoricalClose(coin, targetMs) {
  const candles = await fetchHistoricalKlines(coin, '1m', targetMs, targetMs + 60000, 1);
  return candles.length ? candles[0].close : null;
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

// ─── Global Market Data ───────────────────────────────────────────────────────

export async function fetchGlobalMarketData() {
  const cacheKey = 'global_market';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await client.get('/global');
    const d = data.data;

    const totalMarketCapUsd = d.total_market_cap?.usd ?? null;
    const btcDominance = d.market_cap_percentage?.btc ?? null;

    // BTC market cap = total * (btcDominance / 100)
    // Altcoin market cap = total - BTC market cap
    const btcMarketCapUsd = totalMarketCapUsd && btcDominance
      ? totalMarketCapUsd * (btcDominance / 100)
      : null;
    const altcoinMarketCapUsd = totalMarketCapUsd && btcMarketCapUsd
      ? totalMarketCapUsd - btcMarketCapUsd
      : null;

    const result = {
      total_market_cap_usd: totalMarketCapUsd,
      btc_dominance: btcDominance,
      btc_market_cap_usd: btcMarketCapUsd,
      altcoin_market_cap_usd: altcoinMarketCapUsd,
      market_cap_change_24h_pct: d.market_cap_change_percentage_24h_usd ?? null,
    };

    cacheSet(cacheKey, result, env.cache.btcDominanceTtl);
    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'CoinGecko global market data failed');
    return null; // No crítico, no lanza error
  }
}

// ─── Coin Market Data ──────────────────────────────────────────────────────────

export async function fetchCoinMarketData(coin) {
  const coinId = COINGECKO_IDS[coin.toUpperCase()];
  if (!coinId) return null;

  const cacheKey = `coin_market:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await client.get(`/coins/${coinId}`, {
      params: {
        localization: false,
        tickers: false,
        market_data: true,
        community_data: false,
        developer_data: false,
        sparkline: false,
      },
    });

    const md = data.market_data;
    const result = {
      market_cap_usd: md.market_cap?.usd ?? null,
      volume_24h_usd: md.total_volume?.usd ?? null,
      ath_usd: md.ath?.usd ?? null,
      ath_change_pct: md.ath_change_percentage?.usd ?? null,
      atl_usd: md.atl?.usd ?? null,
      atl_change_pct: md.atl_change_percentage?.usd ?? null,
    };

    cacheSet(cacheKey, result, 300); // TTL 5 min
    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'CoinGecko coin market data failed');
    return null; // No crítico, no lanza error
  }
}
