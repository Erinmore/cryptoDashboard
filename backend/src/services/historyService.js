/**
 * historyService.js — Gestión de históricos en memoria para análisis del LLM
 *
 * Almacena secuencias cortas de datos (7-30 días) para proporcionar contexto
 * temporal al análisis de mercado. Los datos se mantienen en memoria y se
 * limpian automáticamente cuando superan los límites.
 *
 * Todas las series son por-coin (BTC/ETH/SOL tienen históricos independientes),
 * excepto Fear & Greed que es un índice de mercado global compartido.
 *
 * Exportadas:
 *   addFearGreedEntry(value, classification, trend, date?)
 *   addFundingRateEntry(coin, candle)                          — {t, o, h, l, c, trend}
 *   addOpenInterestEntry(coin, candle)                         — {t, o, h, l, c}
 *   addLongShortRatioEntry(coin, entry)                        — {t, long_pct, short_pct}
 *   addLiquidationsEntry(coin, date, longs_coins, shorts_coins)
 *   addCVDEntry(coin, date, value, trend, divergence, delta?)
 *   addVWAPEntry(coin, date, value, trend, divergence)
 *   getHistories(coin)                                         — retorna los históricos del coin + fear_greed global
 */

import logger from '../middleware/logger.js';
import { getDb } from '../config/db.js';

// Límites de entries almacenadas EN MEMORIA (= ventana visible al LLM).
const LIMITS = {
  fearGreed:      30,    // 30 días
  fundingRate:    8,     // 48h @ 6h interval = 8 candles
  openInterest:   42,    // 7d @ 4h interval = 42 candles
  longShortRatio: 168,   // 7d @ 1h interval = 168 candles
  liquidations:   7,     // 7 días (1 entry/día)
  cvd:            30,    // 30 días (1 entry/día)
  vwap:           30,    // 30 días (1 entry/día)
};

// ─── Persistencia SQLite (tabla history_series) ────────────────────────────
//
// Write-through para TODAS las métricas (acumula histórico para backtesting).
// Sólo CVD y VWAP se hidratan en memoria al arrancar: son las únicas sin fuente
// externa de histórico. El resto (funding/oi/lsr/liq/fear_greed) se rellenan
// frescas desde su API en cada poll dentro de la ventana del LLM — hidratarlas
// además rompería el dedup append-only del backfill (que sólo compara el último
// elemento). En DB se conserva más que la ventana en memoria (DB_RETENTION_DAYS).

const METRIC_NAME = {
  fearGreed:      'fear_greed',
  fundingRate:    'funding_rate',
  openInterest:   'open_interest',
  longShortRatio: 'long_short_ratio',
  liquidations:   'liquidations',
  cvd:            'cvd',
  vwap:           'vwap',
};

const DB_RETENTION_DAYS = 400;  // > cualquier ventana en memoria
const DAY_SEC = 86400;

// epoch (seg) de la medianoche UTC de una fecha YYYY-MM-DD. null si inválida.
function dateToTsKey(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// Cache de prepared statements, invalidado si la conexión cambia (tests, reinicio).
let _db = null;
const _stmtCache = new Map();
function stmt(sql) {
  const d = getDb(); // lanza si la DB no está inicializada
  if (d !== _db) { _db = d; _stmtCache.clear(); }
  let s = _stmtCache.get(sql);
  if (!s) { s = d.prepare(sql); _stmtCache.set(sql, s); }
  return s;
}

// Upsert idempotente. Ante DB no inicializada o error puntual, degrada a memoria-only.
function persist(coin, metric, tsKey, entry) {
  if (tsKey == null) return;
  try {
    stmt(`INSERT INTO history_series (coin, metric, ts_key, payload)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(coin, metric, ts_key) DO UPDATE SET payload = excluded.payload`)
      .run(coin, metric, tsKey, JSON.stringify(entry));
  } catch (err) {
    logger.debug({ err: err.message, coin, metric }, 'history_series persist skipped');
  }
}

// Poda lo más viejo que DB_RETENTION_DAYS y devuelve los últimos `limit` (oldest→newest).
function loadSeries(coin, metric, limit) {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - DB_RETENTION_DAYS * DAY_SEC;
    stmt(`DELETE FROM history_series WHERE coin = ? AND metric = ? AND ts_key < ?`)
      .run(coin, metric, cutoff);
    const rows = stmt(`SELECT payload FROM history_series
                       WHERE coin = ? AND metric = ?
                       ORDER BY ts_key DESC LIMIT ?`)
      .all(coin, metric, limit);
    return rows.reverse().map(r => JSON.parse(r.payload)); // newest→oldest ⇒ oldest→newest
  } catch (err) {
    logger.debug({ err: err.message, coin, metric }, 'history_series load skipped');
    return [];
  }
}

