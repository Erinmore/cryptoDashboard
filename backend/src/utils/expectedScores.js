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
 * Score de Volume Flow esperado desde el CVD del TF PRIMARIO — la señal táctica que el
 * prompt puntúa de verdad.
 *
 * Motivación (revisión interna post-auditoría): la versión previa derivaba el score de
 * `buy_pressure_pct`, que `calculateVolumeDelta` acumula sobre TODA la ventana del TF
 * (168–180 velas) → se queda pegado a ~50 en casi cualquier mercado → el término
 * redondeaba a 0 y la guardia de divergencia de volumen (C2) prácticamente nunca se
 * disparaba: no daba el chequeo independiente que prometía y, cuando saltaba, chocaba con
 * la lectura de absorción del propio prompt. Ahora se apoya en `technical[primaryTf].cvd`.
 *
 * CARVE-OUT de absorción: una divergencia CVD↔precio es AMBIGUA por diseño — el prompt lee
 * "precio↑ + CVD↓" como ABSORCIÓN institucional ALCISTA (no bajista) y "precio↓ + CVD↑"
 * como absorción bajista. Por eso la guardia se ABSTIENE (score 0) ante cualquier
 * `divergence != "none"`: solo puntúa el caso ALINEADO (sin divergencia), donde el signo
 * del flujo es inequívoco (agresión/FOMO alcista o capitulación/distribución bajista). Así
 * caza contradicciones flagrantes sin penalizar la tesis de absorción del prompt.
 *
 * @param {object|null} cvd - technical[primaryTf].cvd (trend/divergence/cvd_strength/source)
 * @returns {{score:number, basis:string[]}}
 */
export function expectedVolumeScore(cvd) {
  if (!cvd) return { score: 0, basis: ['sin CVD del TF primario'] };

  const strength = cvd.cvd_strength ?? null;
  // Marginal = ruido de fondo (regla del prompt): sin convicción aunque haya trend.
  if (strength == null || strength === 'marginal') {
    return { score: 0, basis: [`cvd_strength=${strength ?? 'null'} → sin convicción`] };
  }

  // Divergencia (absorción/agotamiento): interpretación del LLM → la guardia se abstiene.
  if (cvd.divergence && cvd.divergence !== 'none') {
    return { score: 0, basis: [`divergencia CVD "${cvd.divergence}" (absorción/agotamiento) → guardia se abstiene`] };
  }

  // Alineado: el signo del flujo es inequívoco. moderate → ±1, strong → ±2.
  const mag = strength === 'strong' ? 2 : 1;
  const basis = [];
  let score = 0;
  if (cvd.trend === 'rising')       { score =  mag; basis.push(`CVD alineado al alza (strength=${strength}) → +${mag}`); }
  else if (cvd.trend === 'falling') { score = -mag; basis.push(`CVD alineado a la baja (strength=${strength}) → -${mag}`); }
  else                              { basis.push('CVD trend=flat → 0'); }

  // source="heuristic" es una estimación (sin taker real de Binance): nunca ±2.
  if (cvd.source === 'heuristic' && Math.abs(score) === 2) {
    score = score > 0 ? 1 : -1;
    basis.push('source=heuristic → magnitud reducida a ±1');
  }

  return { score: clamp(score, -2, 2), basis };
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
 * Volumen se apoya en el CVD del TF primario (no en el order book ni en la fracción taker
 * acumulada de toda la ventana — ver expectedVolumeScore).
 * @param {object} context - contexto de mercado (con derivatives, technical).
 * @param {string} primaryTf
 * @returns {{ derivatives:{score,basis}, volume:{score,basis} }}
 */
export function computeExpectedScores(context, primaryTf) {
  const cvd = context?.technical?.[primaryTf]?.cvd ?? null;
  return {
    // `derivatives` RETIRADO el 2026-07-29. La guardia existía para detectar que el LLM
    // contradijera el dato; desde que el backend CALCULA el Derivatives Score
    // (utils/derivativesScore.js) no hay nada que vigilar — el modelo lo lee, no lo puntúa.
    //
    // Y era ACTIVAMENTE DAÑINA: `expectedDerivativesScore` implementa otra rúbrica (funding +
    // LSR contrarian) y su término de LSR devuelve ±1 el 33 % del tiempo POR CONSTRUCCIÓN
    // (terciles). Con la rúbrica nueva, un `Comprar` legítimo con derivatives=+1 chocaba con
    // un expected=-1 → divergencia >=2 → SEVERE → el fail-safe lo degradaba a `Esperar`.
    // Habría matado ~1 de cada 3 señales direccionales, y en BBDD habría parecido una
    // decisión del modelo. `expectedVolumeScore` SÍ se conserva: ahí el LLM sigue puntuando.
    volume: expectedVolumeScore(cvd),
  };
}
