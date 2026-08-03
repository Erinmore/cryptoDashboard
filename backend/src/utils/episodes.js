import { TF_DURATION_MS } from '../config/constants.js';
/**
 * episodes.js — Agrupación de análisis en EPISODIOS independientes (Fase 5).
 *
 * Motivación (caveat 2 del checkpoint): dos análisis de SOL 4h del mismo día comparten
 * casi todo el input —1D y 1W apenas se mueven— así que no son dos observaciones
 * independientes. Tratarlas como tales infla artificialmente el n del intervalo de Wilson
 * y estrecha el IC: la incertidumbre reportada sería menor que la real.
 *
 * CRITERIO: un episodio = una vela del TF primario del análisis. Es objetivo (se deriva de
 * `timestamp` + `primary_tf`, ambos ya persistidos), no introduce ninguna constante que
 * haya que calibrar —el pecado que destapó la auditoría de umbrales— y coincide con la
 * unidad de decisión real del sistema: dos análisis de la misma vela 4h vieron la misma
 * vela cerrada.
 *
 * Funciones puras, sin I/O.
 */

const HOUR_MS = 3600 * 1000;

/** Duración de la vela de cada TF primario. */

/**
 * Clave de episodio de una fila: coin + TF + índice de la vela que contenía el análisis.
 *
 * Sin `primary_tf` reconocible se cae a la vela de 1h, que es el agrupamiento MÁS FINO
 * posible: ante la duda no se colapsan observaciones que podrían ser independientes
 * (fallar hacia menos de-dup mantiene el n alto, que es el lado conservador para no
 * borrar datos, y queda visible porque el TF aparece en la clave).
 *
 * @param {{timestamp:string, coin?:string, primary_tf?:string}} row
 * @returns {string|null} null si el timestamp no es utilizable.
 */
export function episodeKey(row) {
  const ms = new Date(row?.timestamp).getTime();
  if (!Number.isFinite(ms)) return null;
  const tf = row?.primary_tf;
  const span = TF_DURATION_MS[tf] ?? HOUR_MS;
  const bucket = Math.floor(ms / span);
  return `${row?.coin ?? '?'}|${tf ?? '1h'}|${bucket}`;
}

/**
 * Colapsa filas en episodios, quedándose con UNA por episodio.
 *
 * Se conserva la PRIMERA de cada episodio en orden cronológico, no la última ni la "mejor":
 * es la decisión que se tomó al abrirse la vela, y elegirla por su resultado sería
 * seleccionar la muestra a posteriori.
 *
 * @param {Array<{timestamp:string, coin?:string, primary_tf?:string}>} rows
 * @returns {Array} una fila por episodio, en orden cronológico ascendente.
 */
export function dedupeByEpisode(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const ordered = [...rows].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const seen = new Set();
  const out = [];
  for (const r of ordered) {
    const key = episodeKey(r);
    // Sin clave (timestamp corrupto) no se puede agrupar: se conserva la fila tal cual en
    // vez de descartarla — perder una observación es peor que no poder de-duplicarla.
    if (key == null) { out.push(r); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Cuenta episodios distintos sin materializar la lista.
 * @param {Array} rows
 * @returns {number}
 */
export function countEpisodes(rows) {
  return dedupeByEpisode(rows).length;
}