/**
 * Upsert idempotente en una serie en memoria, deduplicando por `key` sobre TODO el
 * array (no solo el último elemento). Mantiene orden ascendente por `key` y recorta a
 * los últimos `limit`. Robusto ante backfills reenviados en cualquier tamaño/orden —
 * antes el dedup comparaba solo el último elemento y solo funcionaba por la coincidencia
 * frágil de que el nº de candles del backfill == limit exacto (ver A7 en SESSION_STATE).
 * `key` vale tanto para `t` numérico como para `date` ISO ('YYYY-MM-DD' ordena lexicográfico).
 */
function upsertByKey(history, entry, key, limit) {
  const idx = history.findIndex((e) => e[key] === entry[key]);
  if (idx !== -1) {
    history[idx] = entry;
  } else {
    history.push(entry);
  }
  history.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0));
  if (history.length > limit) history.splice(0, history.length - limit);
}

// Fear & Greed es un índice de mercado global — una sola serie compartida.
const fearGreedHistory = [];

// El resto de series son por coin: { BTC: {fundingRate: [], ...}, ETH: {...}, SOL: {...} }
const coinHistories = {};

function getCoinHistory(coin) {
  if (!coinHistories[coin]) {
    coinHistories[coin] = {
      fundingRate:    [],
      openInterest:   [],
      longShortRatio: [],
      liquidations:   [],
      // Hidratadas desde DB (únicas sin backfill externo); [] si vacío o DB no lista.
      cvd:            loadSeries(coin, METRIC_NAME.cvd,  LIMITS.cvd),
      vwap:           loadSeries(coin, METRIC_NAME.vwap, LIMITS.vwap),
    };
  }
  return coinHistories[coin];
}

// ─── Fear & Greed (global, no por coin) ────────────────────────────────────

export function addFearGreedEntry(value, classification, trend, date = null) {
  if (value == null || classification == null) return;

  const entry = {
    date: date || new Date().toISOString().split('T')[0], // YYYY-MM-DD
    value,
    classification,
    trend,
  };

  // Fear & Greed es global — se persiste bajo coin 'GLOBAL'.
  persist('GLOBAL', METRIC_NAME.fearGreed, dateToTsKey(entry.date), entry);
  upsertByKey(fearGreedHistory, entry, 'date', LIMITS.fearGreed);
}

// ─── Funding Rate ────────────────────────────────────────────────────────

export function addFundingRateEntry(coin, candle) {
  if (!coin || !candle || candle.t == null) return;
  const history = getCoinHistory(coin).fundingRate;

  const entry = { ...candle }; // { t, o, h, l, c, trend }
  persist(coin, METRIC_NAME.fundingRate, entry.t, entry);
  upsertByKey(history, entry, 't', LIMITS.fundingRate);
}

// ─── Open Interest ────────────────────────────────────────────────────────

export function addOpenInterestEntry(coin, candle) {
  if (!coin || !candle || candle.t == null) return;
  const history = getCoinHistory(coin).openInterest;

  const entry = { ...candle }; // { t, o, h, l, c }
  persist(coin, METRIC_NAME.openInterest, entry.t, entry);
  upsertByKey(history, entry, 't', LIMITS.openInterest);
}

// ─── Long/Short Ratio ────────────────────────────────────────────────────

