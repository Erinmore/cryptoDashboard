/**
 * shadowTrade.test.js — evaluación retroactiva del `conditional_setup`.
 *
 * Cubre las funciones puras (`utils/shadowTrade.js`) y la agregación
 * (`summarizeShadowTrades` de `utils/stats.js`). El CABLEADO con el job vive en
 * `outcomeService.test.js`, que es donde han estado los fallos de esta familia
 * (`setup_validity_candles` se persistía y no lo leía nadie).
 *
 * Lo que se fija aquí a propósito:
 *  - la vigencia DECLARADA acota la evaluación (mismo helper que el setup real);
 *  - una geometría que se contradice es `invalid`, no un win/loss inventado;
 *  - los denominadores: `trigger_rate` solo sobre lo concluyente y `win_rate` solo
 *    sobre tp1+stop, que es donde se cuelan las cifras favorables.
 */

import { describe, test, expect } from '@jest/globals';
import {
  parseConditionalSetup, conditionalGeometryProblem, geometryDirection,
  evaluateShadowTrade, SHADOW_MAX_WINDOW_MS,
} from '../src/utils/shadowTrade.js';
import {
  summarizeShadowTrades, normalizedTriggerDistance, triggerBaseRateFor, TRIGGER_BASE_RATE,
  expectancyR,
} from '../src/utils/stats.js';

const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-07-30T08:05:00.000Z');

/** Velas horarias desde `t` a partir de pares [high, low]. */
const velas = (t, pares) => pares.map(([high, low], i) => ({
  t: t + i * HOUR, open: low, close: high, high, low, volume: 1,
}));

/** Condicional LARGO por defecto: entrada 100, stop 95, TP 110, 6 velas de 4h (=24h). */
const cond = (over = {}) => ({
  trigger: 'cierre 4h por encima de 100',
  direction: 'long',
  entry_price: 100, stop_price: 95, tp1_price: 110,
  validity_candles: 6, tf_execution: '4h',
  ...over,
});

const evaluar = (over = {}) => evaluateShadowTrade({
  conditionalSetup: cond(over.cs ?? {}),
  candles: over.candles ?? [],
  tMs: T0,
  primaryTf: '4h',
  now: over.now ?? T0 + 30 * HOUR,
});

describe('parseConditionalSetup', () => {
  test('acepta JSON string y objeto por igual', () => {
    const obj = parseConditionalSetup(cond());
    const str = parseConditionalSetup(JSON.stringify(cond()));
    expect(str).toEqual(obj);
    expect(obj.entry_price).toBe(100);
  });

  test('ausencia y texto ilegible se distinguen (null vs null-tras-parseo)', () => {
    expect(parseConditionalSetup(null)).toBeNull();
    expect(parseConditionalSetup('')).toBeNull();
    expect(parseConditionalSetup('{no es json')).toBeNull();
    // Un array no es un setup: no se acepta por ser typeof 'object'.
    expect(parseConditionalSetup('[1,2]')).toBeNull();
  });

  test('cadena vacía NO se convierte en 0 (Number("") === 0 sería un precio inventado)', () => {
    const cs = parseConditionalSetup({ entry_price: '', stop_price: '95.5', tp1_price: null });
    expect(cs.entry_price).toBeNull();
    expect(cs.stop_price).toBe(95.5);   // string numérico sí se acepta
    expect(cs.tp1_price).toBeNull();
  });
});

