/**
 * pathMetrics.test.js — funciones puras de recorrido del precio (utils/pathMetrics.js).
 *
 * Fase 5: son la base del backtest falsable para `Esperar`, así que lo que se comprueba
 * aquí no es solo "devuelve un número" sino las decisiones de diseño que hacen que el
 * número signifique algo: la convención temporal (cierre de vela), el orden entre el
 * recorrido favorable y el adverso, y que sin ATR no se invente una escala.
 */

import { describe, test, expect } from '@jest/globals';
import {
  computeExcursions,
  computeFirstPassage,
  computeAtrPct,
  computePathMetrics,
  ATR_MULTIPLES,
} from '../src/utils/pathMetrics.js';

const HOUR = 3600 * 1000;
const T0 = 1_700_000_000_000;

/** Genera velas horarias a partir de pares [high, low], desde T0. */
function candles(pairs, tStart = T0) {
  return pairs.map(([high, low], i) => ({
    t: tStart + i * HOUR,
    open: low, close: high, high, low,
    volume: 1,
  }));
}

describe('computeExcursions', () => {
  test('captura el máximo al alza y a la baja de la ventana', () => {
    const c = candles([[101, 99], [105, 100], [102, 95]]);
    const r = computeExcursions(c, 100, T0, 24 * HOUR);
    expect(r.max_up_pct).toBe(5);    // 105 sobre 100
    expect(r.max_down_pct).toBe(-5); // 95 sobre 100
  });

  test('reporta el CIERRE de la vela del extremo, no su apertura', () => {
    // El máximo está en la vela índice 1, que abre en T0+1h y cierra en T0+2h.
    const c = candles([[101, 99], [105, 100], [102, 100]]);
    const r = computeExcursions(c, 100, T0, 24 * HOUR);
    expect(r.t_max_up_h).toBe(2);
  });

  test('excursión al alza NEGATIVA si el precio nunca superó el baseline', () => {
    // Deliberado: distingue "no hubo recorrido favorable" de un 0 ambiguo.
    const c = candles([[98, 95], [97, 94]]);
    const r = computeExcursions(c, 100, T0, 24 * HOUR);
    expect(r.max_up_pct).toBe(-2);
    expect(r.max_down_pct).toBe(-6);
  });

  test('ignora las velas fuera de la ventana', () => {
    // El 105 cae en la hora 30 → fuera de la ventana de 24h.
    const pairs = Array.from({ length: 31 }, (_, i) => (i === 30 ? [105, 100] : [101, 99]));
    const r = computeExcursions(candles(pairs), 100, T0, 24 * HOUR);
    expect(r.max_up_pct).toBe(1);
  });

  test('ignora velas anteriores al análisis', () => {
    const c = candles([[200, 190], [101, 99]], T0 - HOUR);
    const r = computeExcursions(c, 100, T0, 24 * HOUR);
    expect(r.max_up_pct).toBe(1); // la vela de 200 es previa al análisis
  });

  test('datos inválidos o ventana vacía → null', () => {
    expect(computeExcursions(candles([[101, 99]]), null, T0, HOUR)).toBeNull();
    expect(computeExcursions(candles([[101, 99]]), 0, T0, HOUR)).toBeNull();
    expect(computeExcursions([], 100, T0, HOUR)).toBeNull();
  });
});

