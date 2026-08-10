/**
 * outcomeService.js — Job que rellena `analysis_outcome` con la grabación PURA de mercado
 * tras cada análisis: precios a 1h/4h/24h/7d y métricas de recorrido (excursiones, primer
 * cruce de cada múltiplo de ATR). Idempotente: reprocesa solo lo que falta hasta cerrar el
 * horizonte de 7d.
 *
 * Pivot a ayudante de riesgo (§REORIENTACIÓN, ver CLAUDE.md): el barrier del `setup`
 * ejecutable y el shadow trade del `conditional_setup` se retiraron — ninguno de los dos
 * conceptos se vuelve a producir desde que el LLM dejó de decidir. Las filas viejas
 * conservan sus columnas `setup_*`/`cond_*` tal cual quedaron (no se re-evalúan); las
 * nuevas las dejan en NULL. Lo que sigue corriendo es la base de grabación SIMÉTRICA que
 * algún día permitiría comprobar si `TARGET_REACHABILITY` (la curva que usa
 * `utils/riskGeometry.js`) se sostiene con datos nuevos — construir esa validación no es
 * parte de este pivot, solo la grabación que la haría posible.
 *
 * Se arranca en index.js (no en app.js) → no corre en los tests. También expuesto
 * como `runOutcomeJob()` para disparo manual (endpoint / on-demand).
 */

import { fetchHistoricalClose, fetchHistoricalKlines } from './coingeckoService.js';
import { getAnalysesNeedingOutcome, upsertOutcome } from './dbService.js';
import { classifyOutcome } from '../utils/outcome.js';
import { computePathMetrics, computeAtrPct } from '../utils/pathMetrics.js';
import { calculateATR } from '../utils/indicators.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const HOUR_MS = 3600 * 1000;
const HORIZONS = [
  ['1h',  1 * HOUR_MS],
  ['4h',  4 * HOUR_MS],
  ['24h', 24 * HOUR_MS],
  ['7d',  7 * 24 * HOUR_MS],
];
// Ventana del recorrido (excursiones, primer cruce de ATR): 7 días, igual que el horizonte
// largo de arriba — es "hasta dónde ha podido mirar el job", no un dato del setup.
const PATH_WINDOW_MS = 7 * 24 * HOUR_MS;

// TF primario del análisis → intervalo de Binance y su duración.
const TF_SPEC = {
  '1h': { interval: '1h', ms: HOUR_MS },
  '4h': { interval: '4h', ms: 4 * HOUR_MS },
  '1D': { interval: '1d', ms: 24 * HOUR_MS },
  '1W': { interval: '1w', ms: 7 * 24 * HOUR_MS },
};
const ATR_PERIOD = 14;

let timer = null;

/**
 * ATR% del TF primario en el instante del análisis — el normalizador de volatilidad de
 * todas las métricas de recorrido. Sin él, "el precio se movió un 3 %" no distingue
 * oportunidad de ruido.
 *
 * Se reconstruye desde klines en vez de persistirse en el momento del análisis para que
 * sea RETROACTIVO: los análisis ya guardados también lo obtienen. Cuesta una petición por
 * análisis UNA sola vez (después se lee de `atr_pct_at_analysis`).
 *
 * @returns {Promise<number|null>}
 */
async function fetchAtrPctAt(coin, primaryTf, tMs) {
  const spec = TF_SPEC[primaryTf];
  if (!spec) return null;
  // Velas CERRADAS antes del análisis: la que contiene tMs aún no existía al decidir.
  const need = ATR_PERIOD + 5;
  const raw = await fetchHistoricalKlines(
    coin, spec.interval, tMs - need * spec.ms, tMs - 1, need,
  );
  const closed = (raw ?? []).filter((c) => c.t + spec.ms <= tMs);
  return computeAtrPct(closed, calculateATR, ATR_PERIOD);
}

/**
 * Procesa un análisis: rellena precios vencidos, outcomes y barrier del setup.
 * @returns {Promise<boolean>} true si se escribió/actualizó la fila.
 */
