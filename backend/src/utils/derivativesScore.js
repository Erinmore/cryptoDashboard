/**
 * derivativesScore.js — Derivatives Score determinista (funciones puras, sin I/O).
 *
 * ─── POR QUÉ EXISTE ────────────────────────────────────────────────────────────
 *
 * Hasta el 2026-07-29 este score lo puntuaba el LLM a partir de la sección A del system
 * prompt. Esa sección tenía DOS reglas numéricas (`severity_negative` high → +1, extreme →
 * +2) y ninguna que produjera negativo. Medido sobre 90 días × SOL/BTC/ETH con
 * `scripts/auditDerivativesScore.mjs`: **las dos disparaban el 0,0 % del tiempo**.
 *
 * Como `Comprar` exige `derivatives >= +1` y `Vender` exige `derivatives <= -1`, y el score
 * es la cima de la jerarquía (Derivatives > Volume > Structure > Execution), el resultado era
 * que **el sistema no podía emitir ninguna decisión direccional**. En producción salió 0 en
 * 6 de 6 análisis, y las 6 acciones fueron `Esperar`.
 *
 * Se mueve al backend siguiendo el principio del Sprint Backend Gating (v6_0): *el backend
 * precalcula flags, el LLM interpreta*. Así el score es reproducible, auditable y testeable,
 * y deja de depender de que el modelo invente un criterio que nadie le dio.
 *
 * ─── DE DÓNDE SALEN LOS NÚMEROS ────────────────────────────────────────────────
 *
 * Todos medidos con `scripts/auditDerivativesRubric.mjs` (90 días, SOL/BTC/ETH, TF 4h,
 * n≈534 anclajes por moneda). Ninguna constante se escribió sin ver antes su distribución.
 *
 * EL EJE PRINCIPAL es OI × dirección del precio, porque **el OI no tiene dirección propia**:
 * expandirse es alcista o bajista según contra qué se expanda. El prompt ya lo intuía ("Open
 * Interest determina convicción real / simple cierre de posiciones") pero nunca lo convertía
 * en criterio.
 *
 * ⚠️ CONTROL DE MOMENTUM — lo más importante de la calibración. La primera medición comparaba
 * cada celda contra la tasa base GLOBAL, lo que mezcla la información del OI con el simple
 * hecho de que el precio venía moviéndose. Al comparar contra la base DEL GRUPO con el mismo
 * signo de precio:
 *
 *   celda            vs base global        vs base del grupo        veredicto
 *   OI↓ px↑          SOL -17,6 ETH -12,1   SOL -20,2  ETH -24,2     SE REFUERZA
 *   OI↑ px↑          SOL +15,7 ETH +20,2   SOL +13,1  ETH  +8,1     sobrevive debilitado
 *   OI↑ px↓          SOL +11,0 ETH  +8,3   SOL  +3,7  ETH  +4,7     SE CAE → fuera
 *   OI↓ px↓          sin señal             sin señal                fuera
 *
 * Por eso `OI↑ px↓` (shorts nuevos entrando) NO puntúa pese a tener una lectura mecánica
 * atractiva: su efecto aparente era momentum del precio. Incluirlo metería información de
 * precio en un score que está POR ENCIMA de Structure en la jerarquía — el doble conteo que
 * la regla B1 y la 2ª auditoría red-team se dedicaron a eliminar. El dato sigue viajando en
 * el payload, así que el LLM puede leerlo como contexto; simplemente no cobra un punto.
 *
 * El efecto MEJOR evidenciado es el rally sin dinero nuevo (`OI↓ px↑`): en SOL continuó al
 * alza 0 de 24 veces y en ETH 1 de 29, contra tasas base del 20,2 % y 27,7 %. Se le asigna
 * -1 y no -2 por prudencia con n≈25. **Es el primer candidato a promoción a -2** si la
 * recogida posterior confirma el efecto.
 *
 * ─── LO QUE NO ESTÁ VALIDADO (leer antes de confiar) ───────────────────────────
 *
 *  · 90 días son UN RÉGIMEN. Es el límite duro de Coinalyze. `MEASURED_AT` viaja en la
 *    salida para que la cifra nunca se lea sin su fecha, igual que `OPPORTUNITY_BASE_RATE`.
 *  · BTC NO replica las celdas de OI (todos los lifts dentro de ±3,3). Sí replica la cascada.
 *    La rúbrica está validada para alts; producción es SOL.
 *  · n≈24-58 por celda, 4-10 anclajes no solapados. Los lifts son sugerentes, no establecidos.
 *  · Está ajustada sobre los mismos 90 días con los que se mide: sin validación fuera de
 *    muestra. Esa la da el periodo de recogida posterior al despliegue.
 *  · Anomalía sin explicar: en el grupo bajista la BANDA MUERTA del OI predice caídas mejor
 *    que OI↑ (SOL +17,0, BTC +15,7). Sin lectura mecánica; con n≈30, probablemente ruido.
 *    Si no lo fuera, invalidaría la premisa del cuadro.
 */