describe('computeFirstPassage', () => {
  test('registra la PRIMERA vela que cruza cada múltiplo, no la del máximo', () => {
    // ATR% = 1 → niveles al alza: 100.5, 101, 101.5, 102, 103, 104.
    // La vela 0 cruza 0.5× y 1×; la vela 2 cruza hasta 3×.
    const c = candles([[101, 99.8], [100.2, 100], [103.5, 100]]);
    const r = computeFirstPassage(c, 100, 1, T0, 7 * 24 * HOUR);
    expect(r.up['0.5']).toBe(1); // cierre de la vela 0
    expect(r.up['1']).toBe(1);
    expect(r.up['1.5']).toBe(3); // cierre de la vela 2
    expect(r.up['3']).toBe(3);
    expect(r.up['4']).toBeNull(); // 104 nunca se alcanzó
  });

  test('el orden favorable/adverso queda resuelto por las horas', () => {
    // Baja 2×ATR en la hora 1 y sube 2×ATR en la hora 3: el adverso llegó antes.
    const c = candles([[100.1, 98], [100.1, 99.9], [102.5, 100]]);
    const r = computeFirstPassage(c, 100, 1, T0, 7 * 24 * HOUR);
    expect(r.down['2']).toBe(1);
    expect(r.up['2']).toBe(3);
    expect(r.down['2']).toBeLessThan(r.up['2']);
  });

  test('cruce al alza y a la baja en la MISMA vela → misma hora (ambigüedad conocida)', () => {
    // El high y el low de una vela no vienen ordenados: el desempate no es de esta capa.
    const c = candles([[103, 97]]);
    const r = computeFirstPassage(c, 100, 1, T0, 7 * 24 * HOUR);
    expect(r.up['2']).toBe(1);
    expect(r.down['2']).toBe(1);
  });

  test('sin ATR válido → null (no se inventa una escala de volatilidad)', () => {
    const c = candles([[110, 90]]);
    expect(computeFirstPassage(c, 100, null, T0, 24 * HOUR)).toBeNull();
    expect(computeFirstPassage(c, 100, 0, T0, 24 * HOUR)).toBeNull();
    expect(computeFirstPassage(c, 100, -1, T0, 24 * HOUR)).toBeNull();
  });

  test('devuelve la rejilla usada, para que el consumidor no la asuma', () => {
    const r = computeFirstPassage(candles([[101, 99]]), 100, 1, T0, 24 * HOUR);
    expect(r.multiples).toEqual(ATR_MULTIPLES);
    expect(r.atr_pct).toBe(1);
    expect(Object.keys(r.up)).toHaveLength(ATR_MULTIPLES.length);
  });

  test('un ATR mayor exige más recorrido para el mismo múltiplo', () => {
    const c = candles([[102, 98]]);
    const conAtr1 = computeFirstPassage(c, 100, 1, T0, 24 * HOUR);
    const conAtr3 = computeFirstPassage(c, 100, 3, T0, 24 * HOUR);
    expect(conAtr1.up['2']).toBe(1);     // necesita 102 → cruzado
    expect(conAtr3.up['2']).toBeNull();  // necesitaría 106 → no
  });
});

describe('computeAtrPct', () => {
  test('normaliza el ATR contra el último cierre', () => {
    const atrFn = () => 2;
    expect(computeAtrPct(candles([[101, 99]]), atrFn)).toBe(1.98); // 2/101, no 2/100
  });

  test('null si el ATR o el cierre no son utilizables', () => {
    expect(computeAtrPct(candles([[101, 99]]), () => null)).toBeNull();
    expect(computeAtrPct(candles([[101, 99]]), () => NaN)).toBeNull();
    expect(computeAtrPct([], () => 2)).toBeNull();
    expect(computeAtrPct(candles([[101, 99]]), null)).toBeNull();
  });
});

describe('computePathMetrics', () => {
  test('los máximos de 24h y 7d son independientes', () => {
    // Sube 1% el primer día y 10% el sexto: el máximo de 24h no lo acota el de 7d.
    const pairs = Array.from({ length: 24 * 7 }, (_, i) => (i === 140 ? [110, 100] : [101, 99]));
    const r = computePathMetrics({ candles: candles(pairs), priceAt: 100, atrPct: 1, tMs: T0 });
    expect(r.max_up_pct_24h).toBe(1);
    expect(r.max_up_pct_7d).toBe(10);
  });

  test('el horizonte de 24h se filtra en lectura sobre los primeros cruces', () => {
    const pairs = Array.from({ length: 24 * 7 }, (_, i) => (i === 140 ? [110, 100] : [101, 99]));
    const r = computePathMetrics({ candles: candles(pairs), priceAt: 100, atrPct: 1, tMs: T0 });
    // 5×ATR se cruza en la hora 141 → fuera de 24h, pero registrado en la ventana de 7d.
    expect(r.path_first_passage.up['4']).toBe(141);
    expect(r.path_first_passage.up['1']).toBe(1); // dentro de 24h
  });

  test('sin ATR se conservan las excursiones y se pierde solo la rejilla', () => {
    const r = computePathMetrics({ candles: candles([[105, 95]]), priceAt: 100, atrPct: null, tMs: T0 });
    expect(r.max_up_pct_24h).toBe(5);
    expect(r.max_down_pct_24h).toBe(-5);
    expect(r.path_first_passage).toBeNull();
  });

  test('sin velas todo queda a null sin lanzar', () => {
    const r = computePathMetrics({ candles: [], priceAt: 100, atrPct: 1, tMs: T0 });
    expect(r.max_up_pct_7d).toBeNull();
    expect(r.t_max_up_h).toBeNull();
    expect(r.path_first_passage).toBeNull();
  });
});
