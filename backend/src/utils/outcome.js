import { TF_DURATION_MS } from '../config/constants.js';
/**
 * outcome.js — Funciones puras para evaluar el resultado a posteriori de un análisis
 * (job `analysis_outcome`, backtesting). Sin I/O ni dependencias.
 */

/**
 * Clasifica el resultado direccional de una acción según el movimiento de precio.
 * @param {string} action - 'Comprar' | 'Vender' | 'Preparar' | 'Esperar'
 * @param {number} priceAtAnalysis
 * @param {number} priceLater
 * @param {number} [thresholdPct=0.3] - Banda muerta (%) para considerar 'flat'. El caller
 *   (outcomeService) pasa 0.25×ATR% del TF primario cuando puede reconstruirlo, para que la
 *   banda escale con la volatilidad del activo en vez de ser la misma para BTC que para SOL
 *   (mismo criterio que la banda de `price_vs_vwap` tras la auditoría de umbrales, T6).
 *   El 0.3 fijo queda solo de fallback. Medido el 2026-07-27 sobre 973 ventanas por moneda:
 *   el cambio reclasifica ~1 punto porcentual de los casos (flat pasa de 2,5-5,2 % a
 *   3,7-5,8 %) — es consistencia, no un arreglo grande. La definición dura de acierto la
 *   da el win-rate path-aware (`classifyPathOutcome`), no esta banda.
 * @returns {'win'|'loss'|'flat'|'moved'|null}
 *   win/loss/flat para acciones direccionales (Comprar/Vender);
 *   moved/flat (informativo) para no direccionales (Esperar/Preparar);
 *   null si faltan datos.
 */
export function classifyOutcome(action, priceAtAnalysis, priceLater, thresholdPct = 0.3) {
  if (priceAtAnalysis == null || priceLater == null || priceAtAnalysis === 0) return null;
  const changePct = ((priceLater - priceAtAnalysis) / priceAtAnalysis) * 100;
  const dir = action === 'Comprar' ? 1 : action === 'Vender' ? -1 : 0;

  if (dir === 0) {
    // No direccional: solo informamos si hubo movimiento relevante o no.
    return Math.abs(changePct) >= thresholdPct ? 'moved' : 'flat';
  }

  const signed = changePct * dir; // > 0 si el precio se movió a favor de la acción
  if (signed > thresholdPct) return 'win';
  if (signed < -thresholdPct) return 'loss';
  return 'flat';
}

/**
 * Evalúa si un setup táctico tocó TP1/TP2/stop recorriendo las velas en orden
 * cronológico (barrier method). La dirección se infiere de la geometría: long si
 * stop < entry, short si stop > entry.
 *
 * IMPORTANTE (gating de entrada): el `entry_price` es una orden CONDICIONAL
 * (limit / stop-limit, no market — ver SYSTEM_PROMPT). No se asume la posición
 * abierta en el instante del análisis: primero hay que esperar a que el precio
 * TOQUE `entry_price` (la vela lo contiene, low<=entry<=high). Solo desde esa
 * vela —inclusive— se evalúan TP/stop. Sin esto, un setup cuyo precio se aleja
 * de la entrada pero llega al TP se contaría como win sin haberse llenado nunca.
 *
 * Reglas (una vez llenada la entrada):
 *  - Antes de tocar TP1, si se toca el stop → 'stop' (game over).
 *  - Si TP1 y stop caen en la misma vela, se asume el stop primero (conservador).
 *  - Tras tocar TP1, se ignora el stop (se asume stop movido a break-even) y solo
 *    se busca TP2.
 *
 * Outcomes:
 *  - 'not_triggered': el precio nunca tocó `entry_price` en las velas dadas.
 *  - 'open': entrada llenada pero sin resolver TP/stop todavía.
 *  - 'tp1' | 'tp2' | 'stop': resueltos.
 * (El caller — outcomeService — convierte 'open' en 'expired' cuando ya venció la
 *  VIGENCIA del setup; 'not_triggered' solo es terminal una vez vencida. Las velas
 *  que recibe esta función ya vienen acotadas por `candlesWithinValidity`.)
 *
 * @param {{entry_price:number, stop_price:number, tp1_price?:number, tp2_price?:number}} setup
 * @param {Array<{high:number, low:number}>} candles - En orden cronológico ascendente.
 * @returns {{filled:boolean, hit_tp1:boolean, hit_tp2:boolean, hit_stop:boolean, outcome:'not_triggered'|'open'|'tp1'|'tp2'|'stop'}|null}
 */
