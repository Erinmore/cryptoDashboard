/**
 * history.js — Modal de historial de análisis IA (Fase 12).
 *
 * Consume GET /api/history/:coin y renderiza una lista de tarjetas con la LECTURA del LLM
 * (prosa) y la geometría de riesgo simétrica calculada por el backend. Pivot a ayudante de
 * riesgo (§REORIENTACIÓN, ver CLAUDE.md): el LLM ya no decide ni puntúa nada, así que este
 * modal dejó de mostrar acción/scores/gating/setup — esos campos siguen en filas anteriores
 * al pivot (histórico legible) pero ninguna fila nueva los rellena. Solo lectura; no dispara
 * análisis.
 */

import { fetchHistory, fetchOutcomeStats } from '../api/client.js';
import { renderRiskGeometryCard } from './riskGeometryCard.js';

const $ = (id) => document.getElementById(id);

// ── Helpers de formato ─────────────────────────────────────────────

function fmtPrice(n) {
  if (n == null) return '—';
  if (n >= 10000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 100)   return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

// Etiqueta corta del modelo para la tarjeta (fallback al id crudo para análisis
// antiguos con modelos fuera de la lista actual, p.ej. claude-opus-4-7).
const MODEL_LABELS = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5': 'Haiku 4.5',
};
function modelLabel(id) {
  return MODEL_LABELS[id] ?? (id ? id.replace('claude-', '') : '');
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

// Clase de color por resultado de outcome (drift crudo, no direccional desde el pivot).
function outcomeClass(o) {
  return o === 'win' ? 'win' : o === 'loss' ? 'loss' : 'muted';
}

function fmtSignedPct(v) {
  if (v == null) return '';
  return `${v > 0 ? '+' : ''}${v}%`;
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

  // Cabecera: modelo + timestamp (la acción/confianza se retiraron con el pivot).
  const head = el('div', 'hist-card-head');
  if (a.model_used) head.appendChild(el('span', 'hist-model', modelLabel(a.model_used)));
  const ts = el('span', 'hist-ts');
  ts.textContent = `${timeAgo(a.timestamp)} · ${fmtDate(a.timestamp)}`;
  ts.title = a.timestamp ?? '';
  head.appendChild(ts);
  card.appendChild(head);

  // Meta: precio, TF, contexto de mercado.
  const meta = el('div', 'hist-meta');
  const metaBits = [];
  if (a.price_current != null) metaBits.push(fmtPrice(a.price_current));
  if (a.primary_tf) metaBits.push(`TF ${a.primary_tf}`);
  if (a.macro_regime) metaBits.push(a.macro_regime);
  if (a.fear_greed_value != null) metaBits.push(`F&G ${a.fear_greed_value}`);
  meta.textContent = metaBits.join('  ·  ');
  card.appendChild(meta);

  // ── GEOMETRÍA DE RIESGO SIMÉTRICA ────────────────────────────────────────
  // Dueño único en riskGeometryCard.js — el mismo renderer que el panel en vivo, para que
  // las dos pantallas no puedan divergir (lección del desfase corregido el 2026-08-09).
  const geoCard = renderRiskGeometryCard(a.risk_geometry);
  if (geoCard) card.appendChild(geoCard);

  // Resultado a posteriori (analysis_outcome) — grabación de mercado, no direccional.
  const horizons = [['1h', a.outcome_1h], ['24h', a.outcome_24h], ['7d', a.outcome_7d]]
    .filter(([, o]) => o != null);
  if (horizons.length) {
    const row = el('div', 'hist-outcome');
    row.appendChild(el('span', 'hist-outcome-label', 'Recorrido'));
    for (const [lbl, o] of horizons) {
      let txt = `${lbl}: ${o}`;
      if (lbl === '24h' && a.pnl_pct_24h != null) txt += ` (${fmtSignedPct(a.pnl_pct_24h)})`;
      row.appendChild(el('span', `hist-outcome-badge ${outcomeClass(o)}`, txt));
    }
    card.appendChild(row);
  } else {
    card.appendChild(el('div', 'hist-outcome pending', 'Recorrido pendiente (se evalúa a partir de 1h)'));
  }

  // Resumen ejecutivo (la lectura completa en prosa se ve en el panel en vivo; aquí,
  // el titular — ampliar las seis secciones en cada tarjeta haría el modal ilegible).
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
    // Historial + métricas de backtesting en paralelo.
    const [data, statsRes] = await Promise.all([
      fetchHistory(coin, 30, 0),
      fetchOutcomeStats(coin).catch(() => null),
    ]);
    body.innerHTML = '';

    // Bloque de métricas agregadas (arriba del todo).
    if (statsRes?.stats) body.appendChild(renderStats(statsRes.stats));

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

// Bloque de métricas agregadas (cabecera del modal).
//
// Pivot a ayudante de riesgo (§REORIENTACIÓN): sin dictamen direccional no hay win-rate,
// shadow trades ni calibración de convicción que reportar — `getOutcomeStats` ya no los
// devuelve. Lo que queda es el coste de oportunidad, que es direction-agnostic por
// construcción (`classifyOpportunity` no mira ninguna dirección propuesta, solo el
// recorrido real) y sigue midiendo algo real: ¿con qué frecuencia el mercado ofrece un
// movimiento limpio desde un instante cualquiera?
function renderStats(s) {
  const box = el('div', 'hist-stats');
  box.appendChild(el('span', 'hist-stats-title', 'Actividad de mercado'));

  if (!s.total_evaluated) {
    box.appendChild(el('span', 'hist-stats-empty', 'aún sin resultados — los análisis se evalúan a partir de 1h'));
    return box;
  }

  const opp = s.opportunity_cost?.['24h'];
  if (opp?.evaluable_n) {
    const sub = el('div', 'hist-stats-sub');
    sub.appendChild(el('span', 'hist-stats-subtitle', '¿Ofrecía el mercado un movimiento limpio? (24h)'));
    const g = el('div', 'hist-stats-grid');
    const m = (label, value, cls, title) => {
      const d = el('div', 'hist-stat');
      if (title) d.dataset.tooltip = title;
      d.appendChild(el('span', 'hist-stat-label', label));
      d.appendChild(el('span', `hist-stat-value ${cls ?? ''}`, value));
      g.appendChild(d);
    };
    const k = opp.thresholds ?? {};
    m('Mercado ofrecía', `${opp.offered_pct}% (${opp.offered_n}/${opp.evaluable_n})`, '',
      `Movimiento limpio de ${k.target_k_atr}×ATR antes de ${k.adverse_k_atr}×ATR en contra, `
      + 'en cualquier dirección — no mira ninguna propuesta del sistema.');
    if (opp.lift_pct != null) {
      const signo = opp.lift_pct > 0 ? '+' : '';
      const puntoLift = `${signo}${opp.lift_pct} pts`;
      const rangoOfrecido = opp.offered_pct_ci_low == null ? null
        : `${opp.offered_pct_ci_low}–${opp.offered_pct_ci_high}%`;
      const titular = !opp.lift_significant && rangoOfrecido ? `IC ${rangoOfrecido}` : puntoLift;
      m('vs. azar (lift)', titular,
        opp.lift_significant ? (opp.lift_pct > 0 ? 'win' : 'loss') : '',
        `Tasa base incondicional: ${opp.base_rate_pct}% (medida ${opp.base_rate_measured_at} `
        + 'sobre 90d de SOL/BTC/ETH). '
        + (rangoOfrecido ? `Mercado ofrecía con IC 95%: ${rangoOfrecido}. ` : '')
        + (opp.lift_significant
          ? 'La base queda FUERA del intervalo: el lift sí se puede afirmar.'
          : `Lift puntual: ${puntoLift}, pero la base (${opp.base_rate_pct}%) cae DENTRO del `
            + 'intervalo — con esta muestra no se puede distinguir de azar todavía.'));
    }
    if (opp.median_hours_to_target != null) {
      m('Mediana hasta objetivo', `${opp.median_hours_to_target} h`, '',
        'Cuánto tardó en llegar el movimiento, cuando llegó.');
    }
    if (opp.blocked_by_adverse_n) {
      m('Latigazos', String(opp.blocked_by_adverse_n), '',
        'Llegó al objetivo, pero después de irse en contra primero.');
    }
    if (opp.pending_n) {
      m('Ventana abierta', String(opp.pending_n), 'muted',
        'Análisis a los que aún no les ha vencido el horizonte: no cuentan como "no ofreció" '
        + 'hasta que pase el tiempo.');
    }
    if (opp.avg_max_excursion_atr != null) {
      m('Excursión media', `${opp.avg_max_excursion_atr}×ATR`, '',
        'Magnitud cruda del recorrido, sin exigir que fuera limpio.');
    }
    if (s.episodes && s.episodes.episodes_n < s.episodes.analyses_n) {
      m('Episodios', `${s.episodes.episodes_n} de ${s.episodes.analyses_n}`, '',
        'Análisis de la misma vela del TF primario cuentan como una sola observación.');
    }
    sub.appendChild(g);
    box.appendChild(sub);
  }

  const grid = el('div', 'hist-stats-grid');
  const metric = (label, value) => {
    const m = el('div', 'hist-stat');
    m.appendChild(el('span', 'hist-stat-label', label));
    m.appendChild(el('span', 'hist-stat-value', value));
    grid.appendChild(m);
  };
  metric('Análisis evaluados', String(s.total_evaluated));
  box.appendChild(grid);

  return box;
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
