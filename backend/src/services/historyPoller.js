/**
 * historyPoller.js — Poller de fondo que persiste history_series de TODAS las monedas.
 *
 * Problema que resuelve: la persistencia normal es request-driven y el frontend solo
 * pide `/api/data` de la moneda visualizada, así que las demás no acumulan histórico.
 * Para CVD/VWAP —que se calculan localmente y no tienen backfill externo— eso significa
 * perder el snapshot diario de las monedas no vistas para siempre. Este poller recorre
 * las 3 monedas cada `HISTORY_POLLER_INTERVAL_SEC` y escribe su history_series,
 * desacoplando la persistencia de lo que se mira en el frontend.
 *
 * Coste: apoyado en las caches existentes (Binance klines / Coinalyze). Fear & Greed es
 * global → se refresca una vez por ciclo. Se arranca en index.js (no en app.js), así que
 * los tests —que importan app.js— no lo activan.
 */

import { fetchOHLC } from './coingeckoService.js';
import { fetchDerivativesData } from './coinalyzeService.js';
import { fetchFearGreed } from './fearGreedService.js';
import { computeIndicators } from './indicatorService.js';
import { addCVDEntry, addVWAPEntry } from './historyService.js';
import { COINS } from '../config/constants.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

let timer = null;

/** Persiste el snapshot de una moneda (CVD/VWAP diario + backfill de derivados). */
async function pollCoin(coin) {
  try {
    // CVD/VWAP: snapshot diario desde velas 1D. Ninguna API los sirve ya calculados, pero al
    // ser función pura de estas velas SÍ se reconstruyen a posteriori (backfillHistorySeries.mjs).
    const candles1D = await fetchOHLC(coin, '1D');
    if (candles1D?.length) {
      const ind = computeIndicators(candles1D, '1D');
      const today = new Date().toISOString().split('T')[0];
      if (ind?.cvd)  addCVDEntry(coin,  today, ind.cvd.value,  ind.cvd.trend,  ind.cvd.divergence, ind.cvd.last_candle_delta);
      if (ind?.vwap) addVWAPEntry(coin, today, ind.vwap.value, ind.vwap.trend, ind.vwap.divergence);
    }
    // Derivados: dispara el backfill de funding/oi/lsr/liq en history_series (no-op sin key).
    await fetchDerivativesData(coin);
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'historyPoller: fallo poblando moneda');
  }
}

/** Un ciclo completo: Fear & Greed (global) + las 3 monedas en serie. */
async function pollAll() {
  try { await fetchFearGreed(); } catch { /* degradado, no bloquea */ }
  for (const coin of COINS) {
    await pollCoin(coin);
  }
  logger.debug({ coins: COINS }, 'historyPoller: ciclo completado');
}

/**
 * Arranca el poller (idempotente). Devuelve el timer o null si está deshabilitado.
 */
export function startHistoryPoller() {
  if (!env.historyPollerEnabled) {
    logger.info('historyPoller deshabilitado (HISTORY_POLLER_ENABLED=false)');
    return null;
  }
  if (timer) return timer;

  const intervalMs = env.historyPollerIntervalSec * 1000;

  // Primer ciclo poco después de arrancar (deja que el server termine de levantar).
  setTimeout(() => { pollAll().catch(() => {}); }, 3000);
  timer = setInterval(() => { pollAll().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref(); // no impedir el cierre limpio del proceso

  logger.info(
    { intervalSec: env.historyPollerIntervalSec, coins: COINS },
    'historyPoller arrancado — persistiendo history_series de todas las monedas',
  );
  return timer;
}

/** Detiene el poller (usado en graceful shutdown / tests). */
export function stopHistoryPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
