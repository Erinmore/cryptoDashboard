import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import {
  addFundingRateEntry,
  addOpenInterestEntry,
  addLongShortRatioEntry,
  addLiquidationsEntry,
} from './historyService.js';
import { COINALYZE_SYMBOLS } from '../config/constants.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://api.coinalyze.net/v1';

function getClient() {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 8000,
    params: { api_key: env.coinalyzeApiKey },
  });
}

// ─── Funding Rate ─────────────────────────────────────────────────────────────

export async function fetchFundingRate(coin) {
  if (!env.hasDerivativesData) return null;

  const symbol = COINALYZE_SYMBOLS[coin.toUpperCase()];
  if (!symbol) return null;

  const cacheKey = `funding:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - 48 * 3600;

    const [currentRes, historyRes] = await Promise.allSettled([
      getClient().get('/funding-rate', { params: { symbols: symbol } }),
      getClient().get('/funding-rate-history', {
        params: { symbols: symbol, interval: '6hour', from, to: now },
      }),
    ]);

    const entry = currentRes.status === 'fulfilled' ? currentRes.value.data?.[0] : null;
    if (!entry) return null;

    const rate = entry.value ?? 0;

    // Tendencia 48h: comparar último cierre vs primer open del histórico
    let trend = null;
    if (historyRes.status === 'fulfilled') {
      const hist = historyRes.value.data?.[0]?.history ?? [];
      if (hist.length >= 2) {
        const oldest = hist[0].o;
        const latest = hist[hist.length - 1].c;
        const diff   = latest - oldest;
        trend = diff >  0.0002 ? 'rising'
          : diff < -0.0002 ? 'falling'
          : 'stable';
      }
    }

    const result = {
      rate: parseFloat(rate.toFixed(6)),
      rate_pct: parseFloat((rate * 100).toFixed(4)),
      annualized_pct: parseFloat((rate * 3 * 365 * 100).toFixed(2)), // 3 pagos/día × 365
      trend,
      signal: rate > 0.001 ? 'longs_overloaded'
        : rate < -0.0005 ? 'shorts_overloaded'
        : 'balanced',
      next_funding_time: entry.next_funding_time ?? null,
    };

    cacheSet(cacheKey, result, env.cache.fundingRateTtl);

    // Alimentar histórico con el último candle del history si disponible
    try {
      if (historyRes.status === 'fulfilled') {
        const hist = historyRes.value.data?.[0]?.history ?? [];
        if (hist.length > 0) {
          const lastCandle = hist[hist.length - 1];
          addFundingRateEntry({
            t: lastCandle.t,
            o: lastCandle.o,
            h: lastCandle.h,
            l: lastCandle.l,
            c: lastCandle.c,
            trend: result.trend,
          });
        }
      }
    } catch (e) {
      logger.warn({ coin, err: e.message }, 'Failed to add Funding Rate to history');
    }

    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Coinalyze funding rate failed');
    return null;
  }
}

// ─── Open Interest ────────────────────────────────────────────────────────────

export async function fetchOpenInterest(coin) {
  if (!env.hasDerivativesData) return null;

  const symbol = COINALYZE_SYMBOLS[coin.toUpperCase()];
  if (!symbol) return null;

  const cacheKey = `oi:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - 26 * 3600; // ~26h para asegurar que tenemos el punto de 24h atrás

    const [currentRes, historyRes] = await Promise.allSettled([
      getClient().get('/open-interest', { params: { symbols: symbol } }),
      getClient().get('/open-interest-history', {
        params: { symbols: symbol, interval: '4hour', from, to: now },
      }),
    ]);

    const entry = currentRes.status === 'fulfilled' ? currentRes.value.data?.[0] : null;
    if (!entry) return null;

    const current = entry.value ?? 0;

    // Cambio 24h: comparar cierre actual vs open del punto más antiguo del histórico (~24h atrás)
    let change_24h_pct = null;
    let signal = 'stable';
    if (historyRes.status === 'fulfilled') {
      const hist = historyRes.value.data?.[0]?.history ?? [];
      if (hist.length >= 2) {
        const oldest = hist[0].o;
        if (oldest && oldest !== 0) {
          change_24h_pct = parseFloat(((current - oldest) / Math.abs(oldest) * 100).toFixed(2));
          signal = change_24h_pct > 5 ? 'increasing_fast'
            : change_24h_pct > 1   ? 'increasing'
            : change_24h_pct < -5  ? 'decreasing_fast'
            : change_24h_pct < -1  ? 'decreasing'
            : 'stable';
        }
      }
    }

    const result = { value_usd: current, change_24h_pct, signal };

    cacheSet(cacheKey, result, env.cache.openInterestTtl);

    // Alimentar histórico con el último candle del history
    try {
      if (historyRes.status === 'fulfilled') {
        const hist = historyRes.value.data?.[0]?.history ?? [];
        if (hist.length > 0) {
          const lastCandle = hist[hist.length - 1];
          addOpenInterestEntry({
            t: lastCandle.t,
            o: lastCandle.o,
            h: lastCandle.h,
            l: lastCandle.l,
            c: lastCandle.c,
          });
        }
      }
    } catch (e) {
      logger.warn({ coin, err: e.message }, 'Failed to add Open Interest to history');
    }

    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Coinalyze open interest failed');
    return null;
  }
}

