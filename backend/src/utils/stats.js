/**
 * stats.js — utilidades estadísticas puras para el backtesting.
 *
 * Motivación (auditoría C5): el win-rate se reportaba como un % crudo sobre una muestra
 * diminuta y auto-seleccionada (el sistema fuerza Esperar casi siempre → poquísimos
 * direccionales), sin tamaño mínimo ni intervalo de confianza → conclusiones falsas.
 * Aquí el intervalo de Wilson da la incertidumbre real de una proporción con n pequeño.
 */

import { dedupeByEpisode } from './episodes.js';

const Z_95 = 1.959963984540054; // z para IC del 95%

/**
 * Muestra mínima para reportar un win-rate como no-ruido (auditoría C5). Por debajo, el
 * IC de Wilson es tan ancho que la cifra puntual no informa → se marca insuficiente.
 * Vive aquí (y no en dbService) para que el gate sea el MISMO en el win-rate clásico y en
 * el path-aware: dos umbrales distintos para la misma pregunta invitan a citar el que
 * salga favorable.
 */
export const MIN_DIRECTIONAL_SAMPLE = 20;

/**
 * Convenciones de la métrica de oportunidad. NO son umbrales calibrados contra una
 * distribución (a diferencia de los de `gating.js` tras la auditoría de 2026-07-26): son
 * la definición operativa de "movimiento operable", y por eso viajan en la respuesta —
 * quien lea la cifra ve con qué regla se produjo. Se calibran con la muestra, no antes.
 */
export const OPPORTUNITY_DEFAULTS = {
  targetK: 2,   // recorrido favorable, en múltiplos de ATR, que haría el trade rentable
  adverseK: 1,  // recorrido adverso que habría invalidado la entrada antes de llegar
};

