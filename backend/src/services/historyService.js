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
 *   addLiquidationsEntry(coin, date, longs_usd, shorts_usd)
 *   addCVDEntry(coin, date, value, trend, divergence)
 *   addVWAPEntry(coin, date, value, trend, divergence)
 *   getHistories(coin)                                         — retorna los históricos del coin + fear_greed global
 */

import logger from '../middleware/logger.js';

// Límites de entries almacenadas
const LIMITS = {
  fearGreed:      30,    // 30 días
  fundingRate:    8,     // 48h @ 6h interval = 8 candles
  openInterest:   42,    // 7d @ 4h interval = 42 candles
  longShortRatio: 168,   // 7d @ 1h interval = 168 candles
  liquidations:   7,     // 7 días (1 entry/día)
  cvd:            30,    // 30 días (1 entry/día)
  vwap:           30,    // 30 días (1 entry/día)
};

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
      cvd:            [],
      vwap:           [],
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

  // Evitar duplicados del mismo día
  if (fearGreedHistory.length > 0) {
    const last = fearGreedHistory[fearGreedHistory.length - 1];
    if (last.date === entry.date) {
      fearGreedHistory[fearGreedHistory.length - 1] = entry;
      return;
    }
  }

  fearGreedHistory.push(entry);
  if (fearGreedHistory.length > LIMITS.fearGreed) {
    fearGreedHistory.shift();
  }
}

// ─── Funding Rate ────────────────────────────────────────────────────────

export function addFundingRateEntry(coin, candle) {
  if (!coin || !candle || candle.t == null) return;
  const history = getCoinHistory(coin).fundingRate;

  const entry = { ...candle }; // { t, o, h, l, c, trend }

  // Evitar duplicados del mismo timestamp
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.t === entry.t) {
      history[history.length - 1] = entry;
      return;
    }
  }

  history.push(entry);
  if (history.length > LIMITS.fundingRate) {
    history.shift();
  }
}

// ─── Open Interest ────────────────────────────────────────────────────────

export function addOpenInterestEntry(coin, candle) {
  if (!coin || !candle || candle.t == null) return;
  const history = getCoinHistory(coin).openInterest;

  const entry = { ...candle }; // { t, o, h, l, c }

  // Evitar duplicados
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.t === entry.t) {
      history[history.length - 1] = entry;
      return;
    }
  }

  history.push(entry);
  if (history.length > LIMITS.openInterest) {
    history.shift();
  }
}

// ─── Long/Short Ratio ────────────────────────────────────────────────────

export function addLongShortRatioEntry(coin, entry) {
  if (!coin || !entry || entry.t == null) return;
  const history = getCoinHistory(coin).longShortRatio;

  const data = { ...entry }; // { t, long_pct, short_pct }

  // Evitar duplicados
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.t === entry.t) {
      history[history.length - 1] = data;
      return;
    }
  }

  history.push(data);
  if (history.length > LIMITS.longShortRatio) {
    history.shift();
  }
}

// ─── Liquidaciones ────────────────────────────────────────────────────────

export function addLiquidationsEntry(coin, date, longs_usd, shorts_usd) {
  if (!coin || date == null || longs_usd == null || shorts_usd == null) return;
  const history = getCoinHistory(coin).liquidations;

  const entry = {
    date,  // YYYY-MM-DD format
    longs_usd: parseFloat(longs_usd.toFixed(2)),
    shorts_usd: parseFloat(shorts_usd.toFixed(2)),
  };

  // Evitar duplicados del mismo día
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.date === entry.date) {
      history[history.length - 1] = entry;
      return;
    }
  }

  history.push(entry);
  if (history.length > LIMITS.liquidations) {
    history.shift();
  }
}

// ─── CVD ──────────────────────────────────────────────────────────────────

export function addCVDEntry(coin, date, value, trend, divergence) {
  if (!coin || value == null) return;
  const history = getCoinHistory(coin).cvd;

  const entry = {
    date: date || new Date().toISOString().split('T')[0], // YYYY-MM-DD
    value,
    trend,
    divergence,
  };

  // Evitar duplicados del mismo día
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.date === entry.date) {
      history[history.length - 1] = entry;
      return;
    }
  }

  history.push(entry);
  if (history.length > LIMITS.cvd) {
    history.shift();
  }
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

  // Evitar duplicados del mismo día
  if (history.length > 0) {
    const last = history[history.length - 1];
    if (last.date === entry.date) {
      history[history.length - 1] = entry;
      return;
    }
  }

  history.push(entry);
  if (history.length > LIMITS.vwap) {
    history.shift();
  }
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
