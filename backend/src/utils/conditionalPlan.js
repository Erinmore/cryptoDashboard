/**
 * conditionalPlan.js — describe un `conditional_setup` en términos que el usuario pueda leer,
 * usando SÓLO magnitudes con respaldo medido. Funciones puras, sin I/O.
 *
 * ─── POR QUÉ EXISTE ────────────────────────────────────────────────────────────────────
 *
 * El `conditional_setup` se emite desde v9_0 en cada `Esperar`/`Preparar` y hasta ahora sólo
 * se veía en el modal de historial. Es **la salida dominante del sistema** y el objeto sobre
 * el que se construye el producto: "no hay operación ahora, pero si pasa X, esto haría".
 *
 * Este módulo NO decide nada y NO añade ninguna constante: traduce el plan a cuatro cifras
 * que ya están medidas en otro sitio, y se niega a inventar las que no lo están.
 *
 * ─── LAS CUATRO CIFRAS, Y POR QUÉ ESTAS Y NO OTRAS ─────────────────────────────────────
 *
 *  1. `rr` + `breakeven_win_rate_pct` — ARITMÉTICA PURA. No necesita muestra ni respaldo:
 *     con R:R 2,11 hay que acertar >32,2 % sólo para empatar. Es la cifra que impide leer un
 *     win-rate sin su geometría (el modal llegó a pintarlo contra un 50 % hardcodeado).
 *  2. `trigger_prob_pct` — `TRIGGER_BASE_RATE`, medida sobre ~3.000 anclas/celda. Responde
 *     "¿llega a darse siquiera la condición que el análisis nombra?".
 *  3. `target_reachability_pct` — `TARGET_REACHABILITY`, ídem. Responde "¿recorre el mercado
 *     esa distancia en las velas que el propio análisis declara?". Es la cifra incómoda: en
 *     los setups reales de producción sale entre el 5 % y el 18 %, o sea que el resultado lo
 *     decide la CADUCIDAD y no el objetivo. Enseñarla es la mitad de la honestidad del panel.
 *  4. `expires_at` — la vigencia declarada, convertida a un instante. Deja de ser un número
 *     de velas en un JSON y pasa a ser una promesa con fecha.
 *
 * ⚠️ LO QUE ESTE MÓDULO SE NIEGA A DEVOLVER, Y ES DELIBERADO:
 *   · **`expectancy_r` NO se expone aquí.** Su línea base **no es un número, es una curva**
 *     indexada por anchura de barrera ÷ √vigencia (medido el 2026-08-03, M8/M10): un setup
 *     con barreras estrechas sale a −0,3R por pura geometría, y compararlo contra el +0,004R
 *     de `auditShadowBaseline` lo haría parecer un desastre siendo sólo otra forma. Hasta que
 *     esa curva exista, la expectativa no se puede enseñar sin engañar.
 *   · **Ninguna probabilidad de ACIERTO direccional.** Medido dos veces y por vías
 *     independientes (fase 0 y M9): no hay ventaja direccional demostrable con las features
 *     probadas. El panel da geometría declarada y evaluable, no un pronóstico con ventaja.
 *
 * ⚠️ EL ATR QUE ENTRA AQUÍ ES EL DE **19** VELAS (`atr_pct_at_analysis`), no el de 180 que
 * decide la banda de la rúbrica. Va nombrado en el parámetro a propósito: es la lección B1,
 * que ya mordió tres veces. `TRIGGER_BASE_RATE` se midió con ese eje; `TARGET_REACHABILITY`
 * se midió con el de 180 y su versión con 19 difiere <=1,6 pt (la elección se cancela, pero
 * se declara en vez de esconderse).
 */

import {
  normalizedTriggerDistance, triggerBaseRateFor,
  normalizedTargetDistance, targetReachabilityFor,
} from './stats.js';
import { SHADOW_FILL_RULE } from './shadowTrade.js';
import { setupExpiryMs } from './outcome.js';


const num = (x) => (Number.isFinite(x) ? x : null);

