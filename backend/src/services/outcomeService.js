/**
 * outcomeService.js — Job de backtesting que rellena `analysis_outcome`.
 *
 * Para cada análisis suficientemente antiguo y con outcome incompleto, obtiene el
 * precio a 1h/4h/24h/7d (progresivamente, según venza cada horizonte), clasifica el
 * resultado direccional y evalúa si el setup tocó TP/stop (barrier method sobre velas
 * 1h). Idempotente: reprocesa solo lo que falta hasta cerrar el horizonte de 7d.
 *
 * Se arranca en index.js (no en app.js) → no corre en los tests. También expuesto
 * como `runOutcomeJob()` para disparo manual (endpoint / on-demand).
 */

import { fetchHistoricalClose, fetchHistoricalKlines } from './coingeckoService.js';
import { getAnalysesNeedingOutcome, upsertOutcome } from './dbService.js';
import { classifyOutcome, evaluateSetupBarrier } from '../utils/outcome.js';
import env from '../config/env.js';
import logger from '../middleware/logger.js';

const HOUR_MS = 3600 * 1000;
const HORIZONS = [
  ['1h',  1 * HOUR_MS],
  ['4h',  4 * HOUR_MS],
  ['24h', 24 * HOUR_MS],
  ['7d',  7 * 24 * HOUR_MS],
];

let timer = null;

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

  // Clasificación direccional + PnL a 24h.
  out.outcome_1h  = classifyOutcome(a.action, priceAt, out.price_1h_later);
  out.outcome_24h = classifyOutcome(a.action, priceAt, out.price_24h_later);
  out.outcome_7d  = classifyOutcome(a.action, priceAt, out.price_7d_later);
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

  // Barrier del setup (solo si hay setup ejecutable y aún no está resuelto).
  // Terminal = outcome no nulo y distinto de 'open' (tp1/tp2/stop/expired/not_triggered/invalid).
  const preserveSetup = () => {
    out.setup_hit_tp1  = a.setup_hit_tp1 ?? null;
    out.setup_hit_tp2  = a.setup_hit_tp2 ?? null;
    out.setup_hit_stop = a.setup_hit_stop ?? null;
    out.setup_outcome  = a.setup_outcome ?? null;
  };
  const markInvalidSetup = () => {
    out.setup_hit_tp1 = 0; out.setup_hit_tp2 = 0; out.setup_hit_stop = 0;
    out.setup_outcome = 'invalid';
  };
  const setupResolved = a.setup_outcome && a.setup_outcome !== 'open';
  const horizonElapsed = now >= tMs + 7 * 24 * HOUR_MS;
  if (a.has_executable_setup && !setupResolved) {
    if (a.setup_entry_price == null) {
      // has_executable_setup=1 pero sin entry_price: geometría irreconstruible y PERMANENTE
      // (la columna se fija en el análisis y nunca se rellena a posteriori). Marcar 'invalid'
      // terminal DE INMEDIATO — esperar al horizonte de 7d no cambiaba el resultado y
      // re-evaluaba el barrier en cada ciclo en balde. Los precios por horizonte se siguen
      // rellenando aparte (el análisis puede seguir seleccionándose por price_7d_later NULL,
      // pero ya sin reintentar el barrier). Cierra el churn del setup en el 1er ciclo.
      markInvalidSetup();
    } else {
      const toMs = Math.min(now, tMs + 7 * 24 * HOUR_MS);
      try {
        const candles = await fetchHistoricalKlines(a.coin, '1h', tMs, toMs, 1000);
        // Fetch vacío = fallo transitorio (las klines históricas de Binance son permanentes),
        // NO geometría inválida: preservar y reintentar, no marcar 'invalid' terminal.
        if (!candles?.length) {
          preserveSetup();
        } else {
          const bar = evaluateSetupBarrier({
            entry_price: a.setup_entry_price,
            stop_price:  a.setup_stop_price,
            tp1_price:   a.setup_tp1_price,
            tp2_price:   a.setup_tp2_price,
          }, candles);
          if (bar) {
            out.setup_hit_tp1  = bar.hit_tp1 ? 1 : 0;
            out.setup_hit_tp2  = bar.hit_tp2 ? 1 : 0;
            out.setup_hit_stop = bar.hit_stop ? 1 : 0;
            // Finalizar estados no terminales cuando ya venció el horizonte de 7d
            // (evita reprocesar el mismo setup indefinidamente — A4).
            let oc = bar.outcome;
            if (!horizonElapsed && (oc === 'open' || oc === 'not_triggered')) {
              oc = 'open';               // aún dentro del horizonte: la entrada puede llenarse/resolverse
            } else if (horizonElapsed && oc === 'open') {
              oc = 'expired';            // entrada llenada pero sin tocar TP/stop en 7d
            }                            // horizonElapsed && 'not_triggered' → terminal (nunca se llenó)
            out.setup_outcome = oc;
          } else if (horizonElapsed) {
            // bar null con velas presentes = geometría inválida (p.ej. entry==stop): terminal.
            markInvalidSetup();
          } else {
            preserveSetup();
          }
        }
      } catch (err) {
        logger.warn({ id: a.id, err: err.message }, 'outcomeJob: fallo barrier del setup');
        preserveSetup(); // no pisar con null lo ya calculado ante un fallo transitorio de fetch
      }
    }
  } else {
    preserveSetup();
  }

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
