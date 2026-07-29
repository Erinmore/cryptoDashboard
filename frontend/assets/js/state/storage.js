/**
 * storage.js — Persistencia de estado por coin en localStorage.
 *
 * Estructura:
 *   cryptex_coin          → última moneda seleccionada ('BTC' | 'ETH' | 'SOL')
 *   cryptex_state_BTC     → { tf, recommendation }
 *   cryptex_state_ETH     → { tf, recommendation }
 *   cryptex_state_SOL     → { tf, recommendation }
 */

const P = 'cryptex';

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Guarda la última moneda vista. */
export function saveLastCoin(coin) {
  save(`${P}_coin`, coin);
}

/** Devuelve la última moneda vista (default 'BTC'). */
export function loadLastCoin() {
  return load(`${P}_coin`, 'BTC');
}

/**
 * Actualiza campos del estado persistido para una moneda.
 * Solo sobreescribe los campos incluidos en `patch`.
 *
 * @param {string} coin
 * @param {{ tf?: string, recommendation?: object|null }} patch
 */
export function saveCoinState(coin, patch) {
  const prev = loadCoinState(coin);
  save(`${P}_state_${coin}`, { ...prev, ...patch });
}

/**
 * Devuelve el estado persistido de una moneda.
 * @param {string} coin
 * @returns {{ tf?: string, recommendation?: object|null }}
 */
export function loadCoinState(coin) {
  return load(`${P}_state_${coin}`, {});
}

/**
 * Borra SOLO la recomendación persistida de una moneda, conservando su `tf`.
 *
 * La copia local del análisis es un PUENTE para que el panel no parpadee mientras llega la
 * respuesta del backend, NO una memoria paralela. Cuando el servidor contesta que no hay
 * análisis, esta copia debe desaparecer: si no, sobrevive a un borrado de BBDD y a un
 * redespliegue, y se repinta idéntica a un análisis recién hecho. En una herramienta de
 * decisión eso es peor que un panel vacío — no se distingue una recomendación viva de un
 * fósil. (Detectado el 2026-07-29 tras el punto cero 5.)
 *
 * @param {string} coin
 */
export function clearCoinRecommendation(coin) {
  if (!coin) return;
  const prev = loadCoinState(coin);
  if (prev?.recommendation == null) return;
  const { recommendation, ...rest } = prev;
  save(`${P}_state_${coin}`, rest);
}