/** Parámetros de la rúbrica. Todos medidos; ver la cabecera para su procedencia. */
export const DERIVATIVES_RUBRIC = {
  /** Banda muerta del OI, en %. Ya en producción en `gating.js` (mediana del cambio 24h ≈ 0). */
  oi_dead_band_pct: 1.0,
  /**
   * Banda muerta del precio, en múltiplos del ATR% del TF primario escalado a 24h (×√n).
   * Un umbral absoluto en % sería el fallo T5 otra vez. Con 0,5 quedan fuera ~59 % de los
   * anclajes, consistente en las tres monedas (40,8 / 41,6 / 40,3 % con dirección).
   */
  price_band_atr_mult: 0.5,
  /** Cascada de liquidaciones: skew y magnitud frente a la mediana de 30d de su propia serie. */
  cascade_skew_max: -0.5,
  cascade_magnitude_mult: 2,
  /**
   * Mínimo de ventanas rodantes de 24h para fiarse de la mediana. 30 días completos dan ~697.
   *
   * El corte es ALTO (~26 días) a propósito. En la calibración, un tercio de los anclajes cayó
   * en el periodo de calentamiento —mediana sobre menos de 30 días— y eso **diluía la señal
   * casi a la mitad**: el lift bajista de la cascada pasa de +14,5/+13,3/+5,9 con la mediana
   * a medio formar a **+31,3/+28,0/+23,7** con los 30 días completos (SOL/BTC/ETH). Una
   * mediana corta se adapta al régimen y se apaga en estrés, así que por debajo de este
   * umbral la cascada se ABSTIENE en vez de disparar con un listón poco fiable.
   */
  cascade_min_points: 620,
  measured_at: '2026-07-29',
  measured_scope: '90d · SOL/BTC/ETH · TF 4h · scripts/auditDerivativesRubric.mjs',
};

/** Duración de una vela por TF, en horas. */
const TF_HOURS = { '1h': 1, '4h': 4, '1D': 24, '1W': 168 };

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Escala del ATR desde una vela del TF primario hasta la ventana de 24h.
 *
 * El recorrido escala con √t, así que 24h sobre velas de 4h son √6. Es el mismo razonamiento
 * con el que se fijaron los pares de oportunidad por horizonte (24h 2×/1×, 7d 4×/1×).
 * Con TF de 1D o 1W la ventana de 24h no llega a una vela → factor 1 (no se sub-escala).
 */
export function windowScale(primaryTf) {
  const h = TF_HOURS[primaryTf];
  if (!Number.isFinite(h) || h <= 0) return Math.sqrt(6); // fallback: 4h, el TF de producción
  return Math.sqrt(Math.max(1, 24 / h));
}

/**
 * Cambio de precio de 24h a partir de las VELAS DEL TF PRIMARIO (cierre a cierre).
 *
 * ⚠️ NO USAR `price_change_24h_pct` DEL PAYLOAD PARA ESTO. Ese campo es un rolling 24h de
 * CoinGecko: otra fuente y sin alinear a fronteras de vela. La banda `0,5 × ATR% × √n` se
 * calibró contra cierre-a-cierre de klines de Binance en fronteras de vela 4h, así que
 * alimentarla con otra distribución invalidaría la constante en silencio — exactamente el
 * tipo de sustitución que ya rechazamos con la ventana de la mediana.
 *
 * Se compara la ÚLTIMA vela (que en producción puede estar en curso) contra la de `n` atrás,
 * igual que en la calibración: allí los anclajes también incluían el bucket parcial en curso.
 *
 * @param {Array<{close:number}>|null} candles - velas del TF primario, orden ascendente.
 * @param {string} primaryTf
 * @returns {number|null} cambio en %, o null si no hay historia suficiente.
 */
