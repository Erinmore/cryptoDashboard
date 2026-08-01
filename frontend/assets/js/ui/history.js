/**
 * history.js — Modal de historial de análisis IA (Fase 12).
 *
 * Consume GET /api/history/:coin y renderiza una lista de tarjetas con la decisión
 * del LLM (acción, confianza, scores desglosados, gating, setup, contexto y avisos
 * del validador determinista). Solo lectura; no dispara análisis.
 */

import { fetchHistory, fetchOutcomeStats } from '../api/client.js';

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

// Clase CSS de color por acción (español).
function actionClass(action) {
  switch (action) {
    case 'Comprar':  return 'buy';
    case 'Vender':   return 'sell';
    case 'Preparar': return 'prep';
    default:         return 'wait';
  }
}

// Clase de color por resultado de outcome.
function outcomeClass(o) {
  return o === 'win' ? 'win' : o === 'loss' ? 'loss' : 'muted';
}

function fmtSignedPct(v) {
  if (v == null) return '';
  return `${v > 0 ? '+' : ''}${v}%`;
}

// Lectura del resultado del shadow trade (evaluación del conditional_setup).
// El texto dice lo que PASÓ, no un veredicto sobre la abstención: que el trade declarado
// hubiera ganado no convierte el `Esperar` en error — el análisis es una foto y el disparo
// lo recogería el análisis siguiente. Ver la cabecera de backend/src/utils/shadowTrade.js.
function shadowResult(outcome, filled, invalidReason) {
  const PERMISIVO = 'Se evalúa la GEOMETRÍA: la entrada cuenta como llena al tocarla '
    + 'intravela. El disparo textual (p. ej. "cierre 4h < X") no se comprueba, así que '
    + 'esta lectura es más permisiva que el gatillo declarado.';
  switch (outcome) {
    case 'tp1':
      return { text: '↪ Se dio · habría llegado al TP', cls: 'win', tip: PERMISIVO };
    case 'stop':
      return { text: '↪ Se dio · habría saltado el stop', cls: 'loss', tip: PERMISIVO };
    case 'expired':
      return { text: '↪ Se dio · caducó sin TP ni stop', cls: 'muted',
        tip: `La entrada se llenó pero ni TP ni stop se tocaron dentro de la vigencia declarada. ${PERMISIVO}` };
    case 'not_triggered':
      return { text: '↪ No se dio · la condición nunca apareció', cls: 'muted',
        tip: `El precio no llegó a la entrada dentro de la vigencia declarada: la abstención fue consistente con lo que el análisis dijo que esperaba. ${PERMISIVO}` };
    case 'open':
      return { text: `↪ Vigente${filled ? ' · entrada llena' : ''}`, cls: 'muted',
        tip: 'La vigencia declarada aún no ha vencido: el resultado no está cerrado.' };
    case 'truncated':
      return { text: '↪ Sin cerrar · vigencia > 7 días', cls: 'muted',
        tip: 'La vigencia declarada supera los 7 días de velas que mide el job, así que no se puede afirmar que no disparase.' };
    case 'invalid':
      return { text: '↪ No evaluable', cls: 'muted',
        tip: `Geometría inevaluable (${invalidReason ?? 'sin motivo'}): se cuenta aparte para que no ensucie el win-rate.` };
    default:
      return { text: `↪ ${outcome}`, cls: 'muted', tip: '' };
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
  if (a.model_used) head.appendChild(el('span', 'hist-model', modelLabel(a.model_used)));
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
  // La convicción es la variable que más discrimina entre análisis cuando los scores salen
  // todos a 0 (señal H3 de la fase de recogida), y el modal —que es donde se comparan unos
  // con otros— no la mostraba. Revisión crítica 2026-07-26, M4.
  if (a.conviction != null) metaBits.push(`convicción ${Number(a.conviction).toFixed(2)}`);
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
    if (a.gating_reason) b.dataset.tooltip = a.gating_reason;
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
    b.dataset.tooltip = warns.map(w => `${w.severity}: ${w.rule}`).join('\n');
    badges.appendChild(b);
  }
  if (badges.childNodes.length) card.appendChild(badges);

  // ── Contradicciones ────────────────────────────────────────────────────────
  // NO se pintan como insignia: hace falta ver LOS TRES ejes y cuáles fallan. La versión
  // anterior decía "2 contradic. (de 3)" y era ambigua por partida doble — ese 3 eran las
  // señales CRUDAS y no los bloques, y no se veía cuáles estaban en contra. Si una etiqueta
  // necesita un tooltip para entenderse, la etiqueta está mal (2026-07-31).
  //
  // El conteo cuenta BLOQUES analíticos distintos (volumen/derivados/estructura, máximo 3);
  // con los tres en contra la convicción decae y el output se fuerza a `Esperar`.
  if (a.contradiction_blocks != null || a.contradiction_count != null) {
    const parse = (v) => { try { return JSON.parse(v) ?? []; } catch { return []; } };
    const blocks  = parse(a.contradiction_blocks);
    const codes   = parse(a.contradiction_codes);
    const deduped = parse(a.deduped_by_veto);
    // Mismo mapa que utils/gating.js. Solo se usa para repartir los códigos entre los ejes
    // en el detalle; el dato que manda es `contradiction_blocks`, que llega del backend.
    const BLOCK_OF = {
      cvd_1d_divergence: 'volume', oi_flat_or_falling: 'derivatives',
      price_near_key_level: 'structure', htf_conflict_1w_1d: 'structure',
      smc_structural_conflict: 'structure',
    };
    const ES = { volume: 'volumen', derivatives: 'derivados', structure: 'estructura' };
    const n = a.contradiction_count ?? blocks.length;

    const box = el('div', 'hist-contra');
    box.appendChild(el('span', 'hist-contra-label', `Contradicciones · ${n} de 3 ejes`));

    const chips = el('div', 'hist-contra-chips');
    for (const key of ['volume', 'derivatives', 'structure']) {
      const on = blocks.includes(key);
      const chip = el('span', `hist-contra-chip ${on ? 'on' : 'off'}`,
        `${on ? '✕' : '✓'} ${ES[key]}`);
      const suyos = codes.filter((c) => BLOCK_OF[c] === key);
      // `data-tooltip` = sistema propio del proyecto. El `title` nativo apenas se ve, y era
      // lo que hacía invisible la ayuda que había puesto aquí.
      chip.dataset.tooltip = suyos.length
        ? `En contra:\n· ${suyos.join('\n· ')}`
        : 'Sin contradicción en este eje';
      chips.appendChild(chip);
    }
    box.appendChild(chips);

    const nota = el('div', 'hist-contra-note', n >= 3
      ? 'Los 3 ejes en contra → la convicción decae y se fuerza Esperar.'
      : `Con los 3 en contra se forzaría Esperar. Este análisis lo decidió el modelo.`);
    if (deduped.length) {
      nota.dataset.tooltip = `El veto ya cubría estas, por eso no cuentan aparte:\n· ${deduped.join('\n· ')}`;
    }
    box.appendChild(nota);
    card.appendChild(box);
  }


  // Qué falta para poder operar. Es la única salida accionable de un sistema que dice
  // "Esperar" casi siempre: se persistía y se devolvía por la API, pero no se pintaba en
  // ninguna pantalla (revisión crítica 2026-07-26, M4).
  // Setup CONDICIONAL: el trade que se tomaría si apareciera lo que falta. Es lo que hace
  // medible una abstención — sin geometría declarada, un `Esperar` es incontestable. Se
  // persistía desde v9_0 pero no se devolvía por la API ni se pintaba (corregido 2026-07-31).
  if (a.conditional_setup) {
    let cs = null;
    try { cs = JSON.parse(a.conditional_setup); } catch { /* ignore */ }
    if (cs && cs.entry_price != null) {
      const box = el('div', 'hist-conditional');
      const dir = cs.direction === 'short' ? 'CORTO' : 'LARGO';
      box.appendChild(el('span', 'hist-conditional-label', `Si se cumpliera · ${dir}`));
      const geo = el('div', 'hist-conditional-geo');
      geo.textContent = `Entrada ${fmtPrice(cs.entry_price)}  ·  SL ${fmtPrice(cs.stop_price)}`
        + `  ·  TP ${fmtPrice(cs.tp1_price)}`
        + (cs.validity_candles ? `  ·  ${cs.validity_candles} velas ${cs.tf_execution ?? ''}` : '');
      box.appendChild(geo);
      if (cs.trigger) {
        const trg = el('div', 'hist-conditional-trigger');
        trg.textContent = `Disparo: ${cs.trigger}`;
        box.appendChild(trg);
      }
      // R:R calculado aquí y no en el backend: es una lectura de la geometría, no un dato.
      const risk = Math.abs(cs.entry_price - cs.stop_price);
      const reward = Math.abs((cs.tp1_price ?? cs.entry_price) - cs.entry_price);
      if (risk > 0 && reward > 0) {
        box.appendChild(el('div', 'hist-conditional-rr', `R:R ${(reward / risk).toFixed(2)}`));
      }
      // Resultado del SHADOW TRADE: ¿llegó a darse la condición que este análisis nombró,
      // y qué habría hecho el trade? Es lo que convierte una abstención en algo evaluable.
      if (a.cond_outcome) {
        const r = shadowResult(a.cond_outcome, a.cond_filled, a.cond_invalid_reason);
        const badge = el('div', `hist-conditional-result ${r.cls}`, r.text);
        badge.dataset.tooltip = r.tip;
        box.appendChild(badge);
      }
      card.appendChild(box);
    }
  }

  if (a.missing_confirmations) {
    let items = [];
    try { items = JSON.parse(a.missing_confirmations) ?? []; } catch { /* ignore */ }
    if (Array.isArray(items) && items.length) {
      const box = el('div', 'hist-missing');
      box.appendChild(el('span', 'hist-missing-label', 'Falta para operar'));
      const ul = el('ul', 'hist-missing-list');
      for (const it of items.slice(0, 5)) ul.appendChild(el('li', '', String(it)));
      box.appendChild(ul);
      card.appendChild(box);
    }
  }

  // Resultado a posteriori (analysis_outcome)
  const horizons = [['1h', a.outcome_1h], ['24h', a.outcome_24h], ['7d', a.outcome_7d]]
    .filter(([, o]) => o != null);
  const hasSetupOutcome = a.has_executable_setup && a.setup_outcome && a.setup_outcome !== 'open';
  if (horizons.length || hasSetupOutcome) {
    const row = el('div', 'hist-outcome');
    row.appendChild(el('span', 'hist-outcome-label', 'Resultado'));
    for (const [lbl, o] of horizons) {
      let txt = `${lbl}: ${o}`;
      // Direccionales: PnL de la estrategia (firmado por dirección); resto: movimiento crudo.
      const pnl24 = a.pnl_signed_pct_24h ?? a.pnl_pct_24h;
      if (lbl === '24h' && pnl24 != null) txt += ` (${fmtSignedPct(pnl24)})`;
      row.appendChild(el('span', `hist-outcome-badge ${outcomeClass(o)}`, txt));
    }
    if (hasSetupOutcome) {
      const so = a.setup_outcome;
      const cls = (so === 'tp1' || so === 'tp2') ? 'win' : so === 'stop' ? 'loss' : 'muted';
      const SETUP_LABELS = {
        tp1: 'TP1', tp2: 'TP2', stop: 'Stop',
        expired: 'expirado', not_triggered: 'sin activar', invalid: 'inválido',
      };
      row.appendChild(el('span', `hist-outcome-badge ${cls}`, `setup: ${SETUP_LABELS[so] ?? so}`));
    }
    card.appendChild(row);
  } else {
    card.appendChild(el('div', 'hist-outcome pending', 'Resultado pendiente (se evalúa a partir de 1h)'));
  }

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

// Bloque de métricas agregadas de backtesting (cabecera del modal).
function renderStats(s) {
  const box = el('div', 'hist-stats');
  box.appendChild(el('span', 'hist-stats-title', 'Backtesting'));

  if (!s.total_evaluated) {
    box.appendChild(el('span', 'hist-stats-empty', 'aún sin resultados — los análisis se evalúan a partir de 1h'));
    return box;
  }

  // Fase 5 · coste de oportunidad. Va PRIMERO y separado del win-rate a propósito: con
  // `Esperar` como salida dominante es la única métrica con denominador, y enterrarla
  // debajo de un "muestra insuficiente" repetiría el problema que vino a resolver.
  const opp = s.opportunity_cost?.['24h'];
  if (opp?.evaluable_n) {
    const sub = el('div', 'hist-stats-sub');
    sub.appendChild(el('span', 'hist-stats-subtitle', 'Coste de oportunidad de esperar (24h)'));
    const g = el('div', 'hist-stats-grid');
    const m = (label, value, cls, title) => {
      const d = el('div', 'hist-stat');
      // `data-tooltip` (sistema propio) y no `title`: el nativo apenas se ve y quedaría
      // incoherente con el bloque de shadow trades, que está justo debajo.
      if (title) d.dataset.tooltip = title;
      d.appendChild(el('span', 'hist-stat-label', label));
      d.appendChild(el('span', `hist-stat-value ${cls ?? ''}`, value));
      g.appendChild(d);
    };
    const k = opp.thresholds ?? {};
    m('Mercado ofrecía', `${opp.offered_pct}% (${opp.offered_n}/${opp.evaluable_n})`, '',
      `Movimiento limpio de ${k.target_k_atr}×ATR antes de ${k.adverse_k_atr}×ATR en contra.`);
    // El % absoluto no dice nada sin la tasa base: si esperar acierta al mismo ritmo que
    // un instante al azar, la abstención no aporta información. Lo que informa es el lift.
    if (opp.lift_pct != null) {
      const signo = opp.lift_pct > 0 ? '+' : '';
      m('vs. azar (lift)', `${signo}${opp.lift_pct} pts`,
        opp.lift_pct > 5 ? 'loss' : opp.lift_pct < -5 ? 'win' : '',
        `Tasa base incondicional: ${opp.base_rate_pct}% (medida ${opp.base_rate_measured_at} `
        + 'sobre 90d de SOL/BTC/ETH). Negativo = se esperó en momentos que ofrecían MENOS '
        + 'que el azar, o sea criterio. Cerca de 0 = la abstención no informa. '
        + 'Positivo = se dejó pasar recorrido que sí estaba ahí.');
    }
    if (opp.median_hours_to_target != null) {
      m('Mediana hasta objetivo', `${opp.median_hours_to_target} h`, '',
        'Cuánto tardó en llegar el movimiento. Muy tarde = no era lo que el análisis miraba.');
    }
    if (opp.blocked_by_adverse_n) {
      m('Latigazos', String(opp.blocked_by_adverse_n), '',
        'Llegó al objetivo, pero después de irse en contra: no era operable.');
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

  // Shadow trades: el conditional_setup evaluado. Va junto al coste de oportunidad y por
  // encima del win-rate clásico porque, mientras el sistema apenas emita direccionales,
  // es el único bloque con denominador que crece (los gatillos condicionales se resuelven
  // mucho más a menudo que las puertas direccionales).
  const sh = s.shadow_trades;
  if (sh?.evaluated_n) {
    const sub = el('div', 'hist-stats-sub');
    sub.appendChild(el('span', 'hist-stats-subtitle', 'Shadow trades (el trade que se habría tomado)'));
    const g = el('div', 'hist-stats-grid');
    const m = (label, value, cls, title) => {
      const d = el('div', 'hist-stat');
      if (title) d.dataset.tooltip = title;
      d.appendChild(el('span', 'hist-stat-label', label));
      d.appendChild(el('span', `hist-stat-value ${cls ?? ''}`, value));
      g.appendChild(d);
    };
    m('Con vigencia vencida', `${sh.n} de ${sh.evaluated_n}`, '',
      `${sh.pending_n} siguen con la vigencia abierta y no cuentan todavía: un condicional `
      + 'que dispara se resuelve enseguida y uno que no dispara tarda toda su vigencia, así '
      + 'que contarlos antes de tiempo inflaría la tasa de disparo. '
      + `Aparte: ${sh.truncated} sin cerrar (vigencia > 7d) · ${sh.invalid} no evaluables.`);
    if (sh.trigger_rate_pct != null) {
      m('Gatillo se dio', `${sh.trigger_rate_pct}% (${sh.triggered_n}/${sh.conclusive_n})`, '',
        'De los condicionales con la vigencia ya vencida, cuántos vieron el precio alcanzar '
        + 'su entrada dentro de ella. Un sistema cuyos gatillos nunca aparecen está '
        + `describiendo un mercado que no existe. ${sh.fill_rule_note}`);
    }
    if (sh.sample_insufficient) {
      m('Acierto (TP/Stop)', `muestra insuf. (${sh.resolved_n}/${sh.min_directional_sample})`, '',
        'Solo cuentan los que se resolvieron por TP o por stop; los caducados no son ni win ni loss.');
    } else {
      m('Acierto (TP/Stop)', `${sh.win_rate}%`, sh.win_rate >= 50 ? 'win' : 'loss',
        `IC 95% (Wilson): ${sh.win_rate_ci_low}–${sh.win_rate_ci_high}% sobre ${sh.resolved_n} resueltos.`);
    }
    m('TP / Stop / caducados', `${sh.tp1} / ${sh.stop} / ${sh.expired}`, '',
      `Sin disparar: ${sh.not_triggered}.`);
    if (sh.by_episode && sh.n && sh.by_episode.n < sh.n) {
      m('Episodios', `${sh.by_episode.n} de ${sh.n}`, '',
        'Condicionales de la misma vela del TF primario cuentan como una sola observación.');
    }
    sub.appendChild(g);
    box.appendChild(sub);
  }

  const grid = el('div', 'hist-stats-grid');
  const metric = (label, value, cls) => {
    const m = el('div', 'hist-stat');
    m.appendChild(el('span', 'hist-stat-label', label));
    m.appendChild(el('span', `hist-stat-value ${cls ?? ''}`, value));
    grid.appendChild(m);
  };

  metric('Evaluados', String(s.total_evaluated));
  // C5: sin muestra direccional suficiente, el win-rate no es concluyente → se dice
  // explícitamente en vez de mostrar un % engañoso. Con muestra, se acompaña del IC 95%.
  if (s.sample_insufficient) {
    metric('Win-rate 24h',
      `muestra insuf. (${s.directional_n ?? 0}/${s.min_directional_sample ?? 20})`, '');
  } else {
    metric('Win-rate 24h', `${s.win_rate_24h}%`, s.win_rate_24h >= 50 ? 'win' : 'loss');
    metric('IC 95% (Wilson)', `${s.win_rate_ci_low}–${s.win_rate_ci_high}%`);
  }
  metric('PnL medio 24h',
    s.avg_pnl_signed_pct_24h != null ? fmtSignedPct(s.avg_pnl_signed_pct_24h) : '—',
    s.avg_pnl_signed_pct_24h == null ? '' : s.avg_pnl_signed_pct_24h >= 0 ? 'win' : 'loss');
  metric('W / L 24h (n=' + (s.directional_n ?? 0) + ')', `${s.win_24h ?? 0} / ${s.loss_24h ?? 0}`);
  metric('Setups TP / Stop', `${s.setup_tp ?? 0} / ${s.setup_stop ?? 0}`);
  if (s.setup_fill_rate != null) metric('Setup fill-rate', `${s.setup_fill_rate}%`);

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
