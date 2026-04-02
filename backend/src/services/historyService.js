/**
 * historyService.js — Gestión de históricos en memoria para análisis del LLM
 *
 * Almacena secuencias cortas de datos (7-30 días) para proporcionar contexto
 * temporal al análisis de mercado. Los datos se mantienen en memoria y se
 * limpian automáticamente cuando superan los límites.
 *
 * Exportadas:
 *   addFearGreedEntry(value, classification, trend)
 *   addFundingRateEntry(candle)                          — {t, o, h, l, c, trend}
 *   addOpenInterestEntry(candle)                         — {t, o, h, l, c}
 *   addLongShortRatioEntry(entry)                        — {t, long_pct, short_pct}
 *   addLiquidationsEntry(date, longs_usd, shorts_usd)
 *   getHistories()                                       — retorna todos los históricos
 */

import logger from '../middleware/logger.js';

// Límites de entries almacenadas
const LIMITS = {
  fearGreed:      30,    // 30 días
  fundingRate:    8,     // 48h @ 6h interval = 8 candles
  openInterest:   42,    // 7d @ 4h interval = 42 candles
  longShortRatio: 168,   // 7d @ 1h interval = 168 candles
  liquidations:   7,     // 7 días (1 entry/día)
};

const histories = {
  fearGreed:      [],
  fundingRate:    [],
  openInterest:   [],
  longShortRatio: [],
  liquidations:   [],
};

// ─── Fear & Greed ─────────────────────────────────────────────────────────

export function addFearGreedEntry(value, classification, trend) {
  if (value == null || classification == null) return;

  const entry = {
    date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
    value,
    classification,
    trend,
  };

  // Evitar duplicados del mismo día
  if (histories.fearGreed.length > 0) {
    const last = histories.fearGreed[histories.fearGreed.length - 1];
    if (last.date === entry.date) {
      histories.fearGreed[histories.fearGreed.length - 1] = entry;
      return;
    }
  }

  histories.fearGreed.push(entry);
  if (histories.fearGreed.length > LIMITS.fearGreed) {
    histories.fearGreed.shift();
  }
}

// ─── Funding Rate ────────────────────────────────────────────────────────

export function addFundingRateEntry(candle) {
  if (!candle || candle.t == null) return;

  const entry = { ...candle }; // { t, o, h, l, c, trend }

  // Evitar duplicados del mismo timestamp
  if (histories.fundingRate.length > 0) {
    const last = histories.fundingRate[histories.fundingRate.length - 1];
    if (last.t === entry.t) {
      histories.fundingRate[histories.fundingRate.length - 1] = entry;
      return;
    }
  }

  histories.fundingRate.push(entry);
  if (histories.fundingRate.length > LIMITS.fundingRate) {
    histories.fundingRate.shift();
  }
}

// ─── Open Interest ────────────────────────────────────────────────────────

export function addOpenInterestEntry(candle) {
  if (!candle || candle.t == null) return;

  const entry = { ...candle }; // { t, o, h, l, c }

  // Evitar duplicados
  if (histories.openInterest.length > 0) {
    const last = histories.openInterest[histories.openInterest.length - 1];
    if (last.t === entry.t) {
      histories.openInterest[histories.openInterest.length - 1] = entry;
      return;
    }
  }

  histories.openInterest.push(entry);
  if (histories.openInterest.length > LIMITS.openInterest) {
    histories.openInterest.shift();
  }
}

// ─── Long/Short Ratio ────────────────────────────────────────────────────

export function addLongShortRatioEntry(entry) {
  if (!entry || entry.t == null) return;

  const data = { ...entry }; // { t, long_pct, short_pct }

  // Evitar duplicados
  if (histories.longShortRatio.length > 0) {
    const last = histories.longShortRatio[histories.longShortRatio.length - 1];
    if (last.t === entry.t) {
      histories.longShortRatio[histories.longShortRatio.length - 1] = data;
      return;
    }
  }

  histories.longShortRatio.push(data);
  if (histories.longShortRatio.length > LIMITS.longShortRatio) {
    histories.longShortRatio.shift();
  }
}

// ─── Liquidaciones ────────────────────────────────────────────────────────

export function addLiquidationsEntry(date, longs_usd, shorts_usd) {
  if (date == null || longs_usd == null || shorts_usd == null) return;

  const entry = {
    date,  // YYYY-MM-DD format
    longs_usd: parseFloat(longs_usd.toFixed(2)),
    shorts_usd: parseFloat(shorts_usd.toFixed(2)),
  };

  // Evitar duplicados del mismo día
  if (histories.liquidations.length > 0) {
    const last = histories.liquidations[histories.liquidations.length - 1];
    if (last.date === entry.date) {
      histories.liquidations[histories.liquidations.length - 1] = entry;
      return;
    }
  }

  histories.liquidations.push(entry);
  if (histories.liquidations.length > LIMITS.liquidations) {
    histories.liquidations.shift();
  }
}

// ─── Getter ───────────────────────────────────────────────────────────────

/**
 * Retorna todos los históricos actuales (lectura).
 * Los datos se pasan tal cual al response JSON para el LLM.
 */
export function getHistories() {
  return {
    fear_greed: [...histories.fearGreed],        // copia para evitar mutaciones
    funding_rate: [...histories.fundingRate],
    open_interest: [...histories.openInterest],
    long_short_ratio: [...histories.longShortRatio],
    liquidations: [...histories.liquidations],
  };
}

// ─── Debug ────────────────────────────────────────────────────────────────

export function logHistoriesSummary() {
  logger.info({
    fearGreedEntries: histories.fearGreed.length,
    fundingRateEntries: histories.fundingRate.length,
    openInterestEntries: histories.openInterest.length,
    longShortRatioEntries: histories.longShortRatio.length,
    liquidationsEntries: histories.liquidations.length,
  }, 'Historical data summary');
}