describe('conditionalGeometryProblem — fail-closed ante geometría contradictoria', () => {
  test('geometría coherente no tiene problema', () => {
    expect(conditionalGeometryProblem(parseConditionalSetup(cond()))).toBeNull();
    expect(geometryDirection(parseConditionalSetup(cond()))).toBe('long');
  });

  test('corto coherente (stop por encima, TP por debajo)', () => {
    const cs = parseConditionalSetup(cond({
      direction: 'short', entry_price: 72.2, stop_price: 74.5, tp1_price: 68.3,
    }));
    expect(conditionalGeometryProblem(cs)).toBeNull();
    expect(geometryDirection(cs)).toBe('short');
  });

  test('dirección declarada que contradice la geometría → direction_mismatch', () => {
    const cs = parseConditionalSetup(cond({ direction: 'short' })); // stop 95 < entry 100
    expect(conditionalGeometryProblem(cs)).toBe('direction_mismatch');
  });

  test('TP en el lado del stop → tp_side', () => {
    const cs = parseConditionalSetup(cond({ tp1_price: 90 }));
    expect(conditionalGeometryProblem(cs)).toBe('tp_side');
  });

  test('sin TP no hay ganancia posible → missing_tp (no se cuenta como loss estructural)', () => {
    expect(conditionalGeometryProblem(parseConditionalSetup(cond({ tp1_price: null }))))
      .toBe('missing_tp');
  });

  test('stop == entry → stop_eq_entry', () => {
    expect(conditionalGeometryProblem(parseConditionalSetup(cond({ stop_price: 100 }))))
      .toBe('stop_eq_entry');
  });
});

describe('evaluateShadowTrade — resultados', () => {
  test('sin conditional_setup devuelve null (nada que evaluar, no es un fallo)', () => {
    expect(evaluateShadowTrade({ conditionalSetup: null, candles: [], tMs: T0, now: T0 })).toBeNull();
  });

  test('JSON ilegible → invalid INMEDIATO (el texto persistido no va a cambiar)', () => {
    const r = evaluateShadowTrade({
      conditionalSetup: '{roto', candles: [], tMs: T0, now: T0 + HOUR,
    });
    expect(r.outcome).toBe('invalid');
    expect(r.invalid_reason).toBe('unparseable');
    expect(r.terminal).toBe(true);
  });

  test('el precio toca la entrada y llega al TP → tp1', () => {
    const r = evaluar({ candles: velas(T0, [[101, 99], [111, 105]]) });
    expect(r.outcome).toBe('tp1');
    expect(r.filled).toBe(1);
  });

  test('toca la entrada y luego el stop → stop', () => {
    const r = evaluar({ candles: velas(T0, [[101, 99], [99, 94]]) });
    expect(r.outcome).toBe('stop');
    expect(r.filled).toBe(1);
  });

  test('nunca alcanza la entrada dentro de la vigencia → not_triggered', () => {
    // 30 velas de 1h por debajo de la entrada; la vigencia son 24h.
    const r = evaluar({ candles: velas(T0, Array(30).fill([98, 96])) });
    expect(r.outcome).toBe('not_triggered');
    expect(r.filled).toBe(0);
  });

  test('llenado pero sin TP ni stop dentro de la vigencia → expired', () => {
    const r = evaluar({ candles: velas(T0, [[101, 99], ...Array(29).fill([103, 99.5])]) });
    expect(r.outcome).toBe('expired');
    expect(r.filled).toBe(1);
  });

  test('vigencia aún viva → open (no se cierra por adelantado)', () => {
    const r = evaluar({
      candles: velas(T0, Array(3).fill([98, 96])),
      now: T0 + 4 * HOUR,                       // 24h de vigencia sin vencer
    });
    expect(r.outcome).toBe('open');
    expect(r.terminal).toBe(false);
  });

  test('el TP tocado FUERA de la vigencia no cuenta (es el sesgo que ya se corrigió en el setup real)', () => {
    const r = evaluar({
      // Plano 30h y TP al 5º día: fuera de las 6 velas de 4h declaradas.
      candles: [
        ...velas(T0, [[101, 99], ...Array(29).fill([103, 99.5])]),
        { t: T0 + 120 * HOUR, open: 103, close: 115, high: 115, low: 103, volume: 1 },
      ],
      now: T0 + 8 * 24 * HOUR,
    });
    expect(r.outcome).toBe('expired');
  });

  test('sin vigencia declarada, FAIL-OPEN: se usa la ventana completa de 7d', () => {
    const r = evaluateShadowTrade({
      conditionalSetup: cond({ validity_candles: null, tf_execution: null }),
      candles: [
        ...velas(T0, [[101, 99]]),
        { t: T0 + 120 * HOUR, open: 103, close: 115, high: 115, low: 103, volume: 1 },
      ],
      tMs: T0, primaryTf: '4h', now: T0 + 8 * 24 * HOUR,
    });
    expect(r.expiry_ms).toBeNull();
    expect(r.outcome).toBe('tp1');
  });

  test('vigencia declarada MÁS LARGA que los 7d de datos → truncated, no not_triggered', () => {
    // 42 velas de 1D = 42 días; el job solo ve 7. Afirmar "no disparó" sería inventarse
    // 35 días que nadie ha mirado.
    const r = evaluateShadowTrade({
      conditionalSetup: cond({ validity_candles: 42, tf_execution: '1D' }),
      candles: velas(T0, Array(30).fill([98, 96])),
      tMs: T0, primaryTf: '4h', now: T0 + 8 * 24 * HOUR,
    });
    expect(r.outcome).toBe('truncated');
    expect(r.expiry_ms).toBe(T0 + 42 * 24 * HOUR);
    expect(r.expiry_ms).toBeGreaterThan(T0 + SHADOW_MAX_WINDOW_MS);
  });

  test('un tp1 dentro de los 7d se resuelve aunque la vigencia sea más larga', () => {
    const r = evaluateShadowTrade({
      conditionalSetup: cond({ validity_candles: 42, tf_execution: '1D' }),
      candles: velas(T0, [[101, 99], [111, 105]]),
      tMs: T0, primaryTf: '4h', now: T0 + 8 * 24 * HOUR,
    });
    expect(r.outcome).toBe('tp1');   // no se degrada a 'truncated': ya está resuelto
  });

  test('sin velas = fallo TRANSITORIO → preserve, nunca invalid', () => {
    const r = evaluar({ candles: [] });
    expect(r.preserve).toBe(true);
    expect(r.outcome).toBe('open');
  });

  test('la entrada se evalúa con la MISMA regla que el setup real: tocar intravela', () => {
    // Una sola vela cuyo rango contiene la entrada exacta.
    const r = evaluar({ candles: velas(T0, [[100, 100]]) });
    expect(r.filled).toBe(1);
  });
});

