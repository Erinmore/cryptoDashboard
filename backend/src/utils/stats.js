/**
 * stats.js — utilidades estadísticas puras para el backtesting.
 *
 * Motivación (auditoría C5): el win-rate se reportaba como un % crudo sobre una muestra
 * diminuta y auto-seleccionada (el sistema fuerza Esperar casi siempre → poquísimos
 * direccionales), sin tamaño mínimo ni intervalo de confianza → conclusiones falsas.
 * Aquí el intervalo de Wilson da la incertidumbre real de una proporción con n pequeño.
 */

import { TF_DURATION_HOURS } from '../config/constants.js';

const Z_95 = 1.959963984540054; // z para IC del 95%
// Ventana de recorrido de 7 días — hasta dónde ha podido mirar el job de outcome. Antes se
// importaba `SHADOW_MAX_WINDOW_MS` de shadowTrade.js (retirado con el pivot,
// §REORIENTACIÓN); es la misma cifra que `PATH_WINDOW_MS` en outcomeService.js, cada módulo
// con su propia constante en vez de depender de un archivo que ya no existe.
const PATH_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * Muestra mínima para reportar un win-rate como no-ruido (auditoría C5). Por debajo, el
 * IC de Wilson es tan ancho que la cifra puntual no informa → se marca insuficiente.
 * Vive aquí (y no en dbService) para que el gate sea el MISMO en el win-rate clásico y en
 * el path-aware: dos umbrales distintos para la misma pregunta invitan a citar el que
 * salga favorable.
 */
export const MIN_DIRECTIONAL_SAMPLE = 20;

/**
 * Definición operativa de "movimiento operable": cuánto recorrido favorable (`targetK`) hay
 * que ver antes de cuánto adverso (`adverseK`), en múltiplos de ATR. Viaja en la respuesta
 * (`thresholds`) para que la cifra nunca se lea sin la regla que la produjo.
 *
 * El objetivo se escala CON EL HORIZONTE. Un múltiplo fijo se vuelve trivial según crece la
 * ventana: medido el 2026-07-27, 2×/1× a 7 días se toca limpio el 67-69 % de las veces y la
 * esquina superior de la rejilla satura al 100 % en las tres monedas — a esa escala casi
 * cualquier objetivo acaba alcanzándose, así que la métrica dejaba de discriminar.
 *
 * Razón de fondo, no ajuste de curva: el recorrido de un precio escala aproximadamente con
 * la raíz del tiempo. De 24h a 7d hay 7× de tiempo (√7 ≈ 2,6) y el objetivo pasa de 2× a
 * 4× (2×) — el mismo orden. Con 4×/1× la tasa base a 7d (≈36 %) cae donde la de 24h con
 * 2×/1× (34,8 %), así que los dos horizontes pasan a ser comparables entre sí.
 */
export const OPPORTUNITY_BY_HORIZON = {
  '24h': { targetK: 2, adverseK: 1 },
  '7d':  { targetK: 4, adverseK: 1 },
};

/** Par calibrado para un horizonte (en horas; null = ventana completa de 7d). */
export function opportunityParamsFor(horizonH) {
  return OPPORTUNITY_BY_HORIZON[horizonH === 24 ? '24h' : '7d'];
}

/**
 * TASA BASE INCONDICIONAL de la métrica de oportunidad, en % — con qué frecuencia un
 * instante CUALQUIERA del mercado ofrece un movimiento limpio con el par calibrado de ese
 * horizonte. Medida con `scripts/auditOpportunityThresholds.mjs` el 2026-07-27 sobre 90
 * días de velas 4h (n≈578 anclas por moneda): a 24h con 2×/1× → SOL 35,1 · BTC 34,4 ·
 * ETH 34,9; a 7d con 4×/1× → SOL 35,2 · BTC 30,8 · ETH 41,9. Se usa la media de las tres.
 *
 * PARA QUÉ: sin esta referencia, `offered_pct` es un número flotando. Si los `Esperar` de
 * CRYPTEX ofrecen oportunidad al mismo ritmo que un instante al azar, la abstención NO
 * aporta información por bueno que parezca el porcentaje absoluto. Lo que refuta o
 * confirma es el `lift` — la diferencia.
 *
 * NO es un umbral ajustado a los outcomes del sistema: se midió sobre historia de mercado
 * y ANTES de ver ninguna decisión, justo para no reintroducir la circularidad de
 * validación de la 1ª auditoría red-team. Caduca: la tasa base deriva con el régimen, así
 * que se vuelve a medir en cada revisión (la fecha va en `measured_at`).
 */
