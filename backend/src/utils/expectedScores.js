/**
 * expectedScores.js — score direccional ESPERADO por bloque, derivado de los datos.
 *
 * Motivación (auditoría C2): las puertas de Comprar/Vender se validan contra los scores
 * -2..+2 que el propio LLM se auto-asigna → circular y alucinable. Aquí el backend calcula
 * de forma determinista un score esperado COARSE (grueso) para Derivatives y Volume — los
 * dos bloques que abren la puerta — a partir de los mismos flags que ve el LLM. No pretende
 * replicar el matiz del LLM (absorción, jerarquía…): es una GUARDIA de divergencia que solo
 * detecta contradicciones flagrantes (LLM dice alcista donde el dato lee claramente bajista).
 *
 * Funciones puras (sin I/O). Cada una devuelve { score:int[-2..2], basis: string[] }.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Score de Derivados esperado desde funding (severity/severity_negative) y Long/Short.
 * Coarse: solo signo/dirección aproximada, no la ponderación fina del prompt.
 * @param {object|null} derivatives - bloque `derivatives` del contexto.
 * @returns {{score:number, basis:string[]}}
 */
export function expectedDerivativesScore(derivatives) {
  const basis = [];
  if (!derivatives) return { score: 0, basis: ['sin datos de derivados'] };
  let s = 0;

  const fr = derivatives.funding_rate ?? null;
  // Funding negativo cargado = shorts pagando = potencial short squeeze (alcista).
  if (fr?.severity_negative === 'extreme_short_overload') { s += 2; basis.push('funding negativo extremo (+2)'); }
  else if (fr?.severity_negative === 'high_short_overload') { s += 1; basis.push('funding negativo alto (+1)'); }
  // Funding positivo cargado = longs sobre-apalancados = riesgo contrarian bajista.
  else if (fr?.severity === 'extreme' || fr?.severity === 'high') { s -= 1; basis.push(`funding ${fr.severity} (-1)`); }

  // Long/Short ratio: el backend ya codifica el sesgo contrarian en `signal`.
  const lsrSignal = derivatives.long_short_ratio?.signal ?? '';
  if (lsrSignal.includes('contrarian_bull')) { s += 1; basis.push('LSR contrarian bull (+1)'); }
  else if (lsrSignal.includes('contrarian_bear')) { s -= 1; basis.push('LSR contrarian bear (-1)'); }

  return { score: clamp(Math.round(s), -2, 2), basis };
}

/**
 * Score de Volume Flow esperado desde el delta taker real (buy_pressure_pct) y el
 * imbalance del order book. Se apoya en buy_pressure_pct (delta taker, inequívoco) y NO
 * en la lectura de absorción del CVD (deliberadamente — esa interpretación es del LLM y
 * no queremos falsos positivos de divergencia).
 * @param {object|null} volumeDelta - technical[primaryTf].volume_delta
 * @param {object|null} orderBook - bloque `order_book`
 * @returns {{score:number, basis:string[]}}
 */
export function expectedVolumeScore(volumeDelta, orderBook) {
  const basis = [];
  let s = 0;

  const bp = volumeDelta?.buy_pressure_pct;
  if (typeof bp === 'number') {
    // 50 = equilibrio; ~±8 pts por nivel de score.
    const term = clamp(Math.round((bp - 50) / 8), -2, 2);
    s += term;
    if (term !== 0) basis.push(`buy_pressure_pct=${bp} (${term > 0 ? '+' : ''}${term})`);
  } else {
    basis.push('sin volume_delta');
  }

  const imb = orderBook?.imbalance_signal;
  if (imb === 'buy_pressure') { s += 0.5; basis.push('order book buy_pressure (+0.5)'); }
  else if (imb === 'sell_pressure') { s -= 0.5; basis.push('order book sell_pressure (-0.5)'); }

  return { score: clamp(Math.round(s), -2, 2), basis };
}

// Ponderación jerárquica declarada en el DECISION ENGINE del prompt
// (Derivatives > Volume > Structure > On-Chain como ajuste). Suma = 1.
const SCORE_WEIGHTS = { derivatives: 0.35, volume: 0.30, structure: 0.25, onchain: 0.10 };

/**
 * `score_total` REPRODUCIBLE desde los componentes -2..+2 del LLM (auditoría B2).
 * El `total` que emite el LLM es un decimal libre ("no sumar mecánicamente") → no auditable.
 * Este total sí es determinista a partir de los componentes; se persiste en paralelo para
 * que el historial muestre una cifra reproducible. No reemplaza la decisión del LLM.
 * @param {{derivatives?:number, volume?:number, structure?:number, onchain?:number}} scores
 * @returns {number|null} total ponderado redondeado a 2 decimales, o null si faltan todos.
 */
export function backendScoreTotal(scores) {
  if (!scores || typeof scores !== 'object') return null;
  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(SCORE_WEIGHTS)) {
    const v = scores[k];
    if (Number.isInteger(v)) { sum += v * w; wsum += w; }
  }
  if (wsum === 0) return null;
  // Renormaliza por los pesos presentes (si falta on-chain en alts, no sesga a 0).
  return parseFloat((sum / wsum).toFixed(2));
}

/**
 * Calcula ambos scores esperados desde el contexto completo del análisis.
 * @param {object} context - contexto de mercado (con derivatives, technical, order_book).
 * @param {string} primaryTf
 * @returns {{ derivatives:{score,basis}, volume:{score,basis} }}
 */
export function computeExpectedScores(context, primaryTf) {
  const volumeDelta = context?.technical?.[primaryTf]?.volume_delta ?? null;
  return {
    derivatives: expectedDerivativesScore(context?.derivatives ?? null),
    volume: expectedVolumeScore(volumeDelta, context?.order_book ?? null),
  };
}
