import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import { addFearGreedEntry } from './historyService.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const API_URL = 'https://api.alternative.me/fng/?limit=8';

export async function fetchFearGreed() {
  const cacheKey = 'fear_greed';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await axios.get(API_URL, { timeout: 6000 });
    const entries = data.data ?? [];

    if (!entries.length) return null;

    const current  = entries[0];
    const previous = entries[1] ?? null;
    const weekAgo  = entries[7] ?? null;

    const currentVal  = parseInt(current.value, 10);
    const previousVal = previous ? parseInt(previous.value, 10) : null;
    const weekAgoVal  = weekAgo  ? parseInt(weekAgo.value, 10)  : null;

    const result = {
      value: currentVal,
      classification: current.value_classification,
      previous_value: previousVal,
      previous_classification: previous?.value_classification ?? null,
      trend: previousVal != null
        ? currentVal > previousVal ? 'improving' : 'worsening'
        : null,
      trend_7d_change: weekAgoVal != null ? currentVal - weekAgoVal : null,
      timestamp: new Date(parseInt(current.timestamp, 10) * 1000).toISOString(),
    };

    cacheSet(cacheKey, result, env.cache.fearGreedTtl);

    // Alimentar histórico
    try {
      addFearGreedEntry(result.value, result.classification, result.trend);
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to add Fear & Greed to history');
    }

    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'Fear & Greed API failed');
    return null; // No crítico
  }
}