describe('summarizeShadowTrades — denominadores', () => {
  // `now` inyectado muy por delante: por defecto todas las filas tienen la vigencia
  // vencida, salvo donde el test la ponga a prueba explícitamente.
  const AHORA = T0 + 60 * 24 * HOUR;
  const sum = (filas, o = {}) => summarizeShadowTrades(filas, { now: AHORA, ...o });

  const fila = (cond_outcome, over = {}) => ({
    id: Math.random().toString(36).slice(2),
    coin: 'SOL', primary_tf: '4h',
    timestamp: new Date(T0 + (over.h ?? 0) * HOUR).toISOString(),
    conditional_setup: JSON.stringify(cond(over.cs ?? {})),
    cond_outcome,
    cond_filled: ['tp1', 'stop', 'expired'].includes(cond_outcome) ? 1 : 0,
    ...over.extra,
  });

  test('trigger_rate excluye open/truncated/invalid del denominador', () => {
    const s = sum([
      fila('tp1', { h: 0 }), fila('stop', { h: 8 }), fila('not_triggered', { h: 16 }),
      fila('open', { h: 24 }), fila('truncated', { h: 32 }), fila('invalid', { h: 40 }),
    ]);
    expect(s.n).toBe(6);
    expect(s.conclusive_n).toBe(3);            // tp1 + stop + not_triggered
    expect(s.triggered_n).toBe(2);
    expect(s.trigger_rate_pct).toBe(66.7);
  });

  test('CENSURA: un condicional aún vigente no cuenta, aunque ya tenga resultado', () => {
    // El sesgo que esto evita: el que dispara se resuelve en la 1ª hora y el que no
    // dispara tarda toda su vigencia (24h aquí), así que contar por "tener resultado"
    // llenaría el denominador de disparados y subiría la tasa sin que el mercado cambie.
    const filas = [fila('tp1', { h: 0 }), fila('not_triggered', { h: 0 })];
    const enCurso = summarizeShadowTrades(filas, { now: T0 + 2 * HOUR });
    expect(enCurso.evaluated_n).toBe(2);
    expect(enCurso.pending_n).toBe(2);
    expect(enCurso.n).toBe(0);
    expect(enCurso.trigger_rate_pct).toBeNull();   // sin denominador aún

    const vencida = sum(filas);                    // ya pasada la vigencia de 24h
    expect(vencida.pending_n).toBe(0);
    expect(vencida.trigger_rate_pct).toBe(50);
  });

  test('un invalid es terminal desde el primer ciclo: no espera a ninguna vigencia', () => {
    const s = summarizeShadowTrades([fila('invalid', { h: 0 })], { now: T0 + HOUR });
    expect(s.pending_n).toBe(0);
    expect(s.invalid).toBe(1);
    expect(s.conclusive_n).toBe(0);                // fuera de todo denominador
  });

  test('win_rate solo sobre tp1+stop, y con el gate de muestra mínima compartido', () => {
    const s = sum([fila('tp1'), fila('stop', { h: 8 }), fila('expired', { h: 16 })]);
    expect(s.resolved_n).toBe(2);              // el caducado no es ni win ni loss
    expect(s.sample_insufficient).toBe(true);
    expect(s.win_rate).toBeNull();             // n=2 < MIN_DIRECTIONAL_SAMPLE
    expect(s.min_directional_sample).toBe(20);
  });

  test('con muestra suficiente reporta win_rate + IC de Wilson', () => {
    const filas = [];
    for (let i = 0; i < 30; i++) filas.push(fila(i < 18 ? 'tp1' : 'stop', { h: i * 8 }));
    const s = sum(filas);
    expect(s.sample_insufficient).toBe(false);
    expect(s.win_rate).toBe(60);
    expect(s.win_rate_ci_low).toBeLessThan(60);
    expect(s.win_rate_ci_high).toBeGreaterThan(60);
  });

  test('las filas sin evaluar (cond_outcome null) no entran en ningún denominador', () => {
    const s = sum([
      fila('tp1'), { id: 'x', cond_outcome: null, timestamp: new Date(T0).toISOString() },
    ]);
    expect(s.n).toBe(1);
    expect(s.evaluated_n).toBe(1);
  });

  test('de-dup por episodio: dos análisis de la misma vela 4h cuentan como uno', () => {
    // +1h y +2h caen en la misma vela de 4h que T0 (08:05 UTC → vela de 08:00).
    const s = sum([fila('tp1', { h: 0 }), fila('stop', { h: 1 })]);
    expect(s.n).toBe(2);
    expect(s.by_episode.n).toBe(1);
  });

  test('segmenta por dirección leyendo la geometría, no la etiqueta', () => {
    const corto = { cs: { direction: 'short', entry_price: 72, stop_price: 74, tp1_price: 68 } };
    const s = sum([
      fila('tp1', { h: 0 }), fila('stop', { h: 8, ...corto }), fila('tp1', { h: 16, ...corto }),
    ]);
    expect(s.by_direction.long.n).toBe(1);
    expect(s.by_direction.short.n).toBe(2);
    expect(s.by_direction.short.tp1).toBe(1);
  });

  test('sin vigencia declarada la ventana es la de 7d (mismo fail-open que el evaluador)', () => {
    const sinVig = { cs: { validity_candles: null, tf_execution: null } };
    expect(summarizeShadowTrades([fila('tp1', sinVig)], { now: T0 + 3 * 24 * HOUR }).n).toBe(0);
    expect(summarizeShadowTrades([fila('tp1', sinVig)], { now: T0 + 8 * 24 * HOUR }).n).toBe(1);
  });

  test('la regla de llenado viaja con la cifra (es más permisiva que el gatillo)', () => {
    const s = sum([fila('tp1')]);
    expect(s.fill_rule).toBe('touch_entry_intrabar');
    expect(s.fill_rule_note).toMatch(/no se parsea/);
  });
});

