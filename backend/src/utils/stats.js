/**
 * stats.js — utilidades estadísticas puras para el backtesting.
 *
 * Motivación (auditoría C5): el win-rate se reportaba como un % crudo sobre una muestra
 * diminuta y auto-seleccionada (el sistema fuerza Esperar casi siempre → poquísimos
 * direccionales), sin tamaño mínimo ni intervalo de confianza → conclusiones falsas.
 * Aquí el intervalo de Wilson da la incertidumbre real de una proporción con n pequeño.
 */

import { dedupeByEpisode } from './episodes.js';
import { TF_DURATION_HOURS } from '../config/constants.js';
import {
  SHADOW_FILL_RULE, SHADOW_MAX_WINDOW_MS, parseConditionalSetup, geometryDirection,
} from './shadowTrade.js';
import { setupExpiryMs } from './outcome.js';

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

/**
 * t de Student de dos colas al 95 %. Con n pequeño el z=1,96 se queda corto: a n=8 el t es
 * 2,365, un 21 % más ancho — y n=8 es exactamente el tamaño que tendrá la muestra en el
 * primer checkpoint, así que usar z ahí estrecharía el intervalo justo donde más engaña.
 */
const T_95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
const tCrit = (df) => (df < 1 ? null : df <= T_95.length ? T_95[df - 1] : Z_95);

/**
 * EXPECTATIVA en múltiplos de R, con su intervalo. Cada trade resuelto vale `+R` si tocó el
 * TP y `-1` si tocó el stop, así que la media responde a la única pregunta que importa:
 * ¿estas geometrías ganan dinero?
 *
 * SE DEVUELVE COMO OBJETO A PROPÓSITO. Un `expectancy_r: 0.06` suelto se cita como si fuera
 * una conclusión; `{point: 0.06, ci_low: -0.84, ci_high: 0.96, inconclusive: true}` no se
 * puede citar sin su incertidumbre. Es la misma disciplina que hace viajar `fill_rule` con
 * `trigger_rate` y `base_rate_pct` con `offered_pct`: la cifra no se lee sin su regla.
 *
 * POR QUÉ SIN GATE DE MUESTRA (a diferencia del win-rate). `MIN_DIRECTIONAL_SAMPLE=20` está
 * calibrado para una PROPORCIÓN; para la media de un múltiplo de R con cola es demasiado
 * pequeño: a n=20 el IC sigue siendo ±0,57R, más ancho que cualquier ventaja realista. Un
 * gate ahí no protege — esconde la cifra mientras es obviamente inútil y la muestra justo
 * cuando sigue siéndolo pero ya no lo parece. Medido con los R:R reales (mediana 1,65), el n
 * necesario para que el intervalo no cruce cero es ~64 con ventaja fuerte (+0,32R) y ~181 con
 * ventaja moderada (+0,19R): es una pregunta de meses, no de checkpoint. `inconclusive` lo
 * dice en cada respuesta para que la cifra no se lea como veredicto.
 *
 * @param {number[]} rMultiples - +R por cada TP, -1 por cada stop.
 */
