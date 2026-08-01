/**
 * shadowTrade.js — Evaluación retroactiva del `conditional_setup` (shadow trade).
 *
 * QUÉ RESUELVE
 * ------------
 * Desde v9_0 cada `Esperar`/`Preparar` declara el trade que SÍ tomaría si apareciera lo
 * que falta (`structured.conditional_setup`: trigger, dirección y geometría completa).
 * Se persistía y no lo evaluaba nadie, así que la salida dominante del sistema seguía sin
 * producir un resultado medible: la fila `Resultado` del historial solo podía decir
 * `flat`/`moved`, que describe el mercado y no la decisión.
 *
 * Esto cierra ese hueco: aplica el MISMO barrier que ya evalúa los setups reales
 * (`evaluateSetupBarrier`) sobre la geometría condicional, acotado por la MISMA vigencia
 * declarada (`setupExpiryMs` + `candlesWithinValidity`). No se reimplementa ninguna regla
 * — dos definiciones de "cuándo caduca un setup" o de "cuándo se llena una entrada" se
 * desincronizan, y el resultado dejaría de ser comparable con el del setup ejecutable.
 *
 * ⚠️ LO QUE ESTA MEDICIÓN **NO** DICE
 * -----------------------------------
 * 1. **La lectura es MÁS PERMISIVA que el gatillo declarado.** El `trigger` es texto libre
 *    ("cierre 4h por debajo de 72,32") y NO se parsea: parsear lenguaje natural para
 *    derivar un umbral numérico sería frágil y silencioso cuando fallara. Lo que se evalúa
 *    es la GEOMETRÍA: la entrada se considera llena cuando el precio la TOCA intravela
 *    (regla `SHADOW_FILL_RULE`). Un `not_triggered` es por tanto robusto por el lado
 *    conservador —si no llegó ni a tocarla, tampoco hubo cierre de vela más allá—, pero un
 *    `tp1`/`stop` puede corresponder a un trade que el gatillo estricto nunca habría
 *    autorizado. La regla viaja en la respuesta de la API para que la cifra no se lea
 *    nunca sin ella. Corolario práctico: **un condicional cuya entrada esté pegada al
 *    precio del momento se contará como disparado casi seguro**, y es la vía más probable
 *    de que `trigger_rate` se infle. NO se filtra por una distancia mínima: sería una
 *    constante de corte inventada, y aquí eso no se hace sin medir antes su distribución
 *    (§0). El dato para medirla ya está persistido: `setup`/`conditional_setup` frente a
 *    `analyses.price_current`.
 * 2. **Un shadow trade ganador NO demuestra que la abstención fuera un error.** El modelo
 *    dijo "si aparece X, tomaría este trade"; que X apareciera y el trade funcionara
 *    valida la GEOMETRÍA declarada, no convierte el `Esperar` en fallo — el análisis es una
 *    foto, y el disparo lo recogería el análisis siguiente. Lo que mide esto es si el
 *    sistema nombra condiciones que (a) llegan a darse y (b) cuando se dan, funcionan.
 * 3. **Ventana de datos máxima: 7 días.** Es lo que el job pide a Binance para el
 *    recorrido. Un condicional cuya vigencia declarada exceda ese límite se cierra como
 *    `truncated` en vez de fingir un `not_triggered` que no se ha podido comprobar.
 */

import { setupExpiryMs, candlesWithinValidity, evaluateSetupBarrier } from './outcome.js';

/** Regla de llenado que se aplica (viaja a la API: la cifra no se lee sin su regla). */
export const SHADOW_FILL_RULE = 'touch_entry_intrabar';

const HOUR_MS = 3600 * 1000;
/** Ventana máxima de datos del job de outcome (klines de 1h desde el análisis). */
export const SHADOW_MAX_WINDOW_MS = 7 * 24 * HOUR_MS;

/** Número tolerante a strings, pero que NO convierte '' ni null en 0. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normaliza el `conditional_setup` persistido (JSON de SQLite u objeto ya hidratado).
 * @returns {{trigger:string|null, direction:string|null, entry_price:number|null,
 *            stop_price:number|null, tp1_price:number|null,
 *            validity_candles:number|null, tf_execution:string|null}|null}
 *          null solo si NO hay condicional (ausente o texto ilegible se distingue en
 *          `evaluateShadowTrade`, que sí necesita separar los dos casos).
 */
