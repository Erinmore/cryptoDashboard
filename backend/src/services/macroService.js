/**
 * macroService.js — Macro context: DXY, S&P 500, Gold (Yahoo Finance v8)
 *
 * Fuente: Yahoo Finance chart API (sin auth, sin key). User-Agent obligatorio
 * para evitar bloqueos. Una request por símbolo, en paralelo.
 *
 * Stooq descartado: el endpoint histórico ahora exige API key con captcha
 * humano y el endpoint quote actual no devuelve histórico (sin trend_5d).
 *
 * Símbolos:
 *   - DXY  → DX-Y.NYB   (US Dollar Index)
 *   - SPX  → ^GSPC      (S&P 500)
 *   - Gold → GC=F       (Gold futures front-month)
 *
 * El payload macro es coin-agnóstico: el contexto DXY/SPX/Gold no depende
 * de BTC/ETH/SOL. Cache en clave única `macro:global`.
 */

import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const REQUEST_TIMEOUT = 8000;
const USER_AGENT = 'Mozilla/5.0 (compatible; CryptexDashboard/1.0)';

const SYMBOLS = {
  dxy:  'DX-Y.NYB',
  spx:  '^GSPC',
  gold: 'GC=F',
};

/**
 * @returns {Promise<object|null>}
 */
export async function fetchMacroData() {
  const cacheKey = 'macro:global';
  const cached = cacheGet(cacheKey);
  if (cached) {
    return cached.__empty ? null : cached;
  }

  try {
    const entries = Object.entries(SYMBOLS);
    const results = await Promise.allSettled(
      entries.map(([_, symbol]) => fetchSymbol(symbol))
    );

    const out = {};
    let anyOk = false;
    for (let i = 0; i < entries.length; i++) {
      const [key] = entries[i];
      const r = results[i];
      if (r.status === 'fulfilled' && r.value) {
        out[key] = r.value;
        anyOk = true;
      } else {
        out[key] = null;
      }
    }

    if (!anyOk) {
      logger.warn('Macro: all symbols failed, caching negative');
      cacheSet(cacheKey, { __empty: true }, env.cache.macroNegativeTtl);
      return null;
    }

    out.source = 'yahoo-finance';
    cacheSet(cacheKey, out, env.cache.macroTtl);
    return out;
  } catch (err) {
    logger.warn({ err: err.message }, 'Macro fetch failed, caching negative');
    cacheSet(cacheKey, { __empty: true }, env.cache.macroNegativeTtl);
    return null;
  }
}

/**
 * @param {string} symbol — Yahoo Finance ticker
 * @returns {Promise<{value, change_24h_pct, trend_5d}|null>}
 */
async function fetchSymbol(symbol) {
  const url = `${BASE_URL}/${encodeURIComponent(symbol)}?interval=1d&range=10d`;
  const res = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });

  const result = res.data?.chart?.result?.[0];
  if (!result) return null;

  // meta.regularMarketPrice es el precio canónico actual (incluye intradía).
  // Los closes son OHLC histórico diario; pueden traer null en días sin cierre
  // o en la barra de "hoy" si el mercado sigue abierto.
  const value = num(result.meta?.regularMarketPrice);
  const closesRaw = result.indicators?.quote?.[0]?.close ?? [];
  const closes = closesRaw.map(num).filter(v => v !== null);

  if (value === null && closes.length === 0) return null;

  // change_24h_pct: cambio de la última sesión de mercado (último cierre vs el anterior).
  // Semántica: en fin de semana o festivo no hay nueva barra — el valor se congela
  // en el cambio viernes-jueves hasta el lunes. No es "últimas 24h calendario".
  let change24hPct = null;
  if (closes.length >= 2) {
    const prev = closes.at(-2);
    const last = closes.at(-1);
    if (prev > 0) change24hPct = parseFloat(((last - prev) / prev * 100).toFixed(2));
  }

  // trend_5d: comparar último close con close de hace 5 sesiones (≈1 semana).
  // Si no hay 5 puntos, comparar con el primero disponible.
  const trend5d = classifyTrend(closes);

  return {
    value:           value ?? closes.at(-1) ?? null,
    change_24h_pct:  change24hPct,
    trend_5d:        trend5d,
  };
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * trend_5d: rising/falling/flat según cambio % entre cierre de hace ≤5 sesiones
 * y el último cierre. Umbral 0.5% para evitar marcar ruido como tendencia
 * (DXY se mueve 0.1-0.3%/día típicamente; SPX 0.3-0.8%; Gold 0.5-1.5%).
 */
function classifyTrend(closes) {
  if (!closes || closes.length < 2) return null;
  const last = closes.at(-1);
  const refIdx = Math.max(0, closes.length - 6); // ~5 sesiones atrás
  const ref = closes[refIdx];
  if (!ref || ref === 0) return null;
  const changePct = (last - ref) / ref * 100;
  if (changePct > 0.5) return 'rising';
  if (changePct < -0.5) return 'falling';
  return 'flat';
}
