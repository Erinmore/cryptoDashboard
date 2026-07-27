/**
 * pathMetrics.js — Funciones puras para describir el RECORRIDO del precio tras un
 * análisis (Fase 5, backtest falsable). Sin I/O ni dependencias de servicios.
 *
 * Motivación: `classifyOutcome` compara el precio del análisis con el precio AL
 * horizonte, así que solo puede clasificar acciones direccionales. Con `Esperar`
 * como salida dominante, el win-rate tiene denominador estructuralmente 0 y el
 * sistema es inmune a la refutación. Estas funciones miden lo que sí se puede
 * medir para un `Esperar`: si el mercado ofreció un movimiento operable y cuándo.
 *
 * PRINCIPIO: aquí solo se persisten HECHOS OBJETIVOS del recorrido (excursiones y
 * tiempos de primer cruce). La interpretación —qué cuenta como oportunidad
 * perdida, qué geometría de trade habría funcionado— vive en `stats.js` y se puede
 * redefinir sin volver a pedir un solo dato a Binance.
 *
 * CONVENCIÓN TEMPORAL: el instante que se reporta para un cruce o un extremo es el
 * CIERRE de la vela que lo contiene, no su apertura. Es una cota superior — el
 * evento ocurrió en algún punto dentro de la vela — y por tanto conservadora al
 * responder "¿cómo de rápido llegó la oportunidad?".
 *
 * LÍMITE CONOCIDO (irreducible con velas de 1h): si un nivel al alza y uno a la baja
 * se cruzan DENTRO de la misma vela, su orden no se puede resolver: el `high` y el
 * `low` de una vela no vienen ordenados. Ambos reciben la misma hora y el desempate
 * lo aplica la capa de interpretación (asume primero el adverso, igual que
 * `evaluateSetupBarrier` cuando TP1 y stop caen en la misma vela).
 */

const HOUR_MS = 3600 * 1000;

/** Múltiplos de ATR para los que se registra el primer cruce, al alza y a la baja. */
export const ATR_MULTIPLES = [0.5, 1, 1.5, 2, 3, 4];

const round = (x, d = 2) => (Number.isFinite(x) ? parseFloat(x.toFixed(d)) : null);

/**
 * Hora (desde `tMs`) del CIERRE de la vela — cota superior del instante del evento.
 */
function candleEndHours(candle, tMs, intervalMs) {
  return round(((candle.t + intervalMs) - tMs) / HOUR_MS, 1);
}

/** Velas dentro de [tMs, tMs + windowMs], en orden cronológico. */
function windowCandles(candles, tMs, windowMs) {
  return candles.filter(
    (c) => c && c.t != null && c.t >= tMs && c.t <= tMs + windowMs
      && Number.isFinite(c.high) && Number.isFinite(c.low),
  );
}

/**
 * Excursión máxima al alza y a la baja dentro de una ventana, en % sobre `priceAt`.
 *
 * Los valores son SIGNADOS y pueden salir con el signo "contrario" al esperado: si el
 * precio nunca superó `priceAt`, `max_up_pct` es negativo. Es deliberado — dice que no
 * hubo recorrido favorable al alza en absoluto, que es información distinta de un 0.
 *
 * @param {Array<{t:number,high:number,low:number}>} candles - cronológicas, desde tMs.
 * @param {number} priceAt - precio de referencia (baseline del análisis).
 * @param {number} tMs - epoch ms del análisis.
 * @param {number} windowMs - tamaño de la ventana.
 * @param {number} [intervalMs=3600000] - duración de cada vela.
 * @returns {{max_up_pct:number, max_down_pct:number, t_max_up_h:number, t_max_down_h:number}|null}
 */
export function computeExcursions(candles, priceAt, tMs, windowMs, intervalMs = HOUR_MS) {
  if (!Number.isFinite(priceAt) || priceAt <= 0) return null;
  const inWindow = windowCandles(candles ?? [], tMs, windowMs);
  if (!inWindow.length) return null;

  let hi = inWindow[0], lo = inWindow[0];
  for (const c of inWindow) {
    if (c.high > hi.high) hi = c;
    if (c.low < lo.low) lo = c;
  }

  return {
    max_up_pct:   round(((hi.high - priceAt) / priceAt) * 100),
    max_down_pct: round(((lo.low - priceAt) / priceAt) * 100),
    t_max_up_h:   candleEndHours(hi, tMs, intervalMs),
    t_max_down_h: candleEndHours(lo, tMs, intervalMs),
  };
}