export const OPPORTUNITY_BASE_RATE = {
  // Cada tasa corresponde al par calibrado de SU horizonte (OPPORTUNITY_BY_HORIZON):
  // 24h con 2×/1× y 7d con 4×/1×. Ambas caen en la misma banda (~35 %), que es lo que
  // hace comparables los dos horizontes.
  '24h': { pct: 34.8, discriminates: true },
  '7d': { pct: 36.0, discriminates: true },
  measured_at: '2026-07-27',
  source: 'scripts/auditOpportunityThresholds.mjs · 90d · SOL/BTC/ETH · TF 4h',
};

/** Duración de una vela por TF, en horas. Para convertir la vigencia al TF del ATR. */

/**
 * Distancia normalizada del gatillo: cuántas "unidades de recorrido esperado" hay entre el
 * precio del análisis y la entrada condicional.
 *
 * La vigencia se declara en velas de `tf_execution`, que puede no ser el TF primario; el ATR
 * es del primario. Se convierte por duración para que √n y el ATR hablen del mismo TF — si no,
 * un condicional ejecutado en 1h con ATR de 4h daría una distancia inflada por 2.
 *
 * @returns {number|null} null si falta cualquier pieza (no se inventa).
 */
export function normalizedTriggerDistance({ entryPrice, priceAtAnalysis, atrPct, validityCandles, tfExecution, primaryTf }) {
  if (![entryPrice, priceAtAnalysis, atrPct, validityCandles].every(Number.isFinite)) return null;
  if (!(priceAtAnalysis > 0) || !(atrPct > 0) || !(validityCandles > 0)) return null;
  const execH = TF_DURATION_HOURS[tfExecution] ?? TF_DURATION_HOURS[primaryTf] ?? null;
  const primH = TF_DURATION_HOURS[primaryTf] ?? execH;
  if (!execH || !primH) return null;
  const candlesInPrimary = (validityCandles * execH) / primH;
  if (!(candlesInPrimary > 0)) return null;
  const distPct = Math.abs(entryPrice - priceAtAnalysis) / priceAtAnalysis * 100;
  return distPct / (atrPct * Math.sqrt(candlesInPrimary));
}

/**
 * Distancia normalizada del OBJETIVO: cuántas unidades de recorrido esperado hay entre la
 * entrada condicional y su TP1. Mismo eje y misma conversión de TF que el gatillo — un solo
 * dueño de "cuánto recorrido cabe en N velas".
 *
 * @returns {number|null} null si falta cualquier pieza (no se inventa).
 */
export function normalizedTargetDistance({ tp1Price, entryPrice, atrPct, validityCandles, tfExecution, primaryTf }) {
  return normalizedTriggerDistance({
    entryPrice: tp1Price, priceAtAnalysis: entryPrice, atrPct, validityCandles, tfExecution, primaryTf,
  });
}

/**
 * ALCANZABILIDAD DEL OBJETIVO: con qué frecuencia el precio recorre una distancia
 * normalizada `d` dentro de la vigencia declarada. Medida con `scripts/auditTargetReachability.mjs`
 * (2026-08-01) sobre 3 monedas × anclajes de 4h × 4 vigencias (6/12/24/42 velas), con
 * `computeFirstPassage` REAL y las dos direcciones agregadas para cancelar la deriva.
 *
 * PARA QUÉ. Un `conditional_setup` que nombra un objetivo que el mercado no recorre en las
 * velas que el propio análisis declara no es una geometría MALA —eso ya se midió y la
 * expectativa es plana en R:R— sino una declaración INERTE: el resultado no vendrá del
 * objetivo, vendrá de la caducidad. Es el mismo tipo de defecto que `conditional_trigger_vague`.
 *
 * POR QUÉ ESTE EJE. `d = distancia% / (ATR% × √velas)` hace que el ATR se cancele cuando la
 * distancia se expresa en múltiplos de ATR: `d = k/√V`. **La hipótesis se comprobó y aguanta**:
 * celdas con la misma `d` pero `k` y `V` distintas coinciden dentro de **0,3-2,6 pt**
 * (74,2 vs 73,7 · 50,6 vs 53,2 · 32,8 vs 35,3 · 22,2 vs 21,2 · 13,9 vs 13,6 · 8,8 vs 8,2),
 * el mismo grado de colapso que dio `TRIGGER_BASE_RATE`. Es una curva de UNA variable.
 *
 * ⚠️ EL NIVEL DEL CORTE NO SE PUDO HEREDAR. Se intentó anclarlo a `OPPORTUNITY_BY_HORIZON`,
 * que ya está calibrado: si sus dos puntos (2×ATR en 6 velas · 4×ATR en 42) dieran la MISMA
 * alcanzabilidad, ese valor sería el corte sin inventar nada. **Dan 22,2 % [20,8-23,7] y
 * 32,0 % [30,4-33,7]** — no se rozan, así que no hay anclaje. La razón, a posteriori: aquel
 * par se calibró sobre la oportunidad LIMPIA (con la condición adversa), que no es esta
 * magnitud. Se deja escrito para que nadie repita el intento creyéndolo pendiente.
 *
 * LO QUE SÍ SOSTIENE EL NIVEL: **cualquier corte entre el 3 % y el 10 % produce la misma
 * partición exacta** de las geometrías reales observadas. El nivel no está sobre una
 * pendiente donde un pelo cambia la respuesta — que es justo el fallo T2 (ADX=25 cayendo
 * sobre la mediana). Se toma el 5 %, centro de esa banda y coherente con el listón de rama
 * muerta que este proyecto ya ha aplicado cinco veces (F&G 1,0 % · DVOL 0,3 % · funding de
 * cola 0 % · `high_volatility` 0,0 %). Y NO es rama muerta él mismo: marca 2 de los 7
 * condicionales reales.
 */