export function priceChange24hFromCandles(candles, primaryTf) {
  if (!Array.isArray(candles)) return null;
  const h = TF_HOURS[primaryTf];
  const back = Math.max(1, Math.round(24 / (Number.isFinite(h) && h > 0 ? h : 4)));
  if (candles.length <= back) return null;
  const now = candles.at(-1)?.close;
  const prev = candles.at(-1 - back)?.close;
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev <= 0) return null;
  return ((now - prev) / prev) * 100;
}

/**
 * Celda del cuadro OI × precio. Solo puntúan las dos que sobreviven al control de momentum.
 *
 * @returns {{score:number, cell:string}} `cell` es la etiqueta para telemetría, siempre
 *   presente aunque el score sea 0 — así se puede auditar a posteriori cuántas veces cayó en
 *   cada celda, incluidas las que no puntúan.
 */
export function oiPriceCell({ oiChange24hPct, priceChange24hPct, atrPct, primaryTf }) {
  if (!Number.isFinite(oiChange24hPct) || !Number.isFinite(priceChange24hPct)
      || !Number.isFinite(atrPct) || atrPct <= 0) {
    return { score: 0, cell: 'data_missing' };
  }
  const band = DERIVATIVES_RUBRIC.price_band_atr_mult * atrPct * windowScale(primaryTf);
  const o = oiChange24hPct > DERIVATIVES_RUBRIC.oi_dead_band_pct ? 1
    : oiChange24hPct < -DERIVATIVES_RUBRIC.oi_dead_band_pct ? -1 : 0;
  const p = priceChange24hPct > band ? 1 : priceChange24hPct < -band ? -1 : 0;

  if (o === 0 || p === 0) return { score: 0, cell: 'no_signal' };
  if (o === 1 && p === 1) return { score: 1, cell: 'new_money_long' };
  if (o === -1 && p === 1) return { score: -1, cell: 'failed_rally' };
  if (o === 1 && p === -1) return { score: 0, cell: 'new_money_short' };  // no puntúa: era momentum
  return { score: 0, cell: 'deleveraging' };                              // no puntúa: sin señal
}

/**
 * Cascada de liquidaciones de LONGS. Solo la bajista: la de shorts salió contradictoria entre
 * monedas (SOL sin señal, BTC alcista con n=7, ETH bajista) y se descartó.
 *
 * Consume `skew` y `magnitude_vs_median_30d`, que precalcula `coinalyzeService` sobre los 720
 * puntos horarios — la función pura no rehace la ventana.
 *
 * ⚠️ LA VENTANA DE LA MEDIANA ES DE 30 DÍAS Y NO ES INTERCAMBIABLE. Con 7 días la frecuencia
 * agregada es casi idéntica (23,4 % → 23,0 %), pero los EVENTOS no coinciden: en SOL el
 * acuerdo cae al 65,7 %, y **en régimen ya cargado de liquidaciones la ventana corta pierde
 * el 22 % de las cascadas** que ve la de 30. Una mediana corta se adapta al régimen reciente,
 * así que durante una caída sostenida el listón sube con ella y la señal se apaga justo
 * cuando debe detectar. Comparar solo frecuencias agregadas lo habría ocultado.
 */
export function liquidationCascade(liq) {
  const skew = liq?.skew;
  const magnitude = liq?.magnitude_vs_median_30d;
  const points = liq?.median_window_points;

  if (!Number.isFinite(skew) || !Number.isFinite(magnitude)) {
    return { score: 0, reason: 'sin datos de liquidaciones normalizados' };
  }
  if (Number.isFinite(points) && points < DERIVATIVES_RUBRIC.cascade_min_points) {
    return { score: 0, reason: `mediana sobre ${points} puntos: insuficiente` };
  }
  if (skew <= DERIVATIVES_RUBRIC.cascade_skew_max && magnitude >= DERIVATIVES_RUBRIC.cascade_magnitude_mult) {
    return {
      score: -1,
      reason: `cascada de longs (skew ${skew.toFixed(2)}, ${magnitude.toFixed(1)}× la mediana 30d)`,
      skew, magnitude,
    };
  }
  return { score: 0, reason: 'sin cascada', skew, magnitude };
}

/**
 * Funding. SIN CAMBIOS respecto al prompt anterior: sus umbrales son eventos de cola (0,0 %
 * en 90 días × 3 monedas) y eso es CORRECTO — el funding tiene significado absoluto y
 * percentilizarlo fabricaría alarmas en un mercado tranquilo (decisión de §6.3, se mantiene).
 * Lo que estaba mal no era el funding: era que fuese la ÚNICA fuente del score.
 */
