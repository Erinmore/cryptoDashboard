import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import { getSentimentCache, setSentimentCache } from './dbService.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://cryptopanic.com/api/developer/v2';

const CURRENCY_MAP = { BTC: 'BTC', ETH: 'ETH', SOL: 'SOL' };

export async function fetchSentiment(coin) {
  const currency = CURRENCY_MAP[coin.toUpperCase()];
  const cacheKey = `sentiment:${coin}`;

  // 1. Cache en memoria (TTL configurable, por defecto 5min)
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // 2. Si no hay token configurado, devolver null
  if (!env.cryptopanicToken) {
    logger.warn('CryptoPanic token not configured');
    return buildFallback(coin, await getSentimentCache(coin));
  }

  try {
    const { data } = await axios.get(`${BASE_URL}/posts/`, {
      params: {
        auth_token: env.cryptopanicToken,
        currencies: currency,
        filter: 'hot',
        public: true,
        kind: 'news',
      },
      timeout: 8000,
    });

    const result = parseSentiment(coin, data);

    // Guardar en cache memoria y en SQLite (fallback persistente)
    cacheSet(cacheKey, result, env.cache.sentimentTtl);
    setSentimentCache(coin, result);

    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'CryptoPanic failed — using cache fallback');
    return buildFallback(coin, await getSentimentCache(coin));
  }
}

function parseSentiment(coin, data) {
  const posts = data.results ?? [];

  // API de pago requerida — si devuelve resultados vacíos marcar como no disponible
  if (posts.length === 0) {
    return {
      coin: coin.toUpperCase(),
      score: null,
      bullish_votes: null,
      bearish_votes: null,
      news_count: 0,
      latest_news: [],
      stale: false,
      unavailable: true,
      timestamp: new Date().toISOString(),
    };
  }

  let bullishVotes = 0;
  let bearishVotes = 0;
  const news = [];

  for (const post of posts.slice(0, 20)) {
    const votes = post.votes ?? {};
    bullishVotes += votes.positive ?? 0;
    bearishVotes += votes.negative ?? 0;

    news.push({
      title: post.title,
      url: post.url,
      source: post.source?.title ?? '',
      published_at: post.published_at,
      sentiment: votes.positive > votes.negative ? 'bullish'
        : votes.negative > votes.positive ? 'bearish'
        : 'neutral',
      votes: (votes.positive ?? 0) + (votes.negative ?? 0),
    });
  }

  const totalVotes = bullishVotes + bearishVotes;
  const score = totalVotes > 0
    ? parseFloat((bullishVotes / totalVotes).toFixed(4))
    : null;

  return {
    coin: coin.toUpperCase(),
    score,
    bullish_votes: bullishVotes,
    bearish_votes: bearishVotes,
    news_count: news.length,
    latest_news: news.slice(0, 5),
    stale: false,
    timestamp: new Date().toISOString(),
  };
}

function buildFallback(coin, dbCache) {
  if (dbCache) {
    logger.info({ coin }, 'Using stale sentiment from SQLite');
    return {
      ...dbCache,
      latest_news: dbCache.raw_data?.latest_news ?? [],
      stale: true,
    };
  }

  // Sin ningún dato disponible
  return {
    coin: coin.toUpperCase(),
    score: null,
    bullish_votes: null,
    bearish_votes: null,
    news_count: 0,
    latest_news: [],
    stale: true,
    unavailable: true,
    timestamp: new Date().toISOString(),
  };
}