export const TARGET_REACHABILITY = {
  // d = distancia normalizada · valor = % de veces que el precio la recorre en la vigencia.
  points: {
    0.1: 88.1, 0.2: 74.6, 0.4: 51.3, 0.6: 34.0, 0.8: 21.1,
    1.0: 12.9, 1.2: 9.2, 1.5: 5.8, 2.0: 1.7, 2.5: 0.5,
  },
  measured_at: '2026-08-01',
  source: 'scripts/auditTargetReachability.mjs · SOL/BTC/ETH · anclajes 4h · vigencias 6/12/24/42 velas · n≈3000/celda · ATR de 180 velas',
  // ⚠️ Medida con el ATR de 180 velas — el de DECISIÓN (`technical[tf].atr`), que es el que
  // usa el consumidor. La regla del proyecto es que tabla y consumidor usen el mismo ATR
  // (el de Wilder es recursivo: 19 y 180 velas dan números distintos). Comprobado que aquí
  // da igual —la versión con 19 velas difiere ≤1,6 pt, porque `d` normaliza por el MISMO
  // ATR con el que se mide la distancia y la elección se cancela—, pero se alinean de todos
  // modos: comprobar que un riesgo no se materializa no es razón para dejarlo abierto.
};

/** Por debajo de esta alcanzabilidad, el objetivo declarado se considera inerte. */
export const TARGET_UNREACHABLE_PCT = 5;

/**
 * % de veces que el precio recorre una distancia normalizada `d` dentro de su vigencia.
 * Interpola entre los puntos medidos y se ancla a los extremos: extrapolar es inventar.
 * @returns {number|null} % o null si `d` no es utilizable.
 */
export function targetReachabilityFor(d) {
  if (!Number.isFinite(d) || d < 0) return null;
  const xs = Object.keys(TARGET_REACHABILITY.points).map(Number).sort((a, b) => a - b);
  const at = (x) => TARGET_REACHABILITY.points[x];
  if (d <= xs[0]) return at(xs[0]);
  if (d >= xs.at(-1)) return at(xs.at(-1));
  for (let i = 1; i < xs.length; i++) {
    if (d <= xs[i]) {
      const [x0, x1] = [xs[i - 1], xs[i]];
      const w = (d - x0) / (x1 - x0);
      return parseFloat((at(x0) + w * (at(x1) - at(x0))).toFixed(1));
    }
  }
  return null;
}

