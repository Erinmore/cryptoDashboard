/**
 * stats.js — utilidades estadísticas puras para el backtesting.
 *
 * Motivación (auditoría C5): el win-rate se reportaba como un % crudo sobre una muestra
 * diminuta y auto-seleccionada (el sistema fuerza Esperar casi siempre → poquísimos
 * direccionales), sin tamaño mínimo ni intervalo de confianza → conclusiones falsas.
 * Aquí el intervalo de Wilson da la incertidumbre real de una proporción con n pequeño.
 */

const Z_95 = 1.959963984540054; // z para IC del 95%

/**
 * Intervalo de confianza de Wilson para una proporción binomial (win-rate).
 * Preferido sobre el normal (Wald) con n pequeño: no se sale de [0,1] ni colapsa a 0
 * cuando wins=0. Devuelve porcentajes (0–100) redondeados a 1 decimal.
 *
 * @param {number} wins - éxitos
 * @param {number} n - ensayos (wins + losses); NO incluye flats/no direccionales
 * @param {number} [z=Z_95]
 * @returns {{ point: number|null, low: number|null, high: number|null, n: number }}
 */
export function wilsonInterval(wins, n, z = Z_95) {
  if (!Number.isFinite(n) || n <= 0) return { point: null, low: null, high: null, n: 0 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  const pct = (x) => parseFloat((Math.max(0, Math.min(1, x)) * 100).toFixed(1));
  return {
    point: parseFloat((p * 100).toFixed(1)),
    low: pct(centre - margin),
    high: pct(centre + margin),
    n,
  };
}
