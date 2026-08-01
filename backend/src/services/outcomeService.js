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
import {
  classifyOutcome, evaluateSetupBarrier, setupExpiryMs, candlesWithinValidity,
} from '../utils/outcome.js';
import { evaluateShadowTrade, SHADOW_MAX_WINDOW_MS } from '../utils/shadowTrade.js';
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

  // ── Velas del recorrido (compartidas: métricas de path + barrier del setup) ──
  // Antes solo se pedían cuando había setup ejecutable. Ahora se piden SIEMPRE porque el
  // recorrido posterior a un `Esperar` es justo lo que faltaba para poder refutarlo.
  // La ventana la fija `SHADOW_MAX_WINDOW_MS` (7d) y no un 7 suelto aquí: el evaluador del
  // shadow trade y la agregación de stats deciden "hasta dónde se ha podido mirar" con esa
  // misma constante, y si el fetch dijera otra cosa marcarían `truncated` donde no toca.
  const toMs = Math.min(now, tMs + SHADOW_MAX_WINDOW_MS);
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
  let atrPct = a.atr_pct_at_analysis ?? null;
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
  // Vigencia declarada por el propio análisis (`validity_candles` × TF de ejecución).
  // El barrier se evalúa SOLO dentro de ella; el recorrido (path metrics) sigue usando la
  // ventana completa de 7d, que mide el mercado y no la decisión. Si la vigencia no es
  // determinable, `expiryMs` es null y no se recorta nada (fail-open, ver utils/outcome.js).
  const expiryMs = setupExpiryMs({
    tMs,
    validityCandles: a.setup_validity_candles,
    tfExecution:     a.setup_tf_execution,
    primaryTf:       a.primary_tf,
  });
  const setupCandles = candlesWithinValidity(pathCandles, expiryMs);
  // Un setup caduca cuando vence SU vigencia, no cuando vence el horizonte de 7d: si no,
  // uno declarado válido 24h se quedaría 'open' seis días más sin poder resolverse.
  const setupHorizonElapsed = expiryMs != null ? now >= expiryMs : horizonElapsed;
  if (a.has_executable_setup && !setupResolved) {
    if (a.setup_entry_price == null) {
      // has_executable_setup=1 pero sin entry_price: geometría irreconstruible y PERMANENTE
      // (la columna se fija en el análisis y nunca se rellena a posteriori). Marcar 'invalid'
      // terminal DE INMEDIATO — esperar al horizonte de 7d no cambiaba el resultado y
      // re-evaluaba el barrier en cada ciclo en balde. Los precios por horizonte se siguen
      // rellenando aparte (el análisis puede seguir seleccionándose por price_7d_later NULL,
      // pero ya sin reintentar el barrier). Cierra el churn del setup en el 1er ciclo.
      markInvalidSetup();
    } else if (!pathCandles?.length) {
      // Fetch vacío o fallido = fallo transitorio (las klines históricas de Binance son
      // permanentes), NO geometría inválida: preservar y reintentar, no marcar 'invalid'.
      preserveSetup();
    } else if (!setupCandles?.length) {
      // Hay velas del recorrido pero NINGUNA dentro de la vigencia declarada (caso límite:
      // validity_candles=1 en 1h con la primera kline alineada justo en la caducidad). El
      // setup nunca tuvo una vela en la que llenarse: 'not_triggered', no 'invalid' — la
      // geometría era correcta, lo que faltó fue ventana.
      if (setupHorizonElapsed) {
        out.setup_hit_tp1 = 0; out.setup_hit_tp2 = 0; out.setup_hit_stop = 0;
        out.setup_outcome = 'not_triggered';
      } else {
        preserveSetup();
      }
    } else {
      const bar = evaluateSetupBarrier({
        entry_price: a.setup_entry_price,
        stop_price:  a.setup_stop_price,
        tp1_price:   a.setup_tp1_price,
        tp2_price:   a.setup_tp2_price,
      }, setupCandles);
      if (bar) {
        out.setup_hit_tp1  = bar.hit_tp1 ? 1 : 0;
        out.setup_hit_tp2  = bar.hit_tp2 ? 1 : 0;
        out.setup_hit_stop = bar.hit_stop ? 1 : 0;
        // Finalizar estados no terminales cuando ya venció el horizonte de 7d
        // (evita reprocesar el mismo setup indefinidamente — A4).
        let oc = bar.outcome;
        if (!setupHorizonElapsed && (oc === 'open' || oc === 'not_triggered')) {
          oc = 'open';               // aún dentro de la vigencia: puede llenarse/resolverse
        } else if (setupHorizonElapsed && oc === 'open') {
          oc = 'expired';            // llenada pero sin tocar TP/stop DENTRO DE SU VIGENCIA
        }                            // vencida && 'not_triggered' → terminal (nunca se llenó)
        out.setup_outcome = oc;
      } else if (setupHorizonElapsed) {
        // bar null con velas presentes = geometría inválida (p.ej. entry==stop): terminal.
        markInvalidSetup();
      } else {
        preserveSetup();
      }
    }
  } else {
    preserveSetup();
  }

  // ── Shadow trade: el `conditional_setup` evaluado con el MISMO barrier ──────
  // Es lo que convierte una abstención en un resultado medible sin esperar a que haya
  // direccionales: el análisis declaró qué trade tomaría y bajo qué condición, así que
  // se puede comprobar si esa condición llegó a darse y qué habría hecho el trade.
  // Reutiliza `evaluateSetupBarrier`/`setupExpiryMs` vía utils/shadowTrade.js — misma
  // definición de "entrada llena" y de "vigencia" que el setup ejecutable, o los dos
  // números no serían comparables entre sí.
  const condResolved = a.cond_outcome && a.cond_outcome !== 'open';
  if (a.conditional_setup && !condResolved) {
    const shadow = evaluateShadowTrade({
      conditionalSetup: a.conditional_setup,
      candles:          pathCandles,
      tMs,
      primaryTf:        a.primary_tf,
      now,
    });
    if (shadow && !shadow.preserve) {
      out.cond_outcome        = shadow.outcome;
      out.cond_filled         = shadow.filled;
      out.cond_invalid_reason = shadow.invalid_reason;
    } else {
      // preserve = fallo transitorio de klines (las históricas de Binance son permanentes,
      // así que un hueco es de la red): conservar lo que hubiera y reintentar.
      out.cond_outcome        = a.cond_outcome ?? null;
      out.cond_filled         = a.cond_filled ?? null;
      out.cond_invalid_reason = a.cond_invalid_reason ?? null;
    }
  } else {
    out.cond_outcome        = a.cond_outcome ?? null;
    out.cond_filled         = a.cond_filled ?? null;
    out.cond_invalid_reason = a.cond_invalid_reason ?? null;
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