/** Parsea `path_first_passage` venga como JSON de SQLite o como objeto ya hidratado. */
export function parseFirstPassage(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

/** Hora del primer cruce de `k` en un sentido, o null si nunca (o fuera del horizonte). */
function crossedAt(side, k, horizonH) {
  const h = side?.[String(k)];
  if (!Number.isFinite(h)) return null;
  return horizonH == null || h <= horizonH ? h : null;
}

/**
 * ¿Ofreció el mercado un movimiento OPERABLE tras este análisis?
 *
 * Es la pregunta que convierte un `Esperar` en falsable. `classifyOutcome` no puede
 * responderla: compara precio-del-análisis con precio-al-horizonte, así que un `Esperar`
 * nunca produce win ni loss y el win-rate tiene denominador estructuralmente 0.
 *
 * Un movimiento cuenta como ofrecido si alcanzó `targetK`×ATR en algún sentido ANTES de
 * que el sentido contrario alcanzase `adverseK`×ATR. Esa segunda condición es la que
 * distingue oportunidad de latigazo: un recorrido del 3 % precedido de un 1,5 % en contra
 * no era operable, era ruido con final feliz.
 *
 * Deliberadamente SIN dirección propia: no se inventa la tesis que el análisis nunca
 * formuló. Responde "¿había algo que operar?", no "¿en qué lado?".
 *
 * @param {object} row - fila de outcome (acepta `path_first_passage` crudo o parseado).
 * @param {{horizonH?:number, targetK?:number, adverseK?:number}} [opts]
 * @returns {{offered:boolean, direction:'up'|'down'|null, hours_to:number|null,
 *            blocked_by_adverse:boolean, evaluable:boolean}}
 */
export function classifyOpportunity(row, opts = {}) {
  const { targetK = OPPORTUNITY_DEFAULTS.targetK, adverseK = OPPORTUNITY_DEFAULTS.adverseK } = opts;
  const horizonH = opts.horizonH ?? null;
  const fp = parseFirstPassage(row?.path_first_passage);
  const none = { offered: false, direction: null, hours_to: null, blocked_by_adverse: false };
  // Sin rejilla no hay ATR con el que normalizar → no evaluable. Distinto de "no ofreció":
  // confundirlos contaría como acierto de abstención lo que en realidad es un dato ausente.
  if (!fp?.up || !fp?.down) return { ...none, evaluable: false };

  const cand = [];
  for (const [dir, opp] of [['up', 'down'], ['down', 'up']]) {
    const tTarget = crossedAt(fp[dir], targetK, horizonH);
    if (tTarget == null) continue;
    const tAdverse = crossedAt(fp[opp], adverseK, horizonH);
    // Empate = ambos cruces en la MISMA vela de 1h, cuyo orden interno no es resoluble
    // (el high y el low no vienen ordenados). Se asume el adverso primero, igual que
    // `evaluateSetupBarrier` cuando TP1 y stop caen en la misma vela.
    const blocked = tAdverse != null && tAdverse <= tTarget;
    cand.push({ dir, tTarget, blocked });
  }
  if (!cand.length) return { ...none, evaluable: true };

  const clean = cand.filter((c) => !c.blocked).sort((a, b) => a.tTarget - b.tTarget);
  if (clean.length) {
    return {
      offered: true, direction: clean[0].dir, hours_to: clean[0].tTarget,
      blocked_by_adverse: false, evaluable: true,
    };
  }
  // Se alcanzó el objetivo pero siempre con el adverso por delante: no era operable.
  return { ...none, blocked_by_adverse: true, evaluable: true };
}

/**
 * Excursión máxima (el lado que más se movió) en múltiplos de ATR — magnitud cruda del
 * recorrido, sin exigir que fuera limpio. Complementa a `classifyOpportunity`: un mercado
 * puede no ofrecer nada operable y aun así haberse movido mucho (latigazo).
 * @returns {number|null}
 */
export function maxExcursionAtr(row, horizon = '24h') {
  const atr = row?.atr_pct_at_analysis;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const up = row?.[`max_up_pct_${horizon}`];
  const down = row?.[`max_down_pct_${horizon}`];
  const vals = [up, down].filter(Number.isFinite).map(Math.abs);
  if (!vals.length) return null;
  return parseFloat((Math.max(...vals) / atr).toFixed(2));
}

/**
 * Win-rate PATH-AWARE para una acción direccional: ¿llegó el objetivo antes que el stop?
 *
 * El `outcome_24h` actual mira solo el precio AL horizonte, así que un trade que tocó el
 * stop y luego recuperó cuenta como win — cuando en la práctica se habría cerrado en
 * pérdida. Esto mira el camino, no el destino.
 *
 * @returns {'win'|'loss'|'flat'|null} null si no es direccional o no hay rejilla.
 */
export function classifyPathOutcome(action, row, opts = {}) {
  const dir = action === 'Comprar' ? 'up' : action === 'Vender' ? 'down' : null;
  if (!dir) return null;
  const { targetK = OPPORTUNITY_DEFAULTS.targetK, adverseK = OPPORTUNITY_DEFAULTS.adverseK } = opts;
  const horizonH = opts.horizonH ?? null;
  const fp = parseFirstPassage(row?.path_first_passage);
  if (!fp?.up || !fp?.down) return null;

  const opp = dir === 'up' ? 'down' : 'up';
  const tTarget = crossedAt(fp[dir], targetK, horizonH);
  const tStop = crossedAt(fp[opp], adverseK, horizonH);
  if (tTarget == null && tStop == null) return 'flat';   // no se resolvió por ningún lado
  if (tTarget == null) return 'loss';
  if (tStop == null) return 'win';
  return tStop <= tTarget ? 'loss' : 'win';              // empate → stop primero
}

/** Bucket de convicción para la calibración (¿significa algo un 0.3 frente a un 0.7?). */
export function convictionBucket(v) {
  if (!Number.isFinite(v)) return null;
  if (v < 0.4) return 'baja';
  if (v < 0.7) return 'media';
  return 'alta';
}

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

// ─── Agregación (Fase 5) ──────────────────────────────────────────────────────

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  const x = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  return parseFloat(x.toFixed(1));
};

const mean = (xs) => {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return null;
  return parseFloat((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2));
};

/**
 * Coste de oportunidad agregado de las abstenciones (`Esperar`/`Preparar`).
 *
 * Es la medida que faltaba para que el sistema sea refutable: si el mercado casi nunca
 * ofreció un movimiento operable, abstenerse fue criterio; si lo ofreció a menudo y aun
 * así se esperó, es parálisis. Sin esto, un 100 % `Esperar` no se puede distinguir de
 * un sistema que funciona.
 *
 * `thresholds` viaja en la respuesta a propósito: la cifra no significa nada sin la regla
 * que la produjo, y esa regla es una convención pendiente de calibrar con la muestra.
 */
