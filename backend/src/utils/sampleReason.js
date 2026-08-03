/**
 * sampleReason.js — dueño ÚNICO de "de dónde vino esta observación". Función pura, sin I/O.
 *
 * POR QUÉ EXISTE COMO MÓDULO. La normalización nació en `analysisController` (para la API) y a
 * las dos horas el script de backfill necesitó la misma regla para leer el log — con una
 * variante propia para la convención antigua (`manual_verificacion` con guion bajo, anterior a
 * que se fijara el `prefijo:detalle`). Dos copias de la misma regla es exactamente el patrón
 * que hoy ha costado seis tablas de duración de vela y tres ficheros de estado compartidos.
 *
 * QUÉ GARANTIZA. El valor acaba en BBDD y viene de fuera (cuerpo de la petición, o una línea de
 * log), así que se VALIDA en vez de confiarse: prefijo del vocabulario, detalle opcional tras
 * dos puntos, minúsculas, tope de longitud. Lo que no encaja cae a `unknown` — información
 * honesta ("no sé de dónde salió"), no un origen inventado.
 */

import { SAMPLE_REASONS } from '../config/constants.js';

const MAX = 64;
const FORMA = /^[a-z_]+(:[a-z_+]+)?$/;

const valido = (v) => FORMA.test(v) && SAMPLE_REASONS.includes(v.split(':')[0]);

/**
 * @param {unknown} raw
 * @param {{fallback?: string}} [opts] - qué devolver si no encaja. Por defecto `unknown`.
 * @returns {string}
 */
export function normalizeSampleReason(raw, { fallback = 'unknown' } = {}) {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase().slice(0, MAX);
  if (valido(v)) return v;
  // Convención antigua: `manual_verificacion` en vez de `manual:verificacion`. Se reconvierte
  // sólo si el primer token es un prefijo válido — no se fuerza cualquier cosa a encajar.
  const i = v.indexOf('_');
  if (i > 0) {
    const alt = `${v.slice(0, i)}:${v.slice(i + 1)}`;
    if (valido(alt)) return alt;
  }
  return fallback;
}
