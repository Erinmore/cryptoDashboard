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