async function processAnalysis(a, now) {
  const tMs = new Date(a.timestamp).getTime();
  if (Number.isNaN(tMs)) return false;

  // M2 · Baseline anclado a la MISMA fuente de klines que los precios de horizonte.
  // El `price_current` persistido viene del ticker spot (CoinGecko) → mezclar fuentes
  // introduce un sesgo sistemático en outcome/pnl. Se ancla al close de la vela de 1m del
  // instante del análisis (una vez; se reutiliza en ciclos siguientes). Fallback: price_current.
  let priceAt = a.price_at_analysis;
  if (priceAt == null) {
    try {
      priceAt = await fetchHistoricalClose(a.coin, tMs);
    } catch (err) {
      logger.warn({ id: a.id, err: err.message }, 'outcomeJob: fallo baseline kline');
    }
    if (priceAt == null) priceAt = a.price_current;
  }

  const out = { analysis_id: a.id, price_at_analysis: priceAt };

  // Precios por horizonte: conservar lo ya guardado; fetch solo lo vencido y ausente.
  for (const [label, ms] of HORIZONS) {
    const existing = a[`price_${label}_later`];
    if (existing != null) { out[`price_${label}_later`] = existing; continue; }
    if (now >= tMs + ms) {
      try {
        out[`price_${label}_later`] = await fetchHistoricalClose(a.coin, tMs + ms);
      } catch (err) {
        logger.warn({ id: a.id, label, err: err.message }, 'outcomeJob: fallo fetch precio');
        out[`price_${label}_later`] = null;
      }
    } else {
      out[`price_${label}_later`] = null;
    }
  }

  // Clasificación direccional + PnL a 24h. La banda muerta se resuelve más abajo, una vez
  // conocido el ATR (se calcula tras las klines del recorrido).
  const classifyAll = (bandPct) => {
    out.outcome_1h  = classifyOutcome(a.action, priceAt, out.price_1h_later, bandPct);
    out.outcome_24h = classifyOutcome(a.action, priceAt, out.price_24h_later, bandPct);
    out.outcome_7d  = classifyOutcome(a.action, priceAt, out.price_7d_later, bandPct);
  };
  out.pnl_pct_24h = (priceAt && out.price_24h_later != null)
    ? parseFloat((((out.price_24h_later - priceAt) / priceAt) * 100).toFixed(2))
    : null;
  // PnL FIRMADO por dirección (auditoría #2, hallazgo 3): pnl_pct_24h es el movimiento
  // crudo del precio (drift de referencia) — para un Vender ganador sale negativo. El
  // firmado (× dir) es el PnL de la estrategia; solo tiene sentido en direccionales
  // (Comprar/Vender), null para Esperar/Preparar.
  const dir = a.action === 'Comprar' ? 1 : a.action === 'Vender' ? -1 : 0;
  out.pnl_signed_pct_24h = (dir !== 0 && out.pnl_pct_24h != null)
    ? parseFloat((out.pnl_pct_24h * dir).toFixed(2))
    : null;

  // ── Velas del recorrido (grabación pura de mercado, ver cabecera del módulo) ──
  const toMs = Math.min(now, tMs + PATH_WINDOW_MS);
  let pathCandles = null;
  try {
    pathCandles = await fetchHistoricalKlines(a.coin, '1h', tMs, toMs, 1000);
  } catch (err) {
    logger.warn({ id: a.id, err: err.message }, 'outcomeJob: fallo fetch klines del recorrido');
  }

  // ── Métricas de recorrido (Fase 5) ──
  // El ATR se calcula una sola vez y se conserva; el recorrido se recalcula mientras la
  // ventana de 7d siga creciendo. Si el fetch falla, se dejan a null y el COALESCE del
  // upsert preserva lo ya medido en ciclos anteriores.
  // B1 (2026-08-09): antes de reconstruir con 19 velas, preferir el ATR% de DECISIÓN
  // (180 velas, `atr_pct_decision`) persistido desde `assembleAnalyzeContext` — es el mismo
  // que ya gobierna `dynamicNearLevelPct` y `priceBandPct`, así que unifica el eje en vez de
  // tener dos ATR% del mismo instante que pueden divergir (ya mordió una vez, 01-08: una
  // serie "1,76→1,16" mezclaba el de backtest con el de decisión). `fetchAtrPctAt` (19 velas)
  // queda como fallback SOLO para filas anteriores a este campo (`atr_pct_decision` NULL).
  let atrPct = a.atr_pct_at_analysis ?? a.atr_pct_decision ?? null;
  if (atrPct == null) {
    try {
      atrPct = await fetchAtrPctAt(a.coin, a.primary_tf, tMs);
    } catch (err) {
      logger.warn({ id: a.id, err: err.message }, 'outcomeJob: fallo ATR del análisis');
    }
  }
  out.atr_pct_at_analysis = atrPct;
  // Banda muerta normalizada por volatilidad (0.25×ATR%), con el 0.3 fijo de fallback.
  classifyAll(Number.isFinite(atrPct) && atrPct > 0 ? 0.25 * atrPct : undefined);
  if (pathCandles?.length) {
    Object.assign(out, computePathMetrics({
      candles: pathCandles, priceAt, atrPct, tMs, intervalMs: HOUR_MS,
    }));
  }

  // El barrier del `setup` ejecutable y el shadow trade del `conditional_setup` se
  // retiraron con el pivot (ver cabecera del módulo): ninguno de los dos conceptos se
  // vuelve a producir, así que no hay nada que evaluar aquí para filas nuevas (`a.setup_*`/
  // `a.conditional_setup` ya llegan NULL). ⚠️ PERO estas columnas se sobrescriben SIN
  // COALESCE en `upsertOutcome` — así que una fila VIEJA que todavía caiga dentro de la
  // ventana de reselección (8 días) y ya tuviera un resultado real perdería ese dato si
  // aquí se dejaran `undefined`. Se preservan explícitamente tal cual estaban.
  out.setup_hit_tp1  = a.setup_hit_tp1 ?? null;
  out.setup_hit_tp2  = a.setup_hit_tp2 ?? null;
  out.setup_hit_stop = a.setup_hit_stop ?? null;
  out.setup_outcome  = a.setup_outcome ?? null;
  out.cond_outcome        = a.cond_outcome ?? null;
  out.cond_filled         = a.cond_filled ?? null;
  out.cond_invalid_reason = a.cond_invalid_reason ?? null;
  out.cond_exit_price     = a.cond_exit_price ?? null;

  upsertOutcome(out);
  return true;
}