/**
 * Horas hasta el PRIMER cruce de cada múltiplo de ATR, al alza y a la baja.
 *
 * Esto es lo que las excursiones máximas no pueden dar: con solo los extremos se sabe
 * CUÁNTO se movió el precio, no si el recorrido favorable llegó ANTES que el adverso
 * ni cómo de rápido. Un recorrido de 3×ATR en 8 horas y uno de 3×ATR en 6 días son la
 * misma cifra de excursión y significan cosas opuestas para un sistema que decide
 * sobre velas de 4h.
 *
 * @param {Array<{t:number,high:number,low:number}>} candles
 * @param {number} priceAt
 * @param {number} atrPct - ATR del TF primario como % del precio. Sin él no hay escala
 *   de volatilidad contra la que normalizar → devuelve null (no se inventa un umbral).
 * @param {number} tMs
 * @param {number} windowMs
 * @param {number} [intervalMs=3600000]
 * @param {number[]} [multiples=ATR_MULTIPLES]
 * @returns {{atr_pct:number, multiples:number[], up:Object<string,number|null>, down:Object<string,number|null>}|null}
 */
export function computeFirstPassage(
  candles, priceAt, atrPct, tMs, windowMs, intervalMs = HOUR_MS, multiples = ATR_MULTIPLES,
) {
  if (!Number.isFinite(priceAt) || priceAt <= 0) return null;
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;
  const inWindow = windowCandles(candles ?? [], tMs, windowMs);
  if (!inWindow.length) return null;

  const up = {}, down = {};
  for (const k of multiples) {
    const upLevel   = priceAt * (1 + (k * atrPct) / 100);
    const downLevel = priceAt * (1 - (k * atrPct) / 100);
    up[String(k)] = null;
    down[String(k)] = null;
    for (const c of inWindow) {
      if (up[String(k)] === null && c.high >= upLevel) up[String(k)] = candleEndHours(c, tMs, intervalMs);
      if (down[String(k)] === null && c.low <= downLevel) down[String(k)] = candleEndHours(c, tMs, intervalMs);
      if (up[String(k)] !== null && down[String(k)] !== null) break;
    }
  }

  return { atr_pct: round(atrPct), multiples: [...multiples], up, down };
}

/**
 * ATR como % del precio a partir de una serie de velas del TF primario que TERMINA en
 * el instante del análisis. Es el normalizador de volatilidad de todas las métricas de
 * recorrido: sin él, "el precio se movió un 3 %" no distingue oportunidad de ruido.
 *
 * @param {Array<{high:number,low:number,close:number}>} candles - del TF primario, previas al análisis.
 * @param {Function} atrFn - `calculateATR` inyectada (mantiene este módulo sin dependencias).
 * @param {number} [period=14]
 * @returns {number|null} ATR en % del último cierre.
 */
export function computeAtrPct(candles, atrFn, period = 14) {
  if (!candles?.length || typeof atrFn !== 'function') return null;
  const atr = atrFn(candles, period);
  const lastClose = candles[candles.length - 1]?.close;
  if (!Number.isFinite(atr) || !Number.isFinite(lastClose) || lastClose <= 0) return null;
  return round((atr / lastClose) * 100);
}

/**
 * Ensambla todas las métricas de recorrido que se persisten en `analysis_outcome`.
 *
 * La ventana de primeros cruces es ÚNICA (7d) a propósito: el horizonte de 24h se
 * obtiene filtrando por hora en tiempo de lectura, no duplicando columnas. Los máximos
 * sí necesitan su versión de 24h — un máximo a 7d no acota el de 24h.
 *
 * @returns {{max_up_pct_24h:number|null, max_down_pct_24h:number|null,
 *            max_up_pct_7d:number|null, max_down_pct_7d:number|null,
 *            t_max_up_h:number|null, t_max_down_h:number|null,
 *            path_first_passage:object|null}}
 */
export function computePathMetrics({ candles, priceAt, atrPct, tMs, intervalMs = HOUR_MS }) {
  const DAY_MS = 24 * HOUR_MS;
  const e24 = computeExcursions(candles, priceAt, tMs, DAY_MS, intervalMs);
  const e7d = computeExcursions(candles, priceAt, tMs, 7 * DAY_MS, intervalMs);
  const fp  = computeFirstPassage(candles, priceAt, atrPct, tMs, 7 * DAY_MS, intervalMs);

  return {
    max_up_pct_24h:   e24?.max_up_pct ?? null,
    max_down_pct_24h: e24?.max_down_pct ?? null,
    max_up_pct_7d:    e7d?.max_up_pct ?? null,
    max_down_pct_7d:  e7d?.max_down_pct ?? null,
    // Los tiempos de los extremos se reportan sobre la ventana de 7d (la completa).
    t_max_up_h:       e7d?.t_max_up_h ?? null,
    t_max_down_h:     e7d?.t_max_down_h ?? null,
    path_first_passage: fp,
  };
}