export function fundingTerm(funding) {
  const sn = funding?.severity_negative ?? null;
  const s = funding?.severity ?? null;
  if (sn === 'extreme_short_overload') return { score: 2, reason: 'funding negativo extremo (squeeze probable)' };
  if (sn === 'high_short_overload') return { score: 1, reason: 'funding negativo alto (coste de carry para shorts)' };
  if (s === 'extreme' || s === 'high') return { score: -1, reason: `funding ${s} (longs sobre-apalancados)` };
  return { score: 0, reason: null };
}

/**
 * Derivatives Score completo, en [-2, +2].
 *
 * ORDEN DE COMPOSICIÓN — importa: la cascada solo suma **si la celda no dijo nada**. Medido
 * que la cascada duplica el signo de la celda el 33-44 % de las veces; sumarlas sin más sería
 * el doble conteo que prohíbe la regla B1 del prompt. Cuando la celda calla (49-65 % de las
 * cascadas) sí aporta señal nueva, y ahí es donde entra.
 *
 * @returns {{score:number, basis:string[], components:object, rubric:object}}
 */
export function computeDerivativesScore({
  oiChange24hPct = null, priceChange24hPct = null, atrPct = null, primaryTf = '4h',
  liquidations = null, funding = null,
} = {}) {
  const basis = [];
  const cell = oiPriceCell({ oiChange24hPct, priceChange24hPct, atrPct, primaryTf });
  const dataInsufficient = cell.cell === 'data_missing';

  // FAIL-CLOSED (patrón H2 · `gating.data_insufficient`): sin el eje principal no se puede
  // comprobar si la cascada duplica lo que la celda ya diría, así que la cascada SE ABSTIENE
  // en vez de emitir una señal direccional a ciegas. El funding sí sigue: es absoluto y
  // ortogonal a OI y precio, no necesita el eje para interpretarse.
  const cascade = dataInsufficient
    ? { score: 0, reason: 'no evaluada: faltan OI/precio/ATR, no se puede descartar doble conteo' }
    : cell.score === 0
      ? liquidationCascade(liquidations ?? {})
      : { score: 0, reason: 'no evaluada: la celda OI×precio ya emitió señal (anti-doble-conteo)' };
  const fund = fundingTerm(funding);

  if (cell.score !== 0) {
    basis.push(cell.cell === 'new_money_long'
      ? 'OI expandiendo con precio al alza: dinero nuevo comprando (+1)'
      : 'precio al alza con OI contrayéndose: rally sin dinero nuevo (-1)');
  } else if (cell.cell === 'new_money_short') {
    basis.push('OI expandiendo con precio a la baja: no puntúa (su efecto aparente era momentum del precio)');
  } else if (cell.cell === 'data_missing') {
    basis.push('sin OI, precio 24h o ATR: la celda no se evalúa');
  }
  if (cascade.score !== 0) basis.push(`${cascade.reason} (-1)`);
  if (fund.score !== 0) basis.push(`${fund.reason} (${fund.score > 0 ? '+' : ''}${fund.score})`);
  if (!basis.length) basis.push('sin señal de derivados');

  return {
    score: clamp(cell.score + cascade.score + fund.score, -2, 2),
    /**
     * `true` cuando falta el eje principal (OI, precio 24h o ATR). El score puede seguir
     * siendo != 0 por la cola del funding, pero el consumidor debe saber que NO se evaluó
     * el eje que gobierna la rúbrica — un 0 aquí significa "no sabemos", no "sin señal".
     */
    data_insufficient: dataInsufficient,
    basis,
    components: {
      oi_price_cell: cell.cell,
      oi_price_score: cell.score,
      // Las DOS entradas del eje, persistidas: el payload expone además un
      // `price_change_24h_pct` de CoinGecko (rolling, otra fuente) que NO es el que se usa
      // aquí. Sin esto, esa discrepancia sería invisible al auditar a posteriori.
      oi_change_24h_pct: Number.isFinite(oiChange24hPct) ? oiChange24hPct : null,
      price_change_24h_pct_candles: Number.isFinite(priceChange24hPct)
        ? parseFloat(priceChange24hPct.toFixed(3)) : null,
      cascade_score: cascade.score,
      cascade_reason: cascade.reason ?? null,
      funding_score: fund.score,
    },
    rubric: {
      measured_at: DERIVATIVES_RUBRIC.measured_at,
      measured_scope: DERIVATIVES_RUBRIC.measured_scope,
    },
  };
}
