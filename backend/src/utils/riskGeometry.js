/**
 * riskGeometry.js — geometría de riesgo SIMÉTRICA (largo + corto) desde el precio del
 * análisis, en unidades relativas. Función pura, sin I/O.
 *
 * ─── POR QUÉ EXISTE ────────────────────────────────────────────────────────────────────
 *
 * Sustituye a `conditionalPlan.js`, que describía UN `conditional_setup` declarado por el
 * LLM (una dirección, un gatillo, un precio de entrada distinto del actual). Tras la
 * reorientación del producto (~20 hipótesis direccionales medidas, cero supervivientes —
 * ver CLAUDE.md §REORIENTACIÓN), el sistema deja de afirmar dirección: en su lugar muestra,
 * para AMBAS direcciones a la vez, la geometría que resultaría de operar AHORA con una
 * convención de stop/objetivo estándar.
 *
 * No hay gatillo ni entrada pendiente — la entrada es siempre el precio actual — así que,
 * a diferencia de `conditionalPlan.js`, este módulo no necesita `TRIGGER_BASE_RATE` ni
 * `normalizedTriggerDistance`: la distancia del gatillo es 0 por construcción. Es más
 * simple que su predecesor, no un fork con la dirección duplicada.
 *
 * ─── LA CONVENCIÓN, Y POR QUÉ ESTA Y NO OTRA ───────────────────────────────────────────
 *
 * Stop/objetivo = `OPPORTUNITY_BY_HORIZON['24h']` (1×ATR de stop, 2×ATR de objetivo) — la
 * MISMA convención ya usada para medir `TARGET_REACHABILITY` y la tasa base de oportunidad.
 * No se inventa un múltiplo nuevo: reutilizar el ya calibrado es lo que permite leer
 * `target_reachability_pct` sin extrapolar fuera de lo medido.
 *
 * Vigencia fija a 24h (6 velas en TF 4h) — decisión de producto, no medida: es la base
 * sobre la que se calibró `TARGET_REACHABILITY` (`measured_at: '2026-08-01'`).
 *
 * ⚠️ EL ATR ES EL DE DECISIÓN (180 velas, `technical[primaryTf].atr.pct`), no el de 19 que
 * usaba `conditionalPlan.js` para `atrPct__outcome_19`. Aquí no hace falta esperar al job de
 * outcome para tenerlo — está disponible de forma SÍNCRONA en el momento del análisis, así
 * que la geometría se puede calcular sin esperar nada, otra simplificación real frente al
 * módulo que sustituye.
 *
 * ⚠️ LO QUE ESTE MÓDULO SE NIEGA A DEVOLVER, Y ES DELIBERADO:
 *   · **Ninguna probabilidad de acierto direccional.** `rr`/`breakeven_win_rate_pct` son
 *     aritmética pura de la geometría, no un pronóstico — por eso son IDÉNTICOS en `long`
 *     y `short` (mismos múltiplos, ambas direcciones), lo cual es la prueba de que no
 *     codifican ninguna opinión sobre cuál va a ganar.
 *   · **`expectancy_r`.** Su línea base es una curva sin medir para esta geometría concreta
 *     (M10, `conditionalPlan.js`) — no se hereda sin remedir.
 */

import { OPPORTUNITY_BY_HORIZON, normalizedTargetDistance, targetReachabilityFor, TARGET_REACHABILITY, TARGET_UNREACHABLE_PCT } from './stats.js';
import { setupExpiryMs } from './outcome.js';

const { targetK, adverseK } = OPPORTUNITY_BY_HORIZON['24h']; // 2× / 1×ATR — no re-literalizar
const VALIDITY_CANDLES = 6; // 24h en TF 4h — decisión de producto, ver cabecera

const num = (x) => (Number.isFinite(x) ? x : null);
const round2 = (x) => (Number.isFinite(x) ? parseFloat(x.toFixed(2)) : null);

function sideGeometry(direction, currentPrice, atrPct, tfExecution, primaryTf, validityCandles) {
  const sign = direction === 'long' ? 1 : -1;
  const stopPrice = currentPrice * (1 - sign * adverseK * atrPct / 100);
  const tp1Price = currentPrice * (1 + sign * targetK * atrPct / 100);

  const rr = parseFloat((targetK / adverseK).toFixed(2));
  const breakeven = parseFloat((100 / (1 + rr)).toFixed(1));

  const d = normalizedTargetDistance({
    tp1Price, entryPrice: currentPrice, atrPct, validityCandles, tfExecution, primaryTf,
  });
  const reachability = d != null ? targetReachabilityFor(d) : null;

  return {
    direction,
    entry_price: round2(currentPrice),
    stop_price: round2(stopPrice),
    tp1_price: round2(tp1Price),
    rr,
    breakeven_win_rate_pct: breakeven,
    target_reachability_pct: reachability,
    target_unreachable: reachability != null ? reachability < TARGET_UNREACHABLE_PCT : null,
  };
}

/**
 * @param {object} args
 * @param {number|null} args.currentPrice - `context.price_current`.
 * @param {number|null} args.atrPct - ATR% de DECISIÓN, `technical[primaryTf].atr.pct` (180 velas).
 * @param {string|null} args.primaryTf
 * @param {number|null} args.tMs - instante del análisis, epoch ms.
 * @returns {object|null} null si falta `currentPrice`/`atrPct` — nunca se inventa una cifra.
 */
export function computeRiskGeometry({ currentPrice, atrPct, primaryTf, tMs } = {}) {
  const price = num(currentPrice);
  const atr = num(atrPct);
  if (price == null || price <= 0 || atr == null || atr <= 0) return null;

  const tfExecution = primaryTf ?? null;
  const expiry = setupExpiryMs({
    tMs: num(tMs), validityCandles: VALIDITY_CANDLES, tfExecution, primaryTf,
  });

  return {
    long: sideGeometry('long', price, atr, tfExecution, primaryTf, VALIDITY_CANDLES),
    short: sideGeometry('short', price, atr, tfExecution, primaryTf, VALIDITY_CANDLES),
    validity_candles: VALIDITY_CANDLES,
    tf_execution: tfExecution,
    expires_at: expiry != null ? new Date(expiry).toISOString() : null,
    atr_pct: round2(atr),
    atr_pct_source: 'decision_180',
    thresholds: { target_k_atr: targetK, adverse_k_atr: adverseK },
    measured_at: TARGET_REACHABILITY.measured_at,
  };
}