/**
 * @param {object} args
 * @param {object|string|null} args.conditionalSetup - el objeto o su JSON persistido.
 * @param {number|null} args.atrPct__outcome_19 - `analysis_outcome.atr_pct_at_analysis`.
 * @param {number|null} args.priceAtAnalysis - `analyses.price_current`. NO está dentro del
 *   `conditional_setup`, así que se pasa aparte; sin él la distancia del gatillo no se puede
 *   normalizar y `trigger_prob_pct` sale null (que es lo correcto: no se estima a ojo).
 * @param {string|null} args.primaryTf
 * @param {string|number|null} args.timestamp - instante del análisis (ISO o epoch ms).
 * @returns {object|null} null si no hay plan; los campos que falten van a null, nunca
 *   inventados — un dato ausente no es un defecto, y menos aún un valor por defecto.
 */
export function describeConditionalPlan({
  conditionalSetup, atrPct__outcome_19 = null, primaryTf = null, timestamp = null,
  priceAtAnalysis = null,
} = {}) {
  let cs = conditionalSetup;
  if (typeof cs === 'string') {
    try { cs = JSON.parse(cs); } catch { return null; }
  }
  if (!cs || typeof cs !== 'object') return null;

  const entry = num(cs.entry_price);
  const stop = num(cs.stop_price);
  const tp1 = num(cs.tp1_price);
  const candles = num(cs.validity_candles);
  const tfExec = cs.tf_execution ?? primaryTf ?? null;

  // R:R y equilibrio: aritmética, disponibles aunque no haya ATR ni vigencia.
  let rr = null, breakeven = null;
  if (entry != null && stop != null && tp1 != null) {
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(tp1 - entry);
    if (risk > 0) {
      rr = parseFloat((reward / risk).toFixed(2));
      breakeven = parseFloat((100 / (1 + rr)).toFixed(1));
    }
  }

  // Las dos curvas medidas. Sin ATR o sin vigencia NO se estiman: se devuelven null.
  const axis = {
    atrPct: atrPct__outcome_19, validityCandles: candles,
    tfExecution: tfExec, primaryTf,
  };
  const dTrigger = entry != null && num(priceAtAnalysis) != null
    ? normalizedTriggerDistance({ entryPrice: entry, priceAtAnalysis, ...axis })
    : null;
  const dTarget = entry != null && tp1 != null
    ? normalizedTargetDistance({ tp1Price: tp1, entryPrice: entry, ...axis })
    : null;

  // ── Vigencia como INSTANTE, no como número de velas en un JSON ──
  //
  // ⚠️ SE DELEGA EN `setupExpiryMs`, LA MISMA FUNCIÓN QUE USA EL EVALUADOR (B3, 2026-08-03).
  // La primera versión de este módulo replicaba la aritmética con su propia tabla de TF, y eso
  // es peor que duplicar una constante: la caducidad que el usuario LEE en pantalla y la que
  // el shadow trade APLICA al evaluar podrían desincronizarse sin que nada avisara — el panel
  // diría "válido hasta el jueves" mientras el evaluador cerró el miércoles. Con un solo dueño
  // no pueden discrepar, ni aunque alguien cambie la regla.
  const t0 = typeof timestamp === 'string' ? Date.parse(timestamp) : num(timestamp);
  const expiry = setupExpiryMs({
    tMs: t0, validityCandles: candles, tfExecution: tfExec, primaryTf,
  });
  const expiresAt = expiry != null ? new Date(expiry).toISOString() : null;

  return {
    direction: cs.direction ?? null,
    trigger: cs.trigger ?? null,
    entry_price: entry, stop_price: stop, tp1_price: tp1,
    validity_candles: candles, tf_execution: tfExec,
    expires_at: expiresAt,

    rr,
    breakeven_win_rate_pct: breakeven,
    trigger_prob_pct: dTrigger != null ? triggerBaseRateFor(dTrigger) : null,
    target_reachability_pct: dTarget != null ? targetReachabilityFor(dTarget) : null,

    /**
     * Viaja SIEMPRE con las cifras, no en una nota al pie. El evaluador llena la entrada al
     * TOCARLA intravela mientras el gatillo declarado suele exigir un CIERRE de vela: un
     * `no disparó` es robusto por el lado conservador, pero un `tp1`/`stop` puede no haber
     * cumplido el gatillo estricto. Como telemetría interna era una nota; en un panel que el
     * usuario lee para operar, callarlo sería vender un resultado que no es el suyo.
     */
    fill_rule: SHADOW_FILL_RULE,

    /** Por qué NO viene `expectancy_r` aquí. Ver la cabecera del módulo. */
    expectancy_r_unavailable_reason:
      'su línea base es una curva sin medir (anchura de barrera ÷ √vigencia) — M10',
  };
}
