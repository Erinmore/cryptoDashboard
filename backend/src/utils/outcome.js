/**
 * outcome.js — Funciones puras para evaluar el resultado a posteriori de un análisis
 * (job `analysis_outcome`, backtesting). Sin I/O ni dependencias.
 */

/**
 * Clasifica el resultado direccional de una acción según el movimiento de precio.
 * @param {string} action - 'Comprar' | 'Vender' | 'Preparar' | 'Esperar'
 * @param {number} priceAtAnalysis
 * @param {number} priceLater
 * @param {number} [thresholdPct=0.3] - Banda muerta (%) para considerar 'flat'.
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
 * (El caller — outcomeService — convierte 'open' en 'expired' cuando ya venció el
 *  horizonte de 7d; 'not_triggered' solo es terminal una vez vencido ese horizonte.)
 *
 * @param {{entry_price:number, stop_price:number, tp1_price?:number, tp2_price?:number}} setup
 * @param {Array<{high:number, low:number}>} candles - En orden cronológico ascendente.
 * @returns {{filled:boolean, hit_tp1:boolean, hit_tp2:boolean, hit_stop:boolean, outcome:'not_triggered'|'open'|'tp1'|'tp2'|'stop'}|null}
 */
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
