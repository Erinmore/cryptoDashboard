/**
 * store.js — Estado global de CRYPTEX
 *
 * Estado mínimo y plano: se muta directamente con setState() y notifica
 * a los suscriptores. No hay framework reactivo — los consumidores
 * llaman a render()/updateSidebar() desde los callbacks de subscribe().
 */

const _state = {
  // Selección del usuario
  coin: 'BTC',
  tf:   '4h',

  // Datos del backend (GET /api/data)
  candles:      null,   // Array<{t, open, high, low, close, volume}>
  technical:    null,   // { '15m': {...}, '1h': {...}, '4h': {...} }
  sentiment:    null,   // { score, bullish_votes, bearish_votes, ... }
  fearGreed:    null,   // { value, classification, trend, ... }
  derivatives:  null,   // { funding_rate, open_interest, long_short_ratio }
  btcDominance: null,   // number
  lastAnalysis: null,   // { timestamp, action, confidence } | null
  priceCurrent: null,   // number
  priceChange:  null,   // number (%)

  // Análisis IA (POST /api/analyze)
  recommendation: null, // objeto completo de recomendación

  // Cámara del gráfico (Fase 8: se mueve aquí desde app.js)
  viewport: null,
};

const _listeners = new Set();

/** Lee el estado actual (solo lectura). */
export function getState() {
  return _state;
}

/**
 * Aplica un patch parcial al estado y notifica a los suscriptores.
 * @param {Partial<typeof _state>} patch
 */
export function setState(patch) {
  Object.assign(_state, patch);
  for (const fn of _listeners) fn(_state);
}

/**
 * Suscribe una función que se llama cada vez que el estado cambia.
 * @param {function} fn
 * @returns {function} unsubscribe
 */
export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