/**
 * TASA BASE DEL GATILLO + EXPECTATIVA (2026-08-01).
 *
 * `trigger_rate_pct` era un número suelto — la misma clase de cifra que era `offered_pct`
 * antes de `OPPORTUNITY_BASE_RATE`. Y `win_rate` sin R:R tampoco es interpretable: con R:R
 * 1,77 el equilibrio está en el 36,2 %, así que un 40 % gana dinero y un 33 % lo pierde.
 */
describe('normalizedTriggerDistance — el eje de la tasa base', () => {
  const base = {
    entryPrice: 102, priceAtAnalysis: 100, atrPct: 1.0,
    validityCandles: 4, tfExecution: '4h', primaryTf: '4h',
  };

  test('d = distancia% / (ATR% × √velas)', () => {
    // 2 % de distancia, ATR 1 %, 4 velas → 2 / (1 × 2) = 1.0
    expect(normalizedTriggerDistance(base)).toBeCloseTo(1.0, 10);
  });

  test('escala con √velas, no linealmente (misma razón que el par de oportunidad)', () => {
    const d4 = normalizedTriggerDistance(base);
    const d16 = normalizedTriggerDistance({ ...base, validityCandles: 16 });
    expect(d16).toBeCloseTo(d4 / 2, 10);   // ×4 velas → ÷2 la distancia normalizada
  });

  test('es simétrica: da igual que la entrada esté arriba o abajo', () => {
    expect(normalizedTriggerDistance({ ...base, entryPrice: 98 }))
      .toBeCloseTo(normalizedTriggerDistance(base), 10);
  });

  test('convierte la vigencia al TF del ATR cuando tf_execution difiere del primario', () => {
    // 4 velas de 1h = 1 vela de 4h. Sin la conversión, √4 en vez de √1 → distancia ÷2.
    const d = normalizedTriggerDistance({ ...base, tfExecution: '1h', validityCandles: 4, primaryTf: '4h' });
    expect(d).toBeCloseTo(2.0, 10);        // 2 / (1 × √1)
  });

  test('sin alguna pieza devuelve null, no un número inventado', () => {
    for (const patch of [{ entryPrice: null }, { atrPct: 0 }, { atrPct: null },
      { priceAtAnalysis: 0 }, { validityCandles: 0 }, { validityCandles: null },
      { primaryTf: 'nope', tfExecution: 'nope' }]) {
      expect(normalizedTriggerDistance({ ...base, ...patch })).toBeNull();
    }
  });
});

