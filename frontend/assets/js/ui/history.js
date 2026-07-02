/**
 * history.js — Modal de historial de análisis IA (Fase 12).
 *
 * Consume GET /api/history/:coin y renderiza una lista de tarjetas con la decisión
 * del LLM (acción, confianza, scores desglosados, gating, setup, contexto y avisos
 * del validador determinista). Solo lectura; no dispara análisis.
 */

import { fetchHistory } from '../api/client.js';

const $ = (id) => document.getElementById(id);

// ── Helpers de formato ─────────────────────────────────────────────

function fmtSigned(v) {
  if (v == null || Number.isNaN(v)) return '?';
  return v > 0 ? `+${v}` : `${v}`;
}

function fmtPrice(n) {
  if (n == null) return '—';
  if (n >= 10000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 100)   return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `hace ${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days}d`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Clase CSS de color por acción (español).
function actionClass(action) {
  switch (action) {
    case 'Comprar':  return 'buy';
    case 'Vender':   return 'sell';
    case 'Preparar': return 'prep';
    default:         return 'wait';
  }
}

// ── Render de una tarjeta ──────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderCard(a) {
  const card = el('div', 'hist-card');

  // Cabecera: acción + confianza + timestamp
  const head = el('div', 'hist-card-head');
  const action = el('span', `hist-action ${actionClass(a.action)}`, a.action ?? '—');
  head.appendChild(action);
  head.appendChild(el('span', 'hist-confidence', a.confidence ?? '—'));
  const ts = el('span', 'hist-ts');
  ts.textContent = `${timeAgo(a.timestamp)} · ${fmtDate(a.timestamp)}`;
  ts.title = a.timestamp ?? '';
  head.appendChild(ts);
  card.appendChild(head);

  // Línea de scores
  const scores = el('div', 'hist-scores');
  const parts = [['D', a.score_derivatives], ['E', a.score_structure], ['V', a.score_volume], ['O', a.score_onchain]]
    .map(([lbl, v]) => `${lbl} ${fmtSigned(v)}`).join('  ·  ');
  scores.textContent = `${parts}   →   Total ${fmtSigned(a.score_total)}`;
  card.appendChild(scores);

  // Meta: driver, riesgo, precio, TF, contexto
  const meta = el('div', 'hist-meta');
  const metaBits = [];
  if (a.primary_driver) metaBits.push(`driver: ${a.primary_driver}`);
  if (a.risk_score != null) metaBits.push(`riesgo ${a.risk_score}/10`);
  if (a.price_current != null) metaBits.push(fmtPrice(a.price_current));
  if (a.primary_tf) metaBits.push(`TF ${a.primary_tf}`);
  if (a.macro_regime) metaBits.push(a.macro_regime);
  if (a.fear_greed_value != null) metaBits.push(`F&G ${a.fear_greed_value}`);
  meta.textContent = metaBits.join('  ·  ');
  card.appendChild(meta);

  // Setup táctico (si lo hubo)
  if (a.has_executable_setup && a.setup_entry_price != null) {
    const setup = el('div', 'hist-setup');
    setup.textContent = `Entrada ${fmtPrice(a.setup_entry_price)}  ·  SL ${fmtPrice(a.setup_stop_price)}  ·  TP1 ${fmtPrice(a.setup_tp1_price)}`;
    card.appendChild(setup);
  }

  // Badges: gating y avisos del validador
  const badges = el('div', 'hist-badges');
  if (a.gating_active) {
    const b = el('span', 'hist-badge warn', 'gating');
    if (a.gating_reason) b.title = a.gating_reason;
    badges.appendChild(b);
  }
  if (a.tf_conflict) {
    badges.appendChild(el('span', 'hist-badge watch', 'conflicto TF'));
  }
  if (a.validation_warnings) {
    let warns = [];
    try { warns = JSON.parse(a.validation_warnings); } catch { /* ignore */ }
    const severe = warns.filter(w => w.severity === 'severe').length;
    const label = severe > 0 ? `${warns.length} avisos (${severe} sev.)` : `${warns.length} avisos`;
    const b = el('span', `hist-badge ${severe > 0 ? 'warn' : 'watch'}`, label);
    b.title = warns.map(w => `${w.severity}: ${w.rule}`).join('\n');
    badges.appendChild(b);
  }
  if (badges.childNodes.length) card.appendChild(badges);

  // Resumen ejecutivo
  if (a.executive_summary) {
    card.appendChild(el('p', 'hist-summary', a.executive_summary));
  }

  return card;
}

// ── API pública del modal ──────────────────────────────────────────

let escHandler = null;

export function closeHistory() {
  $('history-overlay')?.classList.add('hidden');
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

export async function openHistory(coin) {
  const overlay = $('history-overlay');
  const body = $('history-body');
  if (!overlay || !body) return;

  $('history-coin').textContent = coin;
  body.innerHTML = '';
  body.appendChild(el('p', 'history-empty', 'Cargando…'));
  overlay.classList.remove('hidden');

  // Cerrar con Escape
  escHandler = (e) => { if (e.key === 'Escape') closeHistory(); };
  document.addEventListener('keydown', escHandler);

  try {
    const data = await fetchHistory(coin, 30, 0);
    body.innerHTML = '';
    if (!data.analyses?.length) {
      body.appendChild(el('p', 'history-empty', 'Sin análisis para esta moneda. Pulsa Analizar para generar el primero.'));
      return;
    }
    const count = el('p', 'history-count', `${data.total} análisis${data.total > data.analyses.length ? ` (mostrando ${data.analyses.length})` : ''}`);
    body.appendChild(count);
    for (const a of data.analyses) body.appendChild(renderCard(a));
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('p', 'history-empty', `Error cargando el historial: ${err.message}`));
  }
}

/**
 * Cablea los eventos del modal (botón cerrar, click en backdrop).
 * Llamar una vez en init().
 */
export function initHistoryModal() {
  $('history-close')?.addEventListener('click', closeHistory);
  $('history-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('history-overlay')) closeHistory();  // click fuera del modal
  });
}
