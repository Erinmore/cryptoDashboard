import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import { addFearGreedEntry } from './historyService.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const API_URL = 'https://api.alternative.me/fng/?limit=30';

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
      trend_1d: previousVal != null
        ? currentVal > previousVal ? 'improving' : 'worsening'
        : null,
      trend_7d_change: weekAgoVal != null ? currentVal - weekAgoVal : null,
      timestamp: new Date(parseInt(current.timestamp, 10) * 1000).toISOString(),
    };

    cacheSet(cacheKey, result, env.cache.fearGreedTtl);

    // Alimentar histórico con todos los datos (en orden: más antiguo → más reciente)
    try {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const val = parseInt(entry.value, 10);
        const prevVal = i < entries.length - 1 ? parseInt(entries[i + 1].value, 10) : null;
        const trend = prevVal != null
          ? val > prevVal ? 'improving' : val < prevVal ? 'worsening' : 'stable'
          : null;

        // Crear entry con timestamp real (no con fecha de hoy)
        const entryDate = new Date(parseInt(entry.timestamp, 10) * 1000).toISOString().split('T')[0];
        addFearGreedEntry(val, entry.value_classification, trend, entryDate);
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to add Fear & Greed to history');
    }

    return result;
  } catch (err) {
    logger.warn({ err: err.message }, 'Fear & Greed API failed');
    return null; // No crítico
  }
}