describe('triggerBaseRateFor — la curva medida', () => {
  test('devuelve los puntos medidos exactamente', () => {
    expect(triggerBaseRateFor(0.40, 'long')).toBe(TRIGGER_BASE_RATE.points[0.40].long);
    expect(triggerBaseRateFor(0.40, 'short')).toBe(TRIGGER_BASE_RATE.points[0.40].short);
  });

  test('interpola linealmente entre puntos', () => {
    const a = TRIGGER_BASE_RATE.points[0.40].long;
    const b = TRIGGER_BASE_RATE.points[0.50].long;
    expect(triggerBaseRateFor(0.45, 'long')).toBeCloseTo((a + b) / 2, 1);
  });

  test('NO extrapola: fuera de rejilla se ancla al extremo medido', () => {
    expect(triggerBaseRateFor(0.01, 'long')).toBe(TRIGGER_BASE_RATE.points[0.20].long);
    expect(triggerBaseRateFor(99, 'long')).toBe(TRIGGER_BASE_RATE.points[1.25].long);
    expect(triggerBaseRateFor(99, 'long')).toBeGreaterThan(0);   // nunca negativa
  });

  test('es monótona decreciente: más lejos, menos probable', () => {
    for (const dir of ['long', 'short']) {
      const xs = Object.keys(TRIGGER_BASE_RATE.points).map(Number).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        expect(triggerBaseRateFor(xs[i], dir)).toBeLessThan(triggerBaseRateFor(xs[i - 1], dir));
      }
    }
  });

  test('d inutilizable → null', () => {
    for (const d of [null, undefined, NaN, -1]) expect(triggerBaseRateFor(d, 'long')).toBeNull();
  });
});