export function expectancyR(rMultiples) {
  const xs = (rMultiples ?? []).filter(Number.isFinite);
  const n = xs.length;
  if (!n) return { point: null, ci_low: null, ci_high: null, n: 0, inconclusive: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const round3 = (x) => parseFloat(x.toFixed(3));
  if (n < 2) {
    // Un solo trade no tiene dispersión que estimar: punto sin intervalo, e `inconclusive`
    // en true, que es la lectura correcta con n=1.
    return { point: round3(mean), ci_low: null, ci_high: null, n, inconclusive: true };
  }
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const margin = tCrit(n - 1) * Math.sqrt(variance / n);
  const low = mean - margin, high = mean + margin;
  return {
    point: round3(mean), ci_low: round3(low), ci_high: round3(high), n,
    // El intervalo cruza cero ⇒ no se puede afirmar ni que gana ni que pierde.
    inconclusive: low <= 0 && high >= 0,
  };
}

/**
 * TASA BASE DEL GATILLO de un shadow trade — la referencia que le faltaba a
 * `trigger_rate_pct`. Sin ella es un número suelto: si el precio alcanza esa distancia en esa
 * dirección y en esa ventana tan a menudo como en un instante CUALQUIERA, que el gatillo se
 * dé no dice nada sobre el criterio del sistema. Lo que refuta o confirma es el LIFT.
 *
 * EL EJE ES UNA SOLA VARIABLE, y eso es un hallazgo medido, no una suposición:
 *
 *     d = |entry_price − price_current| / (atr_pct × √velas_de_vigencia)
 *
 * Se creía que la tasa base había que calcularla "por condicional" porque depende de la
 * geometría (distancia × vigencia). Medido con `scripts/auditTriggerBaseRate.mjs`: al
 * normalizar por `ATR%×√n` la tasa COLAPSA — 24h y 48h coinciden dentro de 0,4-6,4 pt y las
 * TRES monedas dentro de 0,7-3,4 pt. Es propiedad del recorrido cripto normalizado por ATR,
 * no del activo ni de la ventana: la misma conclusión a la que llegó `OPPORTUNITY_BASE_RATE`.
 * Por eso cabe en una curva enviada como constante, sin script por análisis.
 *
 * ⚠️ `atr_pct` es el de `analysis_outcome.atr_pct_at_analysis` — Wilder(14) sobre 19 velas
 * cerradas — NO el `derivatives_score_components.atr_pct` de la ruta de decisión (ventana de
 * 180). Se eligió porque está persistido retroactivamente para TODAS las filas. Para una tasa
 * base da igual cuál sea mientras tabla y consumidor usen el mismo; mezclarlos sí rompe.
 *
 * ⚠️ Mide la GEOMETRÍA ("¿tocó el precio la entrada?"), que es justo lo que cuenta como
 * disparo el evaluador (`SHADOW_FILL_RULE`), no el gatillo textual del análisis.
 *
 * ⚠️ La diferencia long/short es de 0,9-2,3 pt, con signo consistente pero dentro del IC de
 * cada celda (±2,2 pt). Se conserva porque estaba medida y no cuesta nada; NO debe leerse
 * como que operar corto sea más fácil.
 *
 * Caduca con el régimen, como el resto: `measured_at` viaja en la respuesta.
 */
export const TRIGGER_BASE_RATE = {
  /** d → tasa de disparo en %, por dirección de la geometría. */
  points: {
    0.20: { long: 73.7, short: 73.8 },
    0.30: { long: 61.7, short: 61.7 },
    0.40: { long: 50.9, short: 51.8 },
    0.50: { long: 41.6, short: 43.9 },
    0.60: { long: 34.0, short: 36.2 },
    0.75: { long: 25.4, short: 26.9 },
    1.00: { long: 14.9, short: 14.7 },
    1.25: { long: 8.7, short: 8.4 },
  },
  measured_at: '2026-08-01',
  source: 'scripts/auditTriggerBaseRate.mjs · 90d · SOL/BTC/ETH · TF 4h · n≈1946/celda · fill=touch_entry_intrabar',
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

/**
 * Tasa base para una distancia normalizada, interpolando linealmente entre los puntos
 * medidos. Fuera de rejilla se ancla al extremo: extrapolar una curva medida es inventar.
 * @returns {number|null} % o null si `d` no es utilizable.
 */
export function triggerBaseRateFor(d, direction = 'long') {
  if (!Number.isFinite(d) || d < 0) return null;
  const dir = direction === 'short' ? 'short' : 'long';
  const xs = Object.keys(TRIGGER_BASE_RATE.points).map(Number).sort((a, b) => a - b);
  const at = (x) => TRIGGER_BASE_RATE.points[x][dir];
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
  const horizonMs = horizonH != null ? horizonH * 3600 * 1000 : SHADOW_MAX_WINDOW_MS;
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
 * Win-rate PATH-AWARE para una acción direccional: ¿llegó el objetivo antes que el stop?
 *
 * El `outcome_24h` actual mira solo el precio AL horizonte, así que un trade que tocó el
 * stop y luego recuperó cuenta como win — cuando en la práctica se habría cerrado en
 * pérdida. Esto mira el camino, no el destino.
 *
 * ⚠️ CENSURA — misma asimetría que en `classifyOpportunity`, y aquí SESGA EL SIGNO. `win`
 * y `loss` son terminales en cuanto se tocan (el trade se habría cerrado ahí), pero `flat`
 * solo significa "aún no", y `flat` está FUERA del denominador (`directional_n = win +
 * loss`). Como el stop está a `adverseK` y el objetivo a `targetK` con `targetK > adverseK`,
 * **la pérdida aflora antes que la ganancia**: sobre una muestra en curso las que ya han
 * entrado al denominador están enriquecidas en `loss` y el win-rate sale sesgado A LA BAJA.
 * Es el mismo mecanismo que obligó a corregir `trigger_rate_pct` y el coste de oportunidad.
 * Por eso un `flat` con la ventana abierta devuelve `'pending'` y no entra en nada.
 *
 * @returns {'win'|'loss'|'flat'|'pending'|null} null si no es direccional o no hay rejilla.
 */
export function classifyPathOutcome(action, row, opts = {}) {
  const dir = action === 'Comprar' ? 'up' : action === 'Vender' ? 'down' : null;
  if (!dir) return null;
  const horizonH = opts.horizonH ?? null;
  const cal = opportunityParamsFor(horizonH);
  const { targetK = cal.targetK, adverseK = cal.adverseK } = opts;
  const now = 'now' in opts ? opts.now : Date.now();
  const fp = parseFirstPassage(row?.path_first_passage);
  if (!fp?.up || !fp?.down) return null;

  const opp = dir === 'up' ? 'down' : 'up';
  const tTarget = crossedAt(fp[dir], targetK, horizonH);
  const tStop = crossedAt(fp[opp], adverseK, horizonH);
  // El único desenlace que el tiempo aún puede cambiar. Los otros tres ya cerraron.
  if (tTarget == null && tStop == null) {
    return horizonMatured(row, horizonH, now) ? 'flat' : 'pending';
  }
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
    // lift < 0 → el sistema esperó en momentos que ofrecían MENOS que el azar (criterio).
    // lift ≈ 0 → esperó como quien no mira (la abstención no informa).
    // lift > 0 → esperó justo cuando había algo que operar (coste de oportunidad real).
    base_rate_pct: base?.pct ?? null,
    lift_pct: base && offeredPct != null
      ? parseFloat((offeredPct - base.pct).toFixed(1)) : null,
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
      // `n` cuenta lo ya cerrado; las de ventana abierta van aparte para que la resta sea
      // visible y no parezca muestra perdida (mismo trato que en el coste de oportunidad).
      n: res.filter((x) => x !== 'pending').length,
      win: wins,
      loss: losses,
      flat: res.filter((x) => x === 'flat').length,
      pending_n: res.filter((x) => x === 'pending').length,
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
 * SHADOW TRADES — agregación del `conditional_setup` evaluado (ver utils/shadowTrade.js).
 *
 * Responde dos preguntas que el win-rate direccional no puede responder mientras el
 * sistema apenas emita direccionales:
 *
 *  1. **¿Las condiciones que el sistema nombra llegan a darse?** (`trigger_rate_pct`).
 *     Un sistema que se abstiene declarando gatillos que nunca aparecen está describiendo
 *     un mercado que no existe; uno cuyos gatillos aparecen a menudo está esperando de
 *     verdad a algo concreto.
 *  2. **Cuando se dan, ¿el trade declarado funcionaba?** (`win_rate`, tp1 vs stop).
 *
 * DENOMINADORES, que es donde se cuelan las cifras favorables:
 *  - `trigger_rate_pct` cuenta solo lo CONCLUYENTE: `tp1`/`stop`/`expired` (disparó) frente
 *    a `not_triggered` (no disparó). Quedan fuera `open` (aún vivo), `truncated` (se
 *    acabaron los datos antes que la vigencia) e `invalid` (geometría inevaluable) — si
 *    entraran en el denominador, un lote de condicionales mal formados subiría o bajaría la
 *    tasa sin que el mercado hubiera hecho nada.
 *  - `win_rate` solo sobre `tp1 + stop`, con el MISMO gate de muestra mínima que el resto
 *    (`MIN_DIRECTIONAL_SAMPLE`): dos umbrales distintos para la misma pregunta invitan a
 *    citar el que salga bien.
 *  - `expired` (llenado pero sin resolver dentro de su vigencia) no es win ni loss.
 *
 * `fill_rule` viaja en la respuesta porque la lectura es MÁS PERMISIVA que el gatillo
 * declarado (toca la entrada intravela vs. el cierre de vela que el texto exige): la cifra
 * no significa lo mismo sin esa nota. Ver la cabecera de `utils/shadowTrade.js`.
 *
 * ⚠️ LO QUE FALTA — `trigger_rate_pct` NO tiene todavía su tasa base, y sin ella es la
 * misma clase de número suelto que era `offered_pct` antes de `OPPORTUNITY_BASE_RATE`: si
 * el precio alcanza esa distancia en esa dirección y en esa ventana tan a menudo como por
 * azar, que el gatillo se dé no dice nada sobre el criterio del sistema. La tasa base
 * depende de cada geometría (distancia a la entrada / ATR × vigencia), así que se mide por
 * condicional, no con una constante — medida a mano el 2026-08-01 para 3 gatillos: 49/62/54 %
 * (34/60/40 % en el cuartil de menor volatilidad). Cablearla exige un script propio; hasta
 * entonces la cifra se lee como descriptiva, no como evidencia.
 */
export function summarizeShadowTrades(rows, opts = {}) {
  const minSample = opts.minSample ?? MIN_DIRECTIONAL_SAMPLE;
  const now = opts.now ?? Date.now();
  const evaluated = (rows ?? []).filter((r) => r?.cond_outcome != null);

  // ⚠️ CENSURA — por qué solo cuentan los condicionales cuya VENTANA YA VENCIÓ.
  // Un condicional que dispara puede resolverse en la primera hora; uno que no dispara no
  // es terminal hasta que se agota su vigencia entera. En una muestra en curso, el conjunto
  // de terminales está por tanto enriquecido con los que dispararon: `trigger_rate` saldría
  // sesgado AL ALZA sin que el mercado haya hecho nada. Lo mismo, con el signo contrario, en
  // el win-rate: el stop suele estar más cerca que el TP, así que los `stop` afloran antes.
  // La regla es una sola y se aplica a todos los denominadores: un shadow trade entra en las
  // estadísticas cuando su ventana de evaluación ha vencido, no cuando tiene resultado.
  const settledAt = (r) => {
    const cs = parseConditionalSetup(r.conditional_setup);
    const tMs = new Date(r.timestamp).getTime();
    if (!Number.isFinite(tMs)) return null;
    // Mismo helper que usa el evaluador (un solo dueño de "cuándo caduca un setup"),
    // acotado por la ventana de datos igual que allí.
    const expiry = cs ? setupExpiryMs({
      tMs,
      validityCandles: cs.validity_candles,
      tfExecution:     cs.tf_execution,
      primaryTf:       r.primary_tf,
    }) : null;
    return Math.min(expiry ?? tMs + SHADOW_MAX_WINDOW_MS, tMs + SHADOW_MAX_WINDOW_MS);
  };
  // `invalid` es terminal desde el primer ciclo (defecto permanente de geometría): no tiene
  // ventana que esperar y se cuenta aparte, fuera de todo denominador.
  const isSettled = (r) => {
    if (r.cond_outcome === 'invalid') return true;
    const end = settledAt(r);
    return end != null && now >= end;
  };
  const settled = evaluated.filter(isSettled);
  const pending = evaluated.length - settled.length;

  // ── Geometría por fila: distancia normalizada y R:R ───────────────────────
  const geomOf = (r) => {
    const cs = parseConditionalSetup(r.conditional_setup);
    if (!cs) return null;
    const dir = geometryDirection(cs);
    const risk = Math.abs(cs.stop_price - cs.entry_price);
    const reward = Math.abs((cs.tp1_price ?? NaN) - cs.entry_price);
    return {
      dir,
      rr: risk > 0 && Number.isFinite(reward) ? reward / risk : null,
      d: normalizedTriggerDistance({
        entryPrice: cs.entry_price,
        priceAtAnalysis: Number.isFinite(r.price_current) ? r.price_current : r.price_at_analysis,
        atrPct: r.atr_pct_at_analysis,
        validityCandles: cs.validity_candles,
        tfExecution: cs.tf_execution,
        primaryTf: r.primary_tf,
      }),
    };
  };

  const median = (a) => {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const tally = (list) => {
    const n = (o) => list.filter((r) => r.cond_outcome === o).length;
    const tp1 = n('tp1');
    const stop = n('stop');
    const expired = n('expired');
    const notTriggered = n('not_triggered');
    const conclusive = tp1 + stop + expired + notTriggered;
    const triggered = tp1 + stop + expired;
    const resolved = tp1 + stop;
    const ci = wilsonInterval(tp1, resolved);
    const insufficient = resolved < minSample;

    // ── TASA BASE del gatillo ────────────────────────────────────────────────
    // Se promedia la tasa esperada de CADA geometría sobre las filas que entran en
    // `trigger_rate_pct` (las concluyentes), no una constante global: cada condicional pone
    // su entrada a una distancia distinta y por tanto tiene su propia expectativa. El lift
    // es lo que dice si el sistema elige momentos mejores que el azar A IGUAL GEOMETRÍA.
    const conclusiveRows = list.filter((r) => ['tp1', 'stop', 'expired', 'not_triggered'].includes(r.cond_outcome));
    const baseRates = conclusiveRows
      .map((r) => { const g = geomOf(r); return g ? triggerBaseRateFor(g.d, g.dir) : null; })
      .filter(Number.isFinite);
    const baseRate = baseRates.length ? parseFloat((baseRates.reduce((a, b) => a + b, 0) / baseRates.length).toFixed(1)) : null;
    const triggerRate = conclusive ? parseFloat(((triggered / conclusive) * 100).toFixed(1)) : null;

    // ── EXPECTATIVA ──────────────────────────────────────────────────────────
    // El win-rate solo no es interpretable: con R:R 1,77 el equilibrio está en el 36,2 %, así
    // que un 40 % gana y un 33 % pierde. Y el IC del win-rate ni con n=40 excluye ese punto.
    // La expectativa en unidades de R sí responde a "¿estas geometrías ganan dinero?".
    // `rr_median` describe la GEOMETRÍA (disponible sin resultados); `expectancy_r`, el
    // RESULTADO (necesita muestra, con el mismo gate que el win-rate).
    const rrAll = list.map((r) => geomOf(r)?.rr).filter(Number.isFinite);
    const rrMedian = median(rrAll);
    // ⚠️ DENOMINADOR DE LA EXPECTATIVA — corregido el 2026-08-01 tras un ensayo en seco.
    // La primera versión contaba solo `tp1`+`stop`, y ese subconjunto está enriquecido en
    // stops POR LA GEOMETRÍA, no por el mercado: el stop suele estar más cerca que el
    // objetivo, así que dentro de una vigencia corta lo alcanza mucho más a menudo y lo que
    // no llega a ninguno CADUCA. Medido con 3.726 réplicas de las 7 geometrías reales: 1.170
    // caducados frente a 1.064 resueltos → se tiraba el 52 % de los trades disparados,
    // siempre por el mismo lado, y la expectativa salía sesgada A LA BAJA.
    // Ahora entra TODO lo que llegó a llenarse: el caducado aporta su R real al precio de
    // cierre de su vigencia (normalmente pequeño), que es lo que habría pasado de verdad.
    // El R sale de una sola fórmula, válida para largo y corto:  (salida - entrada) / (entrada - stop)
    //   largo  → entrada-stop > 0; salida>entrada ⇒ R>0
    //   corto  → entrada-stop < 0; salida<entrada ⇒ R>0
    // y reproduce exactamente los casos límite: en `tp1` da +R:R y en `stop` da -1.
    const filledRows = list.filter((r) => ['tp1', 'stop', 'expired'].includes(r.cond_outcome));
    const rMultiples = filledRows.map((r) => {
      const cs = parseConditionalSetup(r.conditional_setup);
      const exit = r.cond_exit_price;
      if (!cs || !Number.isFinite(exit)
        || !Number.isFinite(cs.entry_price) || !Number.isFinite(cs.stop_price)) return null;
      const risk = cs.entry_price - cs.stop_price;
      if (risk === 0) return null;
      return (exit - cs.entry_price) / risk;
    }).filter(Number.isFinite);
    const expectancy = expectancyR(rMultiples);

    return {
      trigger_base_rate_pct: baseRate,
      // lift > 0 ⇒ el sistema nombra gatillos que se dan MÁS que a igual geometría por azar.
      // El resultado por defecto es lift ≈ 0: demostrar es que salga distinto.
      trigger_lift_pct: baseRate != null && triggerRate != null
        ? parseFloat((triggerRate - baseRate).toFixed(1)) : null,
      rr_median: rrMedian != null ? parseFloat(rrMedian.toFixed(2)) : null,
      // Win-rate por encima del cual la geometría gana dinero. Es la referencia que hace
      // legible el win_rate; se calcula de la mediana de R:R, así que es orientativa cuando
      // los R:R son heterogéneos — `expectancy_r` es la respuesta exacta.
      breakeven_win_rate_pct: rrMedian != null && rrMedian > 0
        ? parseFloat((100 / (1 + rrMedian)).toFixed(1)) : null,
      // Objeto, no número: el punto no se puede leer sin su intervalo. Sin gate de muestra
      // —ver `expectancyR`—, porque a n=20 el IC sigue siendo ±0,57R y esconderlo hasta ahí
      // solo cambia el momento en que la cifra empieza a parecer fiable sin serlo.
      expectancy_r: expectancy,
      // OJO al comparar: `win_rate` va sobre tp1+stop (una proporción) y `expectancy_r`
      // sobre TODO lo llenado, caducados incluidos. Denominadores distintos a propósito —
      // son preguntas distintas —, así que `expectancy_r.n` >= `resolved_n`.
      expectancy_includes_expired: true,
      n: list.length,
      tp1, stop, expired, not_triggered: notTriggered,
      open: n('open'),
      truncated: n('truncated'),
      invalid: n('invalid'),
      conclusive_n: conclusive,
      triggered_n: triggered,
      trigger_rate_pct: conclusive
        ? parseFloat(((triggered / conclusive) * 100).toFixed(1)) : null,
      resolved_n: resolved,
      sample_insufficient: insufficient,
      win_rate: insufficient ? null : ci.point,
      win_rate_ci_low: insufficient ? null : ci.low,
      win_rate_ci_high: insufficient ? null : ci.high,
    };
  };

  // Segmentación por dirección: la geometría corta y la larga no tienen por qué
  // comportarse igual en un mismo régimen, y mezclarlas esconde el que falla.
  const dirOf = (r) => geometryDirection(parseConditionalSetup(r.conditional_setup));

  return {
    ...tally(settled),
    // Evaluados en total y cuántos siguen con la ventana abierta. Se reportan aparte para
    // que la diferencia con `n` sea visible y nadie la lea como muestra perdida.
    evaluated_n: evaluated.length,
    pending_n: pending,
    // Análisis de la misma vela del TF primario comparten casi todo el input; contarlos
    // por separado estrecha el IC por debajo de la incertidumbre real.
    by_episode: tally(dedupeByEpisode(settled)),
    by_direction: {
      long:  tally(settled.filter((r) => dirOf(r) === 'long')),
      short: tally(settled.filter((r) => dirOf(r) === 'short')),
    },
    min_directional_sample: minSample,
    trigger_base_rate_measured_at: TRIGGER_BASE_RATE.measured_at,
    trigger_base_rate_source: TRIGGER_BASE_RATE.source,
    fill_rule: SHADOW_FILL_RULE,
    fill_rule_note: 'La entrada se considera llena al TOCARLA intravela; el trigger textual '
      + 'del análisis (p. ej. "cierre 4h por debajo de X") no se parsea. Lectura más '
      + 'permisiva: un not_triggered es robusto, un tp1/stop puede no haber cumplido el '
      + 'gatillo estricto.',
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
  // Horizonte 24h por defecto: la convicción se emite sobre la decisión inmediata, y es
  // además el horizonte que mejor discrimina (el de 7d necesita un objetivo de 4×ATR para
  // no saturar). Sin fijarlo, heredaría la ventana completa y mediría otra cosa.
  const o = { horizonH: 24, ...opts };
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
    const opp = summarizeOpportunity(waits, o);
    const path = summarizePathWinRate(list, o);
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