export function summarizeOpportunity(rows, opts = {}) {
  const horizonH = opts.horizonH ?? null;
  const horizonKey = horizonH === 24 ? '24h' : '7d';
  const targetK = opts.targetK ?? OPPORTUNITY_DEFAULTS.targetK;
  const adverseK = opts.adverseK ?? OPPORTUNITY_DEFAULTS.adverseK;

  const evals = (rows ?? []).map((r) => ({
    row: r,
    op: classifyOpportunity(r, { horizonH, targetK, adverseK }),
  }));
  const evaluable = evals.filter((e) => e.op.evaluable);
  const offered = evaluable.filter((e) => e.op.offered);

  return {
    n: evals.length,
    // Sin ATR no hay escala de volatilidad: esas filas no cuentan ni a favor ni en contra.
    evaluable_n: evaluable.length,
    offered_n: offered.length,
    offered_pct: evaluable.length
      ? parseFloat(((offered.length / evaluable.length) * 100).toFixed(1)) : null,
    blocked_by_adverse_n: evaluable.filter((e) => e.op.blocked_by_adverse).length,
    median_hours_to_target: median(offered.map((e) => e.op.hours_to)),
    avg_max_excursion_atr: mean(evaluable.map((e) => maxExcursionAtr(e.row, horizonKey))),
    thresholds: { target_k_atr: targetK, adverse_k_atr: adverseK, horizon_h: horizonH },
  };
}

/**
 * Win-rate PATH-AWARE de las acciones direccionales, con IC de Wilson y de-dup por
 * episodio. El `by_episode` es la cifra honesta cuando hay varios análisis de la misma
 * vela: contarlos por separado estrecha el IC por debajo de la incertidumbre real.
 */
export function summarizePathWinRate(rows, opts = {}) {
  const minSample = opts.minSample ?? MIN_DIRECTIONAL_SAMPLE;
  const classify = (r) => classifyPathOutcome(r.action, r, opts);

  const tally = (list) => {
    const res = list.map(classify).filter((x) => x != null);
    const wins = res.filter((x) => x === 'win').length;
    const losses = res.filter((x) => x === 'loss').length;
    const ci = wilsonInterval(wins, wins + losses);
    const insufficient = wins + losses < minSample;
    return {
      n: res.length,
      win: wins,
      loss: losses,
      flat: res.filter((x) => x === 'flat').length,
      directional_n: wins + losses,
      sample_insufficient: insufficient,
      win_rate: insufficient ? null : ci.point,
      win_rate_ci_low: insufficient ? null : ci.low,
      win_rate_ci_high: insufficient ? null : ci.high,
    };
  };

  const directional = (rows ?? []).filter((r) => r.action === 'Comprar' || r.action === 'Vender');
  return {
    ...tally(directional),
    by_episode: tally(dedupeByEpisode(directional)),
    min_directional_sample: minSample,
  };
}

/**
 * Calibración de la convicción: ¿significa algo un 0.3 frente a un 0.7?
 *
 * Para las abstenciones se mira si el mercado ofrecía movimiento (una convicción baja en
 * `Esperar` debería coincidir con mercados que sí se movían); para las direccionales, el
 * win-rate path-aware. Con muestra pequeña esto es descriptivo, no concluyente — por eso
 * se reporta el n crudo de cada bucket y no se le pone un IC.
 */
export function summarizeConviction(rows, opts = {}) {
  const buckets = new Map();
  for (const r of rows ?? []) {
    const b = convictionBucket(r.conviction);
    if (b == null) continue;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  const order = ['baja', 'media', 'alta'];
  return order.filter((b) => buckets.has(b)).map((bucket) => {
    const list = buckets.get(bucket);
    const waits = list.filter((r) => r.action === 'Esperar' || r.action === 'Preparar');
    const opp = summarizeOpportunity(waits, opts);
    const path = summarizePathWinRate(list, opts);
    return {
      bucket,
      n: list.length,
      avg_conviction: mean(list.map((r) => r.conviction)),
      waits_n: waits.length,
      waits_offered_pct: opp.offered_pct,
      directional_n: path.directional_n,
      win_rate: path.win_rate,
    };
  });
}