/**
 * Ejecuta un ciclo del job. Devuelve cuántos análisis se procesaron.
 */
export async function runOutcomeJob() {
  const now = Date.now();
  // Al menos 1h de antigüedad (antes no hay ni el primer horizonte).
  const rows = getAnalysesNeedingOutcome(now - HOUR_MS);
  let processed = 0;
  for (const a of rows) {
    try {
      if (await processAnalysis(a, now)) processed++;
    } catch (err) {
      logger.warn({ id: a.id, err: err.message }, 'outcomeJob: fallo procesando análisis');
    }
  }
  if (processed > 0) logger.info({ processed, candidates: rows.length }, 'outcomeJob: ciclo completado');
  return processed;
}

export function startOutcomeJob() {
  if (!env.outcomeJobEnabled) {
    logger.info('outcomeJob deshabilitado (OUTCOME_JOB_ENABLED=false)');
    return null;
  }
  if (timer) return timer;

  const intervalMs = env.outcomeJobIntervalSec * 1000;
  setTimeout(() => { runOutcomeJob().catch(() => {}); }, 8000); // primer ciclo tras arrancar
  timer = setInterval(() => { runOutcomeJob().catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();

  logger.info({ intervalSec: env.outcomeJobIntervalSec }, 'outcomeJob arrancado');
  return timer;
}

export function stopOutcomeJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
