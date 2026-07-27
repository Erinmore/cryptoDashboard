/**
 * percentiles.js — auto-normalización de umbrales contra la distribución propia.
 *
 * Motivación (auditoría de umbrales 2026-07-26): las constantes de corte del sistema eran
 * números redondos elegidos a ojo, y al medirlas contra la distribución real de la magnitud
 * que bucketizan resultó que varias caían sobre la MEDIANA (no separaban nada) o dejaban
 * buckets al 0 % (rama muerta). El caso más grave: `cvd_strength` con corte fijo del 2 %
 * aplicado a los cuatro TFs, cuando la mediana del 4h es 1,99 % y la del 1W 0,59 %.
 *
 * La respuesta es no elegir el número: derivarlo de la propia serie en cada request. Así
 * el mismo código sirve para cualquier moneda y TF sin tablas de calibración que mantener
 * ni que caducan cuando cambia el régimen de mercado.
 *
 * LIMITACIÓN QUE HAY QUE TENER PRESENTE: un bucket definido por percentil es RELATIVO por
 * construcción — siempre habrá ~un tercio de observaciones en cada cubo. Eso significa que
 * un mercado completamente plano seguirá produciendo etiquetas "strong" (el tercio superior
 * de casi nada). Por eso `bucketByPercentile` admite un SUELO ABSOLUTO opcional: por debajo
 * de él la observación es ruido dígalo lo que diga su percentil. Úsalo en toda magnitud
 * donde "pequeño" tenga significado físico y no solo comparativo.
 *
 * Funciones puras, sin I/O.
 */

/**
 * Cuantil por interpolación lineal sobre una copia ordenada.
 * @param {number[]} values - muestra (no se muta; se ignoran los no finitos)
 * @param {number} p - cuantil en [0,1]
 * @returns {number|null} null si no hay datos utilizables
 */
export function quantile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const idx = (xs.length - 1) * Math.min(Math.max(p, 0), 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return xs[lo];
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo);
}

/**
 * Percentil (0-100) que ocupa `value` dentro de `values`: fracción de la muestra por debajo.
 * @returns {number|null}
 */
export function percentileRank(values, value) {
  if (!Number.isFinite(value)) return null;
  const xs = values.filter(Number.isFinite);
  if (xs.length === 0) return null;
  const below = xs.reduce((n, v) => n + (v < value ? 1 : 0), 0);
  return parseFloat((below / xs.length * 100).toFixed(1));
}

/**
 * Serie de sumas sobre ventana rodante de tamaño `w`, alineada al final de cada ventana.
 * O(n) con ventana deslizante. Devuelve `values.length - w + 1` elementos.
 * @returns {number[]}
 */
export function rollingSums(values, w) {
  if (!Array.isArray(values) || w <= 0 || values.length < w) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= w) sum -= values[i - w];
    if (i >= w - 1) out.push(sum);
  }
  return out;
}

/**
 * Clasifica `value` en tres cubos según su posición en la distribución de `sample`.
 *
 * @param {number} value
 * @param {number[]} sample - distribución de referencia (típicamente la serie rodante propia)
 * @param {object} [opts]
 * @param {[string,string,string]} [opts.labels] - etiquetas [bajo, medio, alto]
 * @param {number} [opts.lowP=0.33] - cuantil que separa bajo/medio
 * @param {number} [opts.highP=0.67] - cuantil que separa medio/alto
 * @param {number} [opts.absoluteFloor] - por debajo de este valor SIEMPRE devuelve la
 *   etiqueta baja, aunque su percentil sea alto. Evita que un mercado muerto genere
 *   señales "fuertes" por comparación con su propia nada.
 * @param {number} [opts.minSample=12] - muestra mínima; por debajo devuelve null (sin datos
 *   suficientes es preferible no afirmar nada a inventar un corte sobre 3 puntos).
 * @returns {{label: string|null, percentile: number|null, cuts: [number,number]|null}}
 */
export function bucketByPercentile(value, sample, opts = {}) {
  const {
    labels = ['low', 'mid', 'high'],
    lowP = 0.33,
    highP = 0.67,
    absoluteFloor = null,
    minSample = 12,
  } = opts;

  const xs = (sample ?? []).filter(Number.isFinite);
  if (!Number.isFinite(value) || xs.length < minSample) {
    return { label: null, percentile: null, cuts: null };
  }

  const lo = quantile(xs, lowP);
  const hi = quantile(xs, highP);
  const percentile = percentileRank(xs, value);

  const cuts = [round4(lo), round4(hi)];
  if (absoluteFloor != null && value < absoluteFloor) {
    return { label: labels[0], percentile, cuts };
  }
  const label = value < lo ? labels[0] : value < hi ? labels[1] : labels[2];
  return { label, percentile, cuts };
}

const round4 = (n) => (Number.isFinite(n) ? parseFloat(n.toFixed(4)) : n);