export function parseConditionalSetup(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let cs = raw;
  if (typeof raw === 'string') {
    try { cs = JSON.parse(raw); } catch { return null; }
  }
  if (!cs || typeof cs !== 'object' || Array.isArray(cs)) return null;
  return {
    trigger:          typeof cs.trigger === 'string' ? cs.trigger : null,
    direction:        typeof cs.direction === 'string' ? cs.direction.toLowerCase() : null,
    entry_price:      num(cs.entry_price),
    stop_price:       num(cs.stop_price),
    tp1_price:        num(cs.tp1_price),
    validity_candles: num(cs.validity_candles),
    tf_execution:     typeof cs.tf_execution === 'string' ? cs.tf_execution : null,
  };
}

/**
 * Dirección implícita en la geometría (long si el stop está por debajo de la entrada).
 * Es la MISMA inferencia que hace `evaluateSetupBarrier`; se expone aparte para poder
 * segmentar las estadísticas sin volver a razonarla en otro sitio.
 * @returns {'long'|'short'|null}
 */
export function geometryDirection(cs) {
  if (!cs || !Number.isFinite(cs.entry_price) || !Number.isFinite(cs.stop_price)) return null;
  if (cs.stop_price === cs.entry_price) return null;
  return cs.stop_price < cs.entry_price ? 'long' : 'short';
}

/**
 * ¿Hay algún defecto que haga la geometría INEVALUABLE? Devuelve el motivo o null.
 *
 * Fail-closed a propósito: un condicional que se contradice a sí mismo (dice `long` con
 * el stop por encima de la entrada, o pone el TP en el lado del stop) produciría un
 * `win`/`loss` que nadie puede interpretar. Se marca `invalid` y se cuenta aparte, en vez
 * de adivinar cuál de los dos campos era el bueno. El validador determinista ya avisa de
 * estos casos (`conditional_direction_mismatch`, `conditional_tp_side`) — aquí se cierra
 * el círculo: lo que se avisó no se cuela luego en el win-rate.
 */
export function conditionalGeometryProblem(cs) {
  if (!cs) return 'unparseable';
  const { entry_price: e, stop_price: s, tp1_price: t } = cs;
  if (!Number.isFinite(e) || !Number.isFinite(s)) return 'incomplete_geometry';
  if (s === e) return 'stop_eq_entry';
  // Sin objetivo no hay ganancia posible: el trade solo podría acabar en stop o caducado,
  // y contarlo sesgaría el win-rate hacia abajo por un defecto de reporte.
  if (!Number.isFinite(t)) return 'missing_tp';
  const geo = geometryDirection(cs);
  if (cs.direction && cs.direction !== geo) return 'direction_mismatch';
  if (geo === 'long' && t <= e) return 'tp_side';
  if (geo === 'short' && t >= e) return 'tp_side';
  return null;
}

/**
 * Evalúa el shadow trade de un análisis contra el recorrido real del precio.
 *
 * @param {object} opts
 * @param {*} opts.conditionalSetup - JSON persistido (o el objeto ya hidratado).
 * @param {Array<{t:number,high:number,low:number}>} opts.candles - klines 1h desde `tMs`.
 * @param {number} opts.tMs - epoch ms del análisis.
 * @param {string} [opts.primaryTf] - fallback de la vigencia si falta `tf_execution`.
 * @param {number} opts.now - epoch ms actual (inyectado: la terminalidad depende de él).
 * @param {number} [opts.maxWindowMs] - ventana máxima de datos disponible (7d por defecto).
 * @returns {{outcome:string, filled:0|1, invalid_reason:string|null, terminal:boolean,
 *            preserve:boolean, expiry_ms:number|null}|null}
 *   null ⇒ el análisis no declaró condicional (nada que evaluar).
 *   `preserve:true` ⇒ fallo TRANSITORIO (sin velas): no escribir, reintentar el ciclo
 *   siguiente. Distinguirlo de `invalid` importa: las klines históricas de Binance son
 *   permanentes, así que un hueco es de la red, no del dato.
 */
