/**
 * riskGeometryCard.js — tarjeta de geometría de riesgo SIMÉTRICA (largo + corto a la vez).
 *
 * Sustituye al viejo `renderConditionalPlan` de una sola dirección (retirado con el pivot a
 * ayudante de riesgo, §REORIENTACIÓN — ver CLAUDE.md): el sistema ya no afirma ninguna
 * ventaja direccional, así que no elige entre largo y corto, muestra los dos.
 *
 * DUEÑO ÚNICO, usado por `ui/sidebar.js` (panel en vivo) y `ui/history.js` (tarjetas del
 * historial) — la razón de extraerlo es evitar el desfase que ya mordió una vez entre esas
 * dos pantallas (2026-08-09, cuando cada una recalculaba su propio R:R por separado).
 *
 * Los números que enseña son los que ya calcula `utils/riskGeometry.js` en el backend
 * (stop/objetivo en múltiplos de ATR, R:R, equilibrio, alcanzabilidad medida) — esta tarjeta
 * no inventa ni recalcula nada, solo formatea.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** % con signo desde `entryPrice` hasta `price`. Relativo, nunca un precio absoluto. */
function fmtPct(entryPrice, price) {
  if (entryPrice == null || price == null) return '—';
  const pct = ((price - entryPrice) / entryPrice) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** Múltiplo de ATR con signo — viene de `thresholds`, no se recalcula desde los precios. */
function fmtAtrMult(k, sign) {
  if (k == null) return '';
  const signed = k * sign;
  return `${signed >= 0 ? '+' : ''}${signed.toFixed(1)}×ATR`;
}

function sideCard(side, kAdverse, kTarget) {
  const isLong = side.direction === 'long';
  const card = el('div', `risk-side ${isLong ? 'bullish' : 'bearish'}`);
  card.appendChild(el('div', 'risk-side-label', isLong ? 'LARGO' : 'CORTO'));

  const row = (label, value, hint, warn = false) => {
    const r = el('div', `risk-row${warn ? ' warn' : ''}`);
    r.appendChild(el('span', 'risk-row-label', label));
    r.appendChild(el('span', 'risk-row-value', value));
    if (hint) r.dataset.tooltip = hint;
    card.appendChild(r);
  };

  const stopSign = isLong ? -1 : 1;
  const targetSign = isLong ? 1 : -1;
  row('Stop', `${fmtAtrMult(kAdverse, stopSign)} (${fmtPct(side.entry_price, side.stop_price)})`);
  row('Objetivo', `${fmtAtrMult(kTarget, targetSign)} (${fmtPct(side.entry_price, side.tp1_price)})`);
  if (side.rr != null) {
    row('R:R', `${side.rr} → equilibrio ${side.breakeven_win_rate_pct}%`,
      'Aritmética del R:R, no un pronóstico: por debajo de ese acierto el plan pierde dinero. '
      + 'Idéntico en ambas direcciones — es la prueba de que no codifica ninguna opinión.');
  }
  if (side.target_reachability_pct != null) {
    row('Alcanza el objetivo', `${side.target_reachability_pct}%`,
      'TARGET_REACHABILITY: con qué frecuencia el mercado recorre esta distancia dentro de la '
      + 'vigencia declarada. Por debajo del 15% lo normal es que el plan caduque abierto.',
      side.target_unreachable === true);
  }
  return card;
}

/**
 * @param {object|null} geometry — forma exacta de `computeRiskGeometry` (backend):
 *   { long, short, validity_candles, tf_execution, expires_at, atr_pct, thresholds, measured_at }
 * @returns {HTMLElement|null} null si no hay geometría que mostrar.
 */
export function renderRiskGeometryCard(geometry) {
  if (!geometry?.long || !geometry?.short) return null;

  const box = el('div', 'risk-geometry');
  box.appendChild(el('div', 'risk-geometry-title', 'Geometría de riesgo (simétrica)'));

  const meta = el('div', 'risk-geometry-meta');
  const bits = [];
  if (geometry.validity_candles && geometry.tf_execution) {
    bits.push(`${geometry.validity_candles} velas ${geometry.tf_execution}`);
  }
  if (geometry.expires_at) {
    const d = new Date(geometry.expires_at);
    const vencido = d.getTime() < Date.now();
    bits.push(`caduca ${d.toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      + (vencido ? ' · CADUCADO' : ''));
  }
  if (geometry.atr_pct != null) bits.push(`ATR ${geometry.atr_pct}%`);
  meta.textContent = bits.join(' · ');
  box.appendChild(meta);

  const cols = el('div', 'risk-geometry-cols');
  const k = geometry.thresholds ?? {};
  cols.appendChild(sideCard(geometry.long, k.adverse_k_atr, k.target_k_atr));
  cols.appendChild(sideCard(geometry.short, k.adverse_k_atr, k.target_k_atr));
  box.appendChild(cols);

  if (geometry.measured_at) {
    box.appendChild(el('div', 'risk-geometry-note',
      `Ambas direcciones a la vez — nunca una recomendación. Alcanzabilidad medida el ${geometry.measured_at}.`));
  }

  return box;
}
