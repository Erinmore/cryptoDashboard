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
import { summarizeShadowTrades } from '../src/utils/stats.js';

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
