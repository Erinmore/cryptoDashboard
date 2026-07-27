import { bucketByPercentile } from '../utils/percentiles.js';
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

    const [currentRes, historyRes, predictedRes] = await Promise.allSettled([
      getClient().get('/funding-rate', { params: { symbols: symbol } }),
      getClient().get('/funding-rate-history', {
        params: { symbols: symbol, interval: '6hour', from, to: now },
      }),
      getClient().get('/predicted-funding-rate', { params: { symbols: symbol } }),
    ]);

    const entry = currentRes.status === 'fulfilled' ? currentRes.value.data?.[0] : null;
    if (!entry) return null;

    // IMPORTANTE: Coinalyze devuelve el funding YA en PORCENTAJE por intervalo
    // (verificado en vivo 2026-07-02: value=0.01 ⇔ 0.01% de Binance, cuyo
    // lastFundingRate=0.0001 en fracción). NO multiplicar por 100 — hacerlo inflaba
    // el funding 100× y producía severity/signal/predicted falsos.
    const ratePct = entry.value ?? 0; // ya es %

    // Tendencia 48h: comparar último cierre vs primer open del histórico. Los candles
    // o/h/l/c vienen en la misma escala % que el valor live. Umbral 0.02% de cambio.
    let trend = null;
    if (historyRes.status === 'fulfilled') {
      const hist = historyRes.value.data?.[0]?.history ?? [];
      if (hist.length >= 2) {
        const oldest = hist[0].o;
        const latest = hist[hist.length - 1].c;
        const diff   = latest - oldest;
        trend = diff >  0.02 ? 'rising'
          : diff < -0.02 ? 'falling'
          : 'stable';
      }
    }

    // Tasa predicha para el próximo periodo (estimación antes de liquidación) — también en %.
    const predictedEntry = predictedRes.status === 'fulfilled'
      ? predictedRes.value.data?.[0]
      : null;
    const predictedRatePct = predictedEntry?.value ?? null;

    const result = {
      rate: parseFloat((ratePct / 100).toFixed(8)), // fracción (0.0001) por si algún consumidor la prefiere
      rate_pct: parseFloat(ratePct.toFixed(6)),
      annualized_pct: parseFloat((ratePct * 3 * 365).toFixed(2)), // 3 pagos/día × 365
      trend,
      // severity se calcula aquí para que /api/data y /api/analyze/payload lo
      // expongan idéntico, en vez de duplicar el clasificador en cada controller.
      severity: ratePct >= 0
        ? (ratePct > 0.5 ? 'extreme' : ratePct > 0.2 ? 'high' : ratePct > 0.05 ? 'elevated' : 'normal')
        : 'normal',
      // severity_negative cubre el caso simétrico: shorts sobreextendidos (señal de squeeze alcista).
      severity_negative: ratePct < 0
        ? (ratePct < -0.5 ? 'extreme_short_overload' : ratePct < -0.2 ? 'high_short_overload' : ratePct < -0.05 ? 'elevated_short_overload' : null)
        : null,
      // Umbrales en %: longs sobrecargados > 0.1%, shorts sobrecargados < -0.05%.
      signal: ratePct > 0.1 ? 'longs_overloaded'
        : ratePct < -0.05 ? 'shorts_overloaded'
        : 'balanced',
      next_funding_time: entry.next_funding_time ?? null,
      predicted_rate:     predictedRatePct !== null ? parseFloat((predictedRatePct / 100).toFixed(8)) : null,
      predicted_rate_pct: predictedRatePct !== null ? parseFloat(predictedRatePct.toFixed(6)) : null,
      // Timestamp del propio dato de Coinalyze (`entry.update`, epoch ms) — distinto
      // del momento del fetch. Permite detectar desync con el precio spot (cache TTL 30min).
      data_timestamp_utc: entry.update ? new Date(entry.update).toISOString() : null,
    };

    cacheSet(cacheKey, result, env.cache.fundingRateTtl);

    // Alimentar histórico con TODO el rango devuelto por Coinalyze (no solo el
    // último candle) — la API ya trae 48h completas en cada llamada, así que
    // el histórico en memoria se rellena de golpe en vez de esperar 8 polls
    // espaciados. addFundingRateEntry hace upsert por timestamp, así que
    // reenviar candles ya conocidos es inofensivo.
    try {
      if (historyRes.status === 'fulfilled') {
        const hist = historyRes.value.data?.[0]?.history ?? [];
        hist.forEach((candle, idx) => {
          addFundingRateEntry(coin, {
            t: candle.t,
            o: candle.o,
            h: candle.h,
            l: candle.l,
            c: candle.c,
            // trend_48h solo tiene sentido en el candle más reciente.
            trend: idx === hist.length - 1 ? result.trend : null,
          });
        });
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
    // 7d completos: el histórico de 7d necesita 42 candles de 4h, no solo el
    // tramo de 24h que usa el cálculo de change_24h_pct.
    const from = now - 7 * 24 * 3600;

    const [currentRes, historyRes] = await Promise.allSettled([
      getClient().get('/open-interest', { params: { symbols: symbol } }),
      getClient().get('/open-interest-history', {
        params: { symbols: symbol, interval: '4hour', from, to: now },
      }),
    ]);

    const entry = currentRes.status === 'fulfilled' ? currentRes.value.data?.[0] : null;
    if (!entry) return null;

    const current = entry.value ?? 0;

    // Cambio 24h: comparar cierre actual vs open de hace ~24h (últimos 6 candles de 4h)
    let change_24h_pct = null;
    let signal = 'stable';
    if (historyRes.status === 'fulfilled') {
      const hist = historyRes.value.data?.[0]?.history ?? [];
      const last24h = hist.slice(-6);
      if (last24h.length >= 2) {
        const oldest = last24h[0].o;
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

    const result = {
      // Coinalyze devuelve el OI en UNIDADES BASE del instrumento (BTC/ETH/SOL), no en
      // USD — verificado contra convert_to_usd=true (auditoría #2, hallazgo 4). Se
      // mantiene como medida canónica (independiente del precio → change_24h_pct mide
      // posicionamiento real, no rallies); los controllers derivan el USD real con
      // withDerivedOiUsd (value_coins × precio spot) para display/LLM.
      value_coins: current,
      unit: 'base_coin',
      change_24h_pct,
      signal,
      // Timestamp del propio dato de Coinalyze (`entry.update`, epoch ms) — cache TTL 5min.
      data_timestamp_utc: entry.update ? new Date(entry.update).toISOString() : null,
    };

    cacheSet(cacheKey, result, env.cache.openInterestTtl);

    // Alimentar histórico con TODO el rango devuelto (ver razonamiento en
    // fetchFundingRate) — Coinalyze ya trae hasta 7d de candles de 4h por llamada.
    try {
      if (historyRes.status === 'fulfilled') {
        const hist = historyRes.value.data?.[0]?.history ?? [];
        for (const candle of hist) {
          addOpenInterestEntry(coin, {
            t: candle.t,
            o: candle.o,
            h: candle.h,
            l: candle.l,
            c: candle.c,
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

    // Indicador contrario, RELATIVO A LA BASE DEL PROPIO ACTIVO (auditoría de umbrales,
    // hallazgo T8). El corte fijo >60 % / <40 % daba por supuesto que un libro equilibrado
    // está en el 50 %, y eso no es cierto: medido sobre 90 días, la mediana de long% en SOL
    // es 72,7 % (p10 63,4 · p90 77,6). Con el umbral fijo, `contrarian_bear` salía el 95,7 %
    // del tiempo y `contrarian_bull` NUNCA — el flag no informaba de nada, y como es el único
    // input de expected_scores.derivatives cuando el funding es normal, dejaba esa guardia
    // convertida en una constante de −1.
    //
    // Lo que importa no es el nivel absoluto sino la desviación respecto a la norma DE ESE
    // activo: un 63 % de longs es poco para SOL y muchísimo para otro par. Se usan terciles
    // de la propia serie (7 días), que es la ventana que ya se descarga.
    //
    // NOTA — por qué aquí sí y en `funding severity` no: el posicionamiento es inherentemente
    // relativo (no hay un "50 % correcto" universal), mientras que el funding tiene significado
    // absoluto — un 0,5 % por periodo es un coste de carry insostenible en cualquier activo.
    // Ver percentiles.js.
    const longSeries = history.map((h) => h.l).filter(Number.isFinite);
    const bucket = bucketByPercentile(longPct, longSeries, {
      labels: ['shorts_dominant_contrarian_bull', 'balanced', 'longs_dominant_contrarian_bear'],
      minSample: 24,
    });
    // Sin serie suficiente se cae al criterio absoluto de antes (mejor que no emitir señal).
    const signal = bucket.label ?? (longPct > 60 ? 'longs_dominant_contrarian_bear'
      : longPct < 40 ? 'shorts_dominant_contrarian_bull'
      : 'balanced');

    const result = {
      long_pct: longPct,
      short_pct: shortPct,
      signal,
      // Trazabilidad de la calibración (mismo patrón que cvd_strength): sin esto no se puede
      // explicar a posteriori por qué un 72 % fue "balanced" un día y "contrarian_bear" otro.
      long_pct_percentile: bucket.percentile,
      signal_cuts: bucket.cuts,
      signal_basis: bucket.label ? 'percentile_7d' : 'absolute_fallback',
      source: 'coinalyze',
      // Timestamp del último candle horario usado (`latest.t`, epoch seconds).
      data_timestamp_utc: latest.t ? new Date(latest.t * 1000).toISOString() : null,
    };

    cacheSet(cacheKey, result, env.cache.longShortTtl);

    // Alimentar histórico con todos los entries disponibles
    try {
      for (const entry of history) {
        addLongShortRatioEntry(coin, {
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
    // 7d completos para poder rellenar de golpe el histórico de 7d (antes solo
    // se pedían 24h y el histórico tardaba una semana real en llenarse).
    const from = now - 7 * 24 * 3600;

    const { data } = await getClient().get('/liquidation-history', {
      params: { symbols: symbol, interval: '1hour', from, to: now },
    });

    const hist = data?.[0]?.history ?? [];
    if (!hist.length) return null;

    // "current" = ventana rolling de últimas 24h (últimos 24 candles de 1h),
    // no el día calendario — l = longs liquidados (precio bajó), s = shorts (precio subió)
    const last24h = hist.slice(-24);
    const longs_usd  = parseFloat(last24h.reduce((acc, h) => acc + (h.l ?? 0), 0).toFixed(2));
    const shorts_usd = parseFloat(last24h.reduce((acc, h) => acc + (h.s ?? 0), 0).toFixed(2));
    const total      = longs_usd + shorts_usd;

    // Señal: dominancia de un lado indica presión de mercado
    const ratio = total > 0 ? longs_usd / total : 0.5;
    const signal = ratio > 0.65 ? 'longs_dominant'   // más longs liquidados = bajada fuerte
      : ratio < 0.35 ? 'shorts_dominant'               // más shorts liquidados = short squeeze
      : 'balanced';

    const result = {
      longs_usd,
      shorts_usd,
      total_usd: total,
      signal,
      // Timestamp del último candle horario de la ventana rolling 24h usada arriba.
      data_timestamp_utc: last24h.length ? new Date(last24h.at(-1).t * 1000).toISOString() : null,
    };

    cacheSet(cacheKey, result, env.cache.liquidationsTtl);

    // Backfill histórico: agrupar los candles horarios por día calendario UTC
    // para rellenar hasta 7 días de golpe. El día de hoy se sobreescribe
    // después con la ventana rolling de 24h calculada arriba, para que quede
    // coherente con `result`.
    try {
      const byDate = new Map();
      for (const candle of hist) {
        const date = new Date(candle.t * 1000).toISOString().split('T')[0];
        const bucket = byDate.get(date) ?? { longs: 0, shorts: 0 };
        bucket.longs  += candle.l ?? 0;
        bucket.shorts += candle.s ?? 0;
        byDate.set(date, bucket);
      }
      for (const [date, { longs, shorts }] of byDate) {
        addLiquidationsEntry(coin, date, longs, shorts);
      }
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      addLiquidationsEntry(coin, today, longs_usd, shorts_usd);
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

/**
 * Deriva el OI en USD real (value_coins × precio spot) SIN mutar el objeto cacheado
 * (cacheGet devuelve la misma referencia). `value_usd` es DERIVADO, no viene del
 * exchange: value_usd_basis lo declara para que el LLM/consumidores conozcan la
 * procedencia. Función pura.
 * @param {object|null} derivatives - resultado de fetchDerivativesData
 * @param {number|null} price - precio spot actual
 * @returns {object|null}
 */
export function withDerivedOiUsd(derivatives, price) {
  const oi = derivatives?.open_interest;
  if (!oi || oi.value_coins == null || !price) return derivatives;
  return {
    ...derivatives,
    open_interest: {
      ...oi,
      value_usd: Math.round(oi.value_coins * price),
      value_usd_basis: 'derived_coins_x_spot',
    },
  };
}

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