export function addLongShortRatioEntry(coin, entry) {
  if (!coin || !entry || entry.t == null) return;
  const history = getCoinHistory(coin).longShortRatio;

  const data = { ...entry }; // { t, long_pct, short_pct }
  persist(coin, METRIC_NAME.longShortRatio, data.t, data);
  upsertByKey(history, data, 't', LIMITS.longShortRatio);
}

// ─── Liquidaciones ────────────────────────────────────────────────────────

/**
 * ⚠️ UNIDAD: en MONEDAS BASE, no en USD (Coinalyze reporta así; corregido 2026-07-29). Aquí
 * NO se puede derivar el USD como en el valor actual, porque haría falta el precio spot de
 * cada día pasado y no se guarda. Las filas persistidas ANTES del fix llevan las claves
 * `longs_usd`/`shorts_usd` con contenido en monedas: los lectores aceptan ambas.
 */
export function addLiquidationsEntry(coin, date, longs_coins, shorts_coins) {
  if (!coin || date == null || longs_coins == null || shorts_coins == null) return;
  const history = getCoinHistory(coin).liquidations;

  const entry = {
    date,  // YYYY-MM-DD format
    longs_coins: parseFloat(longs_coins.toFixed(4)),
    shorts_coins: parseFloat(shorts_coins.toFixed(4)),
  };
  persist(coin, METRIC_NAME.liquidations, dateToTsKey(entry.date), entry);
  upsertByKey(history, entry, 'date', LIMITS.liquidations);
}

// ─── CVD ──────────────────────────────────────────────────────────────────

export function addCVDEntry(coin, date, value, trend, divergence, delta = null) {
  if (!coin || value == null) return;
  const history = getCoinHistory(coin).cvd;

  const entry = {
    date: date || new Date().toISOString().split('T')[0], // YYYY-MM-DD
    value,
    // Delta neto de la vela 1D del día (estacionario). `value` es acumulativo sobre una
    // ventana rodante → su base deriva entre días; el summary reconstruye una serie
    // acumulada con base consistente a partir de `delta`. null en entries pre-fix.
    delta,
    trend,
    divergence,
  };
  persist(coin, METRIC_NAME.cvd, dateToTsKey(entry.date), entry);
  upsertByKey(history, entry, 'date', LIMITS.cvd);
}

// ─── VWAP ─────────────────────────────────────────────────────────────────

export function addVWAPEntry(coin, date, value, trend, divergence) {
  if (!coin || value == null) return;
  const history = getCoinHistory(coin).vwap;

  const entry = {
    date: date || new Date().toISOString().split('T')[0], // YYYY-MM-DD
    value,
    trend,
    divergence,
  };
  persist(coin, METRIC_NAME.vwap, dateToTsKey(entry.date), entry);
  upsertByKey(history, entry, 'date', LIMITS.vwap);
}

// ─── Getter ───────────────────────────────────────────────────────────────

/**
 * Retorna los históricos de un coin (lectura) + Fear & Greed global.
 * Los datos se pasan tal cual al response JSON para el LLM.
 */
export function getHistories(coin) {
  const history = getCoinHistory(coin);
  return {
    fear_greed: [...fearGreedHistory],          // copia para evitar mutaciones, global
    funding_rate: [...history.fundingRate],
    open_interest: [...history.openInterest],
    long_short_ratio: [...history.longShortRatio],
    liquidations: [...history.liquidations],
    cvd: [...history.cvd],
    vwap: [...history.vwap],
  };
}

// ─── Debug ────────────────────────────────────────────────────────────────

export function logHistoriesSummary() {
  const perCoin = Object.fromEntries(
    Object.entries(coinHistories).map(([coin, h]) => [coin, {
      fundingRateEntries: h.fundingRate.length,
      openInterestEntries: h.openInterest.length,
      longShortRatioEntries: h.longShortRatio.length,
      liquidationsEntries: h.liquidations.length,
      cvdEntries: h.cvd.length,
      vwapEntries: h.vwap.length,
    }]),
  );

  logger.info({
    fearGreedEntries: fearGreedHistory.length,
    ...perCoin,
  }, 'Historical data summary');
}