export function evaluateShadowTrade({
  conditionalSetup, candles, tMs, primaryTf, now, maxWindowMs = SHADOW_MAX_WINDOW_MS,
}) {
  if (conditionalSetup === null || conditionalSetup === undefined || conditionalSetup === '') {
    return null;
  }
  const base = {
    outcome: 'invalid', filled: 0, invalid_reason: null,
    terminal: true, preserve: false, expiry_ms: null, exit_price: null,
  };
  if (!Number.isFinite(tMs)) return { ...base, invalid_reason: 'bad_timestamp' };

  const cs = parseConditionalSetup(conditionalSetup);
  const problem = conditionalGeometryProblem(cs);
  // Defecto PERMANENTE (el JSON persistido no cambia nunca): terminal ya, sin esperar al
  // horizonte. Mismo criterio que el `setup_outcome='invalid'` inmediato del setup real.
  if (problem) return { ...base, invalid_reason: problem };

  const expiryMs = setupExpiryMs({
    tMs,
    validityCandles: cs.validity_candles,
    tfExecution:     cs.tf_execution,
    primaryTf,
  });
  const windowEndMs = tMs + maxWindowMs;
  // La vigencia declarada manda, acotada por lo que los datos alcanzan a ver. Si no es
  // determinable (FAIL-OPEN de `setupExpiryMs`), se usa la ventana completa — mismo
  // comportamiento que el setup real, que en ese caso tampoco recorta.
  const effectiveEndMs = expiryMs == null ? windowEndMs : Math.min(expiryMs, windowEndMs);
  // Truncado = la vigencia DECLARADA excede lo que se puede observar. No es lo mismo que
  // "no disparó": no se sabe qué hizo después del 7º día.
  const truncated = expiryMs != null && expiryMs > windowEndMs;
  const elapsed = now >= effectiveEndMs;

  if (!candles?.length) return { ...base, outcome: 'open', terminal: false, preserve: true, expiry_ms: expiryMs };

  const evalCandles = candlesWithinValidity(candles, effectiveEndMs);
  if (!evalCandles.length) {
    // Hay recorrido pero ninguna vela dentro de la vigencia (p. ej. vigencia de 1 vela de
    // 1h con la primera kline alineada justo en la caducidad). Nunca hubo dónde llenarse.
    if (!elapsed) return { ...base, outcome: 'open', terminal: false, preserve: true, expiry_ms: expiryMs };
    return {
      ...base, outcome: truncated ? 'truncated' : 'not_triggered', terminal: true, expiry_ms: expiryMs,
    };
  }

  const bar = evaluateSetupBarrier({
    entry_price: cs.entry_price,
    stop_price:  cs.stop_price,
    tp1_price:   cs.tp1_price,
    tp2_price:   null,   // el conditional_setup no declara TP2 (ver OUTPUT FORMAT)
  }, evalCandles);
  // La geometría ya se validó arriba, así que `bar` no debería ser null; si lo fuera,
  // tratarlo como inválido es más honesto que inventar un resultado.
  if (!bar) return { ...base, invalid_reason: 'barrier_unevaluable', expiry_ms: expiryMs };

  const filled = bar.filled ? 1 : 0;
  let outcome = bar.outcome;
  // Precio al que se habría CERRADO el shadow trade. Es un HECHO, no una interpretación: el
  // R se deriva luego de él y de la geometría, que ya está persistida.
  //
  // POR QUÉ HACE FALTA. Sin él la expectativa solo puede contar los que tocaron TP o stop, y
  // ese subconjunto está enriquecido en stops POR LA GEOMETRÍA, no por el mercado: el stop
  // suele estar más cerca que el objetivo, así que dentro de una vigencia corta lo alcanza
  // mucho más a menudo, y lo que no llega a ninguno CADUCA. Medido con 3.726 réplicas de las
  // 7 geometrías reales: 1.170 caducados frente a 1.064 resueltos — se tiraba el 52 % de los
  // trades disparados, y siempre por el mismo lado.
  let exitPrice = null;
  if (outcome === 'tp1' || outcome === 'stop') {
    // Resueltos DENTRO de la vigencia: terminales sin importar si el reloj ha vencido.
  } else if (!elapsed) {
    outcome = 'open';                    // aún puede llenarse o resolverse
  } else if (truncated) {
    outcome = 'truncated';               // se acabaron los datos antes que la vigencia
  } else if (outcome === 'open') {
    outcome = 'expired';                 // llenado, pero sin tocar TP ni stop en su vigencia
  }                                      // 'not_triggered' vencido → terminal tal cual

  if (outcome === 'tp1') exitPrice = cs.tp1_price;
  else if (outcome === 'stop') exitPrice = cs.stop_price;
  // Caducado con la entrada llena: cierra al último cierre DENTRO de la vigencia, que es lo
  // que haría cualquiera al vencer el plazo que el propio análisis declaró.
  else if (outcome === 'expired') exitPrice = evalCandles.at(-1)?.close ?? null;

  return {
    outcome, filled, invalid_reason: null,
    terminal: outcome !== 'open', preserve: false, expiry_ms: expiryMs,
    exit_price: Number.isFinite(exitPrice) ? exitPrice : null,
  };
}
