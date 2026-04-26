/**
 * etfFlowsService.js — Spot ETF flows BTC/ETH (SoSoValue)
 *
 * Fuente: SoSoValue OpenAPI v2 (sin auth, sin key, POST). Cubre BTC y ETH.
 * SOL no tiene spot ETF aprobado → devuelve null sin tocar la API.
 *
 * Endpoints:
 *   - POST /openapi/v2/etf/historicalInflowChart   → serie histórica diaria
 *   - POST /openapi/v2/etf/currentEtfDataMetrics   → snapshot actual + per-issuer
 *
 * Body: { type: 'us-btc-spot' | 'us-eth-spot' }
 *
 * En `currentEtfDataMetrics` los campos numéricos llegan envueltos como
 * { value: "string", lastUpdateDate, status }, así que extraemos `.value` y
 * parseamos. La serie histórica devuelve números directos.
 *
 * Cache 1h: los datos publican una vez al día (cierre US market). Cache negativo
 * 30 min cuando el fetch entero falla (sentinel `{__empty:true}`), mismo patrón
 * que onchainService.
 */

import axios from 'axios';
import { cacheGet, cacheSet } from './cacheService.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const BASE_URL = 'https://api.sosovalue.xyz/openapi/v2/etf';
const REQUEST_TIMEOUT = 8000;

const TYPE_BY_COIN = {
  BTC: 'us-btc-spot',
  ETH: 'us-eth-spot',
};

/**
 * @param {string} coin — 'BTC' | 'ETH' | 'SOL'. SOL → null (sin spot ETF).
 * @returns {Promise<object|null>}
 */
export async function fetchEtfFlows(coin) {
  const type = TYPE_BY_COIN[coin];
  if (!type) return null;

  const cacheKey = `etf_flows:${coin}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return cached.__empty ? null : cached;
  }

  try {
    const [historyRes, currentRes] = await Promise.allSettled([
      axios.post(`${BASE_URL}/historicalInflowChart`, { type },
        { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json' } }),
      axios.post(`${BASE_URL}/currentEtfDataMetrics`, { type },
        { timeout: REQUEST_TIMEOUT, headers: { 'Content-Type': 'application/json' } }),
    ]);

    const historyData = historyRes.status === 'fulfilled' && historyRes.value.data?.code === 0
      ? historyRes.value.data.data
      : null;
    const currentData = currentRes.status === 'fulfilled' && currentRes.value.data?.code === 0
      ? currentRes.value.data.data
      : null;

    if (!historyData && !currentData) {
      logger.warn({ coin }, 'ETF flows: both endpoints failed, caching negative');
      cacheSet(cacheKey, { __empty: true }, env.cache.etfFlowsNegativeTtl);
      return null;
    }

    const historySorted = Array.isArray(historyData)
      ? [...historyData].sort((a, b) => a.date.localeCompare(b.date))
      : [];

    // Yesterday: último entry de la serie histórica (los datos publican con un día
    // de retraso respecto al cierre). El snapshot `dailyNetInflow` también lo trae,
    // pero la serie es la fuente canónica para alinear con `7d_sum` y `trend_7d`.
    //
    // NOTA DE CAMPO (verificado 2026-04-26): en la respuesta de SoSoValue,
    //   totalNetInflow = flujo DIARIO de ese día (puede ser negativo)
    //   cumNetInflow   = acumulado desde inception (~$39B para BTC)
    // Por tanto usar totalNetInflow aquí es correcto; NO confundirlo con cumNetInflow.
    const lastEntry = historySorted.at(-1) ?? null;
    const totalNetFlowYesterday = lastEntry ? num(lastEntry.totalNetInflow) : null;

    // 7d sum: últimos 7 puntos de la serie. Días sin trading (fin de semana,
    // festivos US) no aparecen en la serie, así que "últimos 7 entries" ≈ últimas
    // ~10 días naturales — suficiente para un proxy semanal de momentum.
    const last7 = historySorted.slice(-7);
    const total7dSum = last7.length > 0
      ? parseFloat(last7.reduce((s, e) => s + (num(e.totalNetInflow) ?? 0), 0).toFixed(2))
      : null;

    // trend_7d: comparar primer vs último cumNetInflow del tramo de 7 puntos.
    // Acumulando inflows = accumulating; acumulando outflows = distributing.
    const trend7d = classifyTrend(last7);

    // by_issuer[]: extraer del snapshot. Solo top 10 por netAssets para no
    // saturar el payload (BTC ETF tiene ~11 issuers, ETH ~9).
    const issuerList = Array.isArray(currentData?.list) ? currentData.list : [];
    const byIssuer = issuerList
      .map(item => ({
        ticker:            item.ticker?.trim() ?? null,
        institute:         item.institute?.trim() ?? null,
        daily_net_inflow_usd: num(item.dailyNetInflow?.value),
        net_assets_usd:    num(item.netAssets?.value),
        fee_pct:           num(item.fee?.value),
      }))
      .filter(e => e.ticker)
      .sort((a, b) => (b.net_assets_usd ?? 0) - (a.net_assets_usd ?? 0))
      .slice(0, 10);

    const result = {
      total_net_flow_usd_yesterday: totalNetFlowYesterday,
      total_net_flow_usd_7d_sum:    total7dSum,
      trend_7d:                     trend7d,
      by_issuer:                    byIssuer,
      as_of:                        lastEntry?.date ?? null,
      source:                       'sosovalue.xyz',
    };

    cacheSet(cacheKey, result, env.cache.etfFlowsTtl);
    return result;
  } catch (err) {
    logger.warn({ coin, err: err.message }, 'ETF flows fetch failed, caching negative');
    cacheSet(cacheKey, { __empty: true }, env.cache.etfFlowsNegativeTtl);
    return null;
  }
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Clasifica la tendencia 7d: accumulating (inflows netos), distributing (outflows
 * netos), o neutral (suma cercana a cero relativa al tamaño típico).
 * Umbral 100M USD: por debajo el ruido diario domina al ETF agregado.
 */
function classifyTrend(entries) {
  if (!entries || entries.length === 0) return null;
  const sum = entries.reduce((s, e) => s + (num(e.totalNetInflow) ?? 0), 0);
  const THRESHOLD_USD = 100_000_000;
  if (sum > THRESHOLD_USD) return 'accumulating';
  if (sum < -THRESHOLD_USD) return 'distributing';
  return 'neutral';
}