describe('summarizeShadowTrades — tasa base del gatillo y expectativa', () => {
  const AHORA = T0 + 60 * 24 * HOUR;
  const sum = (filas, o = {}) => summarizeShadowTrades(filas, { now: AHORA, ...o });

  // Fila con la geometría COMPLETA que necesita la distancia normalizada: entrada a 2 %
  // del precio, ATR 1 %, 4 velas de vigencia → d = 2/(1×2) = 1.0.
  const filaGeo = (cond_outcome, over = {}) => ({
    id: Math.random().toString(36).slice(2),
    coin: 'SOL', primary_tf: '4h',
    timestamp: new Date(T0 + (over.h ?? 0) * HOUR).toISOString(),
    price_current: 100,
    atr_pct_at_analysis: 1.0,
    conditional_setup: JSON.stringify(cond({
      entry_price: 102, stop_price: 100.98, tp1_price: 104.04, validity_candles: 4, ...over.cs,
    })),
    cond_outcome,
    cond_filled: ['tp1', 'stop', 'expired'].includes(cond_outcome) ? 1 : 0,
  });

  test('la tasa base sale de la curva medida, evaluada en la geometría de cada fila', () => {
    const s = sum([filaGeo('tp1'), filaGeo('stop', { h: 8 }), filaGeo('not_triggered', { h: 16 })]);
    // d = 1.0 → punto medido de la tabla para long
    expect(s.trigger_base_rate_pct).toBeCloseTo(TRIGGER_BASE_RATE.points[1.00].long, 1);
    expect(s.trigger_rate_pct).toBe(66.7);
    expect(s.trigger_lift_pct).toBeCloseTo(66.7 - TRIGGER_BASE_RATE.points[1.00].long, 1);
    expect(s.trigger_base_rate_measured_at).toBe(TRIGGER_BASE_RATE.measured_at);
  });

  test('la tasa base promedia geometrías distintas, no usa una constante global', () => {
    // Una fila cerca (d≈0.2 → ~74 %) y otra lejos (d=1.0 → ~15 %): la media debe caer entre medias.
    // Geometría COHERENTE: mover solo la entrada dejaría el stop del lado equivocado y la
    // fila saldría `direction_mismatch` (que es lo que hace el código, y está bien).
    const cerca = filaGeo('tp1', { cs: { entry_price: 100.4, stop_price: 99.4, tp1_price: 102.4 } });
    const lejos = filaGeo('not_triggered', { h: 8 });                  // d = 1.0
    const s = sum([cerca, lejos]);
    const esperado = (TRIGGER_BASE_RATE.points[0.20].long + TRIGGER_BASE_RATE.points[1.00].long) / 2;
    expect(s.trigger_base_rate_pct).toBeCloseTo(esperado, 1);
  });

  test('sin geometría utilizable la tasa base es null y el lift también (no se inventa)', () => {
    const sinAtr = { ...filaGeo('tp1'), atr_pct_at_analysis: null };
    const s = sum([sinAtr]);
    expect(s.trigger_base_rate_pct).toBeNull();
    expect(s.trigger_lift_pct).toBeNull();
    expect(s.trigger_rate_pct).toBe(100);   // la tasa cruda sigue saliendo
  });

  test('rr_median y breakeven describen la GEOMETRÍA: disponibles sin resultados', () => {
    // entry 102, stop 100.98 (riesgo 1.02), tp 104.04 (recompensa 2.04) → R:R = 2.0
    const s = sum([filaGeo('not_triggered'), filaGeo('not_triggered', { h: 8 })]);
    expect(s.rr_median).toBeCloseTo(2.0, 2);
    expect(s.breakeven_win_rate_pct).toBeCloseTo(100 / 3, 1);   // 1/(1+2) = 33.3 %
    expect(s.resolved_n).toBe(0);                                // sin un solo trade resuelto
  });

  test('expectancy_r = R medio arriesgando 1, y respeta el mismo gate que el win-rate', () => {
    const filas = [];
    for (let i = 0; i < 6; i++) filas.push(filaGeo('tp1', { h: i * 8 }));
    for (let i = 0; i < 4; i++) filas.push(filaGeo('stop', { h: 100 + i * 8 }));
    // 6 aciertos a +2R y 4 fallos a -1R → (6×2 - 4)/10 = +0.8
    const ex = sum(filas).expectancy_r;
    expect(ex.point).toBeCloseTo(0.8, 3);
    expect(ex.n).toBe(10);
    // NO tiene gate de muestra (a diferencia del win-rate): a n=20 el IC seguiría siendo
    // ±0,57R, así que esconderlo hasta ahí solo cambia cuándo empieza a parecer fiable.
    expect(sum(filas, { minSample: 20 }).expectancy_r.point).toBeCloseTo(0.8, 3);
    expect(sum(filas, { minSample: 20 }).win_rate).toBeNull();
  });

  test('el signo de la expectativa separa geometría rentable de ruinosa', () => {
    const gana = [], pierde = [];
    for (let i = 0; i < 4; i++) { gana.push(filaGeo('tp1', { h: i * 8 })); pierde.push(filaGeo('stop', { h: i * 8 })); }
    for (let i = 0; i < 6; i++) { gana.push(filaGeo('stop', { h: 100 + i * 8 })); pierde.push(filaGeo('stop', { h: 100 + i * 8 })); }
    // 4 aciertos / 6 fallos con R:R 2 → (8-6)/10 = +0.2 pese a un win-rate del 40 %
    const g = sum(gana, { minSample: 5 });
    expect(g.win_rate).toBe(40);
    expect(g.expectancy_r.point).toBeGreaterThan(0);    // 40 % > 33,3 % de equilibrio
    expect(g.win_rate).toBeGreaterThan(g.breakeven_win_rate_pct);
    expect(sum(pierde, { minSample: 5 }).expectancy_r.point).toBe(-1);
  });
});