/** Parsea `path_first_passage` venga como JSON de SQLite o como objeto ya hidratado. */
export function parseFirstPassage(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

/**
 * ¿Ha vencido ya el horizonte de esta fila? Un solo dueño para la censura, porque la
 * comparten `classifyOpportunity` y `classifyPathOutcome`: si divergieran, el coste de
 * oportunidad y el win-rate estarían midiendo sobre muestras distintas sin decirlo.
 *
 * `now === null` = historia cerrada (scripts de auditoría, que llevan su propio gate de
 * cobertura sobre las klines) → sin censura. `now` numérico y fila sin fecha utilizable →
 * NO madura: un dato ausente no certifica un negativo.
 */
function horizonMatured(row, horizonH, now) {
  if (now == null) return true;
  const horizonMs = horizonH != null ? horizonH * 3600 * 1000 : PATH_WINDOW_MS;
  const tMs = Date.parse(row?.timestamp ?? '');
  return Number.isFinite(tMs) && now >= tMs + horizonMs;
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
 * ⚠️ CENSURA — un "no ofreció" no vale hasta que el horizonte VENCE. La asimetría es lo
 * que hace falta ver: un `offered` es TERMINAL en cuanto se observa el cruce limpio (más
 * mercado no lo deshace), pero un `offered:false` solo significa "todavía no", y contarlo
 * como negativo definitivo mete en el denominador filas que aún no han tenido tiempo de
 * moverse. Medido el 2026-08-01 sobre la muestra en curso: el bloque de 7d reportaba
 * `offered_pct 0,0` y `lift −36` con las 7 filas por debajo de 66 h de vida — o sea CERO
 * observaciones maduras presentadas como una abstención brillante. Es la misma censura que
 * ya se corrigió en `trigger_rate_pct` (`summarizeShadowTrades`), y la regla es la misma
 * para todos los denominadores: se entra en la estadística cuando la ventana ha vencido,
 * no cuando hay un resultado que enseñar.
 *
 * `blocked_by_adverse` SÍ es terminal aunque la ventana siga abierta: cruzar `targetK` en
 * un sentido implica haber cruzado antes `adverseK` en ese mismo sentido (paso monótono,
 * y targetK > adverseK), así que a partir de ahí cualquier objetivo futuro —en cualquiera
 * de los dos sentidos— llega con su adverso ya cruzado por delante. No hay recorrido que
 * pueda rescatarlo.
 *
 * `opts.now = null` DESACTIVA la censura: es el modo de los scripts de auditoría, que
 * reproducen historia ya cerrada y llevan su propio gate de cobertura sobre las klines
 * (`if (lastHourly < tMs + hH*HOUR_MS) continue`). Ahí una fila sin `timestamp` no es un
 * dato ausente, es que la fecha no aplica. Tiene que decirse EXPLÍCITAMENTE: con el
 * default (`Date.now()`) una fila sin fecha se queda `pending`, que es lo correcto para
 * producción y sería una corrupción silenciosa en un backtest.
 *
 * @param {object} row - fila de outcome (acepta `path_first_passage` crudo o parseado).
 *   `timestamp` es necesario para fechar el vencimiento del horizonte.
 * @param {{horizonH?:number, targetK?:number, adverseK?:number, now?:number|null}} [opts]
 * @returns {{offered:boolean, direction:'up'|'down'|null, hours_to:number|null,
 *            blocked_by_adverse:boolean, evaluable:boolean, pending:boolean}}
 */
export function classifyOpportunity(row, opts = {}) {
  const horizonH = opts.horizonH ?? null;
  const cal = opportunityParamsFor(horizonH);
  const { targetK = cal.targetK, adverseK = cal.adverseK } = opts;
  // `now: null` explícito = historia cerrada, sin censura que aplicar (ver cabecera).
  const now = 'now' in opts ? opts.now : Date.now();
  const fp = parseFirstPassage(row?.path_first_passage);
  const none = {
    offered: false, direction: null, hours_to: null, blocked_by_adverse: false, pending: false,
  };
  // Sin rejilla no hay ATR con el que normalizar → no evaluable. Distinto de "no ofreció":
  // confundirlos contaría como acierto de abstención lo que en realidad es un dato ausente.
  if (!fp?.up || !fp?.down) return { ...none, evaluable: false };

  // Vencimiento del horizonte. El bloque de 7d se pide con `horizonH = null` (sin tope en
  // `crossedAt`), y su ventana real es la de datos del job de outcome — mismo dueño que
  // usa el evaluador de shadow trades, para no escribir un segundo "7 días" aquí.
  const matured = horizonMatured(row, horizonH, now);

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
  // Ningún objetivo alcanzado: es el ÚNICO desenlace que el tiempo puede cambiar.
  if (!cand.length) {
    return matured ? { ...none, evaluable: true } : { ...none, evaluable: false, pending: true };
  }

  const clean = cand.filter((c) => !c.blocked).sort((a, b) => a.tTarget - b.tTarget);
  if (clean.length) {
    return {
      offered: true, direction: clean[0].dir, hours_to: clean[0].tTarget,
      blocked_by_adverse: false, evaluable: true, pending: false,
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
  // Por defecto, el par CALIBRADO para este horizonte (no el mismo para los dos).
  const cal = opportunityParamsFor(horizonH);
  const targetK = opts.targetK ?? cal.targetK;
  const adverseK = opts.adverseK ?? cal.adverseK;

  const now = opts.now ?? Date.now();

  const evals = (rows ?? []).map((r) => ({
    row: r,
    op: classifyOpportunity(r, { horizonH, targetK, adverseK, now }),
  }));
  const evaluable = evals.filter((e) => e.op.evaluable);
  const offered = evaluable.filter((e) => e.op.offered);
  // Ventana aún abierta y sin cruce observado: fuera del denominador hasta que venza (ver
  // la nota de CENSURA en `classifyOpportunity`). Se reporta para que la diferencia con `n`
  // sea visible y nadie lea un `offered_pct` bajo donde solo hay muestra joven.
  const pending = evals.filter((e) => e.op.pending).length;

  const offeredPct = evaluable.length
    ? parseFloat(((offered.length / evaluable.length) * 100).toFixed(1)) : null;
  // IC de Wilson (2026-08-09): `offered_pct`/`lift_pct` se leían como si el punto fuera
  // sólido, pero era el único par de la familia (junto a `trigger_rate_pct`) sin intervalo —
  // `win_rate`/`expectancy_r` sí lo llevan. Verificado con los 56 primeros análisis: en las
  // 4 celdas medidas (24h/7d × global/por dirección) la base cae DENTRO del IC en las 4 — el
  // "lift" negativo no es distinguible de ruido a este tamaño de muestra, y sin el IC a la
  // vista es fácil leerlo como "el sistema va peor que el azar" en vez de "no se sabe todavía".
  const offeredCi = wilsonInterval(offered.length, evaluable.length);

  // Comparación contra la tasa base: es lo que convierte el % en evidencia. Solo aplica
  // con el par calibrado del horizonte — con otros múltiplos la referencia medida no vale.
  const isDefault = targetK === cal.targetK && adverseK === cal.adverseK;
  const base = isDefault ? OPPORTUNITY_BASE_RATE[horizonKey] : null;

  return {
    n: evals.length,
    // Sin ATR no hay escala de volatilidad: esas filas no cuentan ni a favor ni en contra.
    evaluable_n: evaluable.length,
    // Filas cuyo horizonte todavía no ha vencido (y que aún no han cruzado): no son un
    // "no ofreció", son un "todavía no". `n - evaluable_n - pending_n` = sin rejilla.
    pending_n: pending,
    offered_n: offered.length,
    offered_pct: offeredPct,
    offered_pct_ci_low: evaluable.length ? offeredCi.low : null,
    offered_pct_ci_high: evaluable.length ? offeredCi.high : null,
    // lift < 0 → el sistema esperó en momentos que ofrecían MENOS que el azar (criterio).
    // lift ≈ 0 → esperó como quien no mira (la abstención no informa).
    // lift > 0 → esperó justo cuando había algo que operar (coste de oportunidad real).
    // ⚠️ Leer SIEMPRE junto a `offered_pct_ci_*`: un lift negativo con la base DENTRO del IC
    // no es "peor que el azar", es "esta muestra no tiene poder para decir nada todavía".
    base_rate_pct: base?.pct ?? null,
    lift_pct: base && offeredPct != null
      ? parseFloat((offeredPct - base.pct).toFixed(1)) : null,
    lift_significant: base && evaluable.length
      ? (base.pct < offeredCi.low || base.pct > offeredCi.high) : null,
    base_rate_discriminates: base?.discriminates ?? null,
    base_rate_measured_at: base ? OPPORTUNITY_BASE_RATE.measured_at : null,
    // Contexto de la referencia: se midió sobre velas 4h de SOL/BTC/ETH. Comparar contra
    // ella un análisis de otro TF sería comparar con la base equivocada, así que la
    // procedencia viaja con la cifra en vez de quedarse en un comentario del código.
    base_rate_scope: base ? OPPORTUNITY_BASE_RATE.source : null,
    blocked_by_adverse_n: evaluable.filter((e) => e.op.blocked_by_adverse).length,
    median_hours_to_target: median(offered.map((e) => e.op.hours_to)),
    avg_max_excursion_atr: mean(evaluable.map((e) => maxExcursionAtr(e.row, horizonKey))),
    thresholds: { target_k_atr: targetK, adverse_k_atr: adverseK, horizon_h: horizonH },
  };
}