/**
 * Duración de una vela por timeframe, en ms. Réplica deliberada del mapa de
 * `utils/episodes.js`: son dos conceptos distintos (allí, unidad de independencia
 * estadística; aquí, unidad de vigencia declarada por el análisis) y acoplarlos
 * haría que tocar uno moviese el otro sin querer.
 */
const HOUR_MS = 3600 * 1000;

/**
 * Instante (ms) en que CADUCA un setup, según la vigencia que el propio análisis declaró.
 *
 * Por qué existe: `setup.validity_candles` se persistía y no lo leía nadie, así que el
 * barrier recorría la ventana completa de 7d. Un setup declarado "válido 6 velas" cuyo TP
 * se tocaba al 5º día se contabilizaba como `tp1` acertado — crédito por un movimiento
 * posterior a su propia caducidad. Y el sesgo no es neutro: el stop suele estar más cerca
 * que el TP, así que alargar la ventana favorece desproporcionadamente al TP.
 *
 * FAIL-OPEN a propósito: si falta la vigencia o el TF no se reconoce devuelve `null`, y el
 * caller no recorta. Preserva el comportamiento anterior en vez de inventar una ventana
 * por defecto — un recorte silencioso basado en un dato ausente sería peor que no recortar.
 *
 * `tf_execution` manda sobre `primary_tf`: la vigencia se declara en velas del TF en que se
 * EJECUTA el setup, que puede no ser el TF primario del análisis.
 *
 * @param {{tMs:number, validityCandles:*, tfExecution?:string, primaryTf?:string}} opts
 * @returns {number|null} epoch ms de caducidad, o null si no es determinable.
 */
export function setupExpiryMs({ tMs, validityCandles, tfExecution, primaryTf }) {
  if (!Number.isFinite(tMs)) return null;
  const n = Number(validityCandles);
  if (!Number.isFinite(n) || n <= 0) return null;
  const span = TF_DURATION_MS[tfExecution] ?? TF_DURATION_MS[primaryTf] ?? null;
  if (span == null) return null;
  return tMs + n * span;
}

/**
 * Acota una serie de velas a las que ABREN antes de la caducidad del setup.
 *
 * Se filtra por apertura (`t < expiryMs`), no por cierre: mantiene la convención de
 * `pathMetrics` de que el instante reportado es el cierre de la vela que contiene el
 * evento (cota superior). Una vela que abre justo en la caducidad queda fuera.
 *
 * @param {Array<{t:number}>} candles
 * @param {number|null} expiryMs - null ⇒ sin recorte (ver FAIL-OPEN de `setupExpiryMs`).
 * @returns {Array} la misma referencia si no hay recorte, o un nuevo array filtrado.
 */
export function candlesWithinValidity(candles, expiryMs) {
  if (!Array.isArray(candles) || !candles.length) return candles;
  if (!Number.isFinite(expiryMs)) return candles;
  return candles.filter((c) => Number.isFinite(c?.t) && c.t < expiryMs);
}

export function evaluateSetupBarrier(setup, candles) {
  const entry = setup?.entry_price;
  const stop  = setup?.stop_price;
  const tp1   = setup?.tp1_price ?? null;
  const tp2   = setup?.tp2_price ?? null;
  if (entry == null || stop == null || stop === entry || !candles?.length) return null;

  const isLong = stop < entry;
  let filled = false;
  let hitTp1 = false, hitTp2 = false, hitStop = false;
  let outcome = 'not_triggered';

  for (const c of candles) {
    const hi = c.high, lo = c.low;
    if (hi == null || lo == null) continue;

    // Fase 1 — esperar a que el precio toque la entrada condicional.
    if (!filled) {
      if (lo <= entry && entry <= hi) {
        filled = true;
        outcome = 'open'; // llenada; se evaluará TP/stop en esta misma vela y siguientes
      } else {
        continue;
      }
    }

    // Fase 2 — barrier desde la vela de fill (inclusive).
    if (!hitTp1) {
      if (isLong ? lo <= stop : hi >= stop) { hitStop = true; outcome = 'stop'; break; }
      if (tp1 != null && (isLong ? hi >= tp1 : lo <= tp1)) { hitTp1 = true; outcome = 'tp1'; }
    }
    if (hitTp1 && tp2 != null && (isLong ? hi >= tp2 : lo <= tp2)) {
      hitTp2 = true; outcome = 'tp2'; break;
    }
  }

  return { filled, hit_tp1: hitTp1, hit_tp2: hitTp2, hit_stop: hitStop, outcome };
}