/**
 * La expectativa se devuelve como OBJETO para que el punto no se pueda leer sin su intervalo
 * — misma disciplina que `fill_rule` con `trigger_rate`. Y sin gate de muestra, porque el de
 * 20 está calibrado para una proporción: a n=20 el IC de la expectativa sigue siendo ±0,57R.
 */
describe('expectancyR — la media con su incertidumbre', () => {
  test('sin datos devuelve el hueco explícito, no un cero', () => {
    const e = expectancyR([]);
    expect(e).toEqual({ point: null, ci_low: null, ci_high: null, n: 0, inconclusive: null });
  });

  test('con n=1 da el punto pero NO un intervalo inventado', () => {
    const e = expectancyR([2]);
    expect(e.point).toBe(2);
    expect(e.ci_low).toBeNull();
    expect(e.ci_high).toBeNull();
    expect(e.inconclusive).toBe(true);   // un solo trade nunca concluye
  });

  test('el punto es la media de los múltiplos de R', () => {
    expect(expectancyR([2, 2, -1, -1]).point).toBeCloseTo(0.5, 3);
  });

  test('usa la t de Student, no z: con n pequeño el intervalo es MÁS ancho', () => {
    // 8 valores con dispersión: el margen con t(7)=2.365 supera al de z=1.96 en ~21 %.
    const xs = [1.65, 1.65, 1.65, -1, -1, -1, -1, -1];
    const e = expectancyR(xs);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    const margenZ = 1.959963984540054 * sd / Math.sqrt(xs.length);
    const margenReal = e.ci_high - e.point;
    expect(margenReal).toBeGreaterThan(margenZ);
    expect(margenReal / margenZ).toBeCloseTo(2.365 / 1.96, 1);
  });

  test('`inconclusive` marca que el intervalo cruza cero — el caso real del checkpoint', () => {
    // Mezcla realista a n=8: el signo NO se puede afirmar.
    expect(expectancyR([1.65, 1.65, 1.65, -1, -1, -1, -1, -1]).inconclusive).toBe(true);
    // Todo aciertos: el intervalo se va arriba y el signo sí se afirma.
    const claro = expectancyR([1.6, 1.7, 1.65, 1.6, 1.7, 1.65]);
    expect(claro.inconclusive).toBe(false);
    expect(claro.ci_low).toBeGreaterThan(0);
  });

  test('el intervalo se estrecha con √n, así que n=8 no vale lo que n=50', () => {
    const patron = [1.65, -1];
    const ancho = (veces) => {
      const e = expectancyR(Array.from({ length: veces * 2 }, (_, i) => patron[i % 2]));
      return e.ci_high - e.ci_low;
    };
    expect(ancho(4)).toBeGreaterThan(ancho(25));       // n=8 vs n=50
    expect(ancho(25)).toBeGreaterThan(ancho(85));      // n=50 vs n=170
  });

  test('ignora valores no finitos en vez de propagar NaN', () => {
    expect(expectancyR([2, null, -1, undefined, NaN, 2]).n).toBe(3);
  });
});