// ─── Long/Short Ratio ─────────────────────────────────────────────────────────

export async function fetchLongShortRatio(coin) {
  if (!env.hasDerivativesData) return null;

  const symbol = COINALYZE_SYMBOLS[coin.toUpperCase()];
  if (!symbol) return null;

  const cacheKey = `lsr:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 7 * 24 * 3600; // últimos 7 días para histórico

    const { data } = await getClient().get('/long-short-ratio-history', {
      params: {
        symbols: symbol,
        interval: '1hour',
        from,
        to: now,
      },
    });

    // Respuesta: array de objetos con history por símbolo
    const symbolData = data?.[0];
    const history = symbolData?.history ?? [];
    const latest = history[history.length - 1];
    if (!latest) return null;

    // La API devuelve { t, r (ratio), l (long%), s (short%) } directamente en porcentaje
    const longPct  = parseFloat((latest.l ?? 50).toFixed(1));
    const shortPct = parseFloat((latest.s ?? 50).toFixed(1));

    // Indicador contrario: >60% longs = mercado sesgado, peligro de reversión
    const signal = longPct > 60 ? 'longs_dominant_contrarian_bear'
      : longPct < 40 ? 'shorts_dominant_contrarian_bull'
      : 'balanced';

    const result = { long_pct: longPct, short_pct: shortPct, signal };

    cacheSet(cacheKey, result, env.cache.longShortTtl);

    // Alimentar histórico con todos los entries disponibles
    try {
      for (const entry of history) {
        addLongShortRatioEntry({
          t: entry.t,
          long_pct: parseFloat((entry.l ?? 50).toFixed(1)),
          short_pct: parseFloat((entry.s ?? 50).toFixed(1)),
        });
      }
    } catch (e) {
      logger.warn({ coin, err: e.message }, 'Failed to add L/S Ratio to history');
    }

    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Coinalyze long/short ratio failed');
    return null;
  }
}

// ─── Liquidaciones 24h ───────────────────────────────────────────────────────

export async function fetchLiquidations(coin) {
  if (!env.hasDerivativesData) return null;

  const symbol = COINALYZE_SYMBOLS[coin.toUpperCase()];
  if (!symbol) return null;

  const cacheKey = `liq:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - 24 * 3600;

    const { data } = await getClient().get('/liquidation-history', {
      params: { symbols: symbol, interval: '1hour', from, to: now },
    });

    const hist = data?.[0]?.history ?? [];
    if (!hist.length) return null;

    // l = longs liquidados (precio bajó), s = shorts liquidados (precio subió)
    const longs_usd  = parseFloat(hist.reduce((acc, h) => acc + (h.l ?? 0), 0).toFixed(2));
    const shorts_usd = parseFloat(hist.reduce((acc, h) => acc + (h.s ?? 0), 0).toFixed(2));
    const total      = longs_usd + shorts_usd;

    // Señal: dominancia de un lado indica presión de mercado
    const ratio = total > 0 ? longs_usd / total : 0.5;
    const signal = ratio > 0.65 ? 'longs_dominant'   // más longs liquidados = bajada fuerte
      : ratio < 0.35 ? 'shorts_dominant'               // más shorts liquidados = short squeeze
      : 'balanced';

    const result = { longs_usd, shorts_usd, total_usd: total, signal };

    cacheSet(cacheKey, result, env.cache.liquidationsTtl);

    // Alimentar histórico con entry de hoy
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      addLiquidationsEntry(today, longs_usd, shorts_usd);
    } catch (e) {
      logger.warn({ coin, err: e.message }, 'Failed to add Liquidations to history');
    }

    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'Coinalyze liquidations failed');
    return null;
  }
}

// ─── Fetch todo junto ─────────────────────────────────────────────────────────

export async function fetchDerivativesData(coin) {
  if (!env.hasDerivativesData) return null;

  const [fundingRate, openInterest, longShortRatio, liquidations] = await Promise.all([
    fetchFundingRate(coin),
    fetchOpenInterest(coin),
    fetchLongShortRatio(coin),
    fetchLiquidations(coin),
  ]);

  if (!fundingRate && !openInterest && !longShortRatio && !liquidations) return null;

  return {
    funding_rate: fundingRate,
    open_interest: openInterest,
    long_short_ratio: longShortRatio,
    liquidations,
  };
}
