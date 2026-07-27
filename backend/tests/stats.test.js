/**
 * stats.test.js — intervalo de Wilson para el win-rate (auditoría C5).
 */

import { describe, test, expect } from '@jest/globals';
import {
  wilsonInterval, classifyOpportunity, maxExcursionAtr,
  classifyPathOutcome, convictionBucket, summarizeOpportunity, OPPORTUNITY_BASE_RATE,
} from '../src/utils/stats.js';

describe('wilsonInterval', () => {
  test('n=0 → todo null', () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: null, low: null, high: null, n: 0 });
  });

  test('muestra pequeña → IC muy ancho (por eso no es concluyente)', () => {
    const r = wilsonInterval(1, 2); // 1/2 = 50%
    expect(r.point).toBe(50);
    expect(r.high - r.low).toBeGreaterThan(60); // banda enorme con n=2
  });

  test('muestra grande → IC estrecho alrededor del punto', () => {
    const r = wilsonInterval(60, 100); // 60%
    expect(r.point).toBe(60);
    expect(r.low).toBeGreaterThan(49);
    expect(r.high).toBeLessThan(70);
  });

  test('wins=0 no colapsa a [0,0] (Wilson no es Wald)', () => {
    const r = wilsonInterval(0, 10);
    expect(r.point).toBe(0);
    expect(r.high).toBeGreaterThan(0); // el límite superior no es 0
    expect(r.low).toBe(0);
  });

  test('todos los límites en [0,100]', () => {
    for (const [w, n] of [[0, 1], [1, 1], [3, 5], [50, 50]]) {
      const r = wilsonInterval(w, n);
      expect(r.low).toBeGreaterThanOrEqual(0);
      expect(r.high).toBeLessThanOrEqual(100);
    }
  });
});

// ─── Fase 5 · coste de oportunidad y win-rate path-aware ─────────────────────

describe('classifyOpportunity', () => {
  /** Fila de outcome con la rejilla de primeros cruces ya hidratada. */
  const fila = (up, down, atr = 1) => ({
    atr_pct_at_analysis: atr,
    path_first_passage: { atr_pct: atr, multiples: [0.5, 1, 1.5, 2, 3, 4], up, down },
  });

  test('recorrido limpio al alza → oportunidad ofrecida', () => {
    const r = classifyOpportunity(fila({ 2: 6 }, {}));
    expect(r.offered).toBe(true);
    expect(r.direction).toBe('up');
    expect(r.hours_to).toBe(6);
  });

  test('adverso ANTES del objetivo → no era operable (era latigazo)', () => {
    // Llegó a +2xATR en la hora 10, pero antes se fue -1xATR en la hora 3.
    const r = classifyOpportunity(fila({ 2: 10 }, { 1: 3 }));
    expect(r.offered).toBe(false);
    expect(r.blocked_by_adverse).toBe(true);
  });

  test('adverso DESPUÉS del objetivo no invalida la oportunidad', () => {
    const r = classifyOpportunity(fila({ 2: 3 }, { 1: 10 }));
    expect(r.offered).toBe(true);
    expect(r.hours_to).toBe(3);
  });

  test('empate en la misma vela → se asume el adverso primero (conservador)', () => {
    const r = classifyOpportunity(fila({ 2: 5 }, { 1: 5 }));
    expect(r.offered).toBe(false);
    expect(r.blocked_by_adverse).toBe(true);
  });

  test('mercado plano → evaluable y sin oportunidad (abstención acertada)', () => {
    const r = classifyOpportunity(fila({}, {}));
    expect(r.evaluable).toBe(true);
    expect(r.offered).toBe(false);
    expect(r.blocked_by_adverse).toBe(false);
  });

  test('sin rejilla → NO evaluable, distinto de "no ofreció"', () => {
    const r = classifyOpportunity({ path_first_passage: null });
    expect(r.evaluable).toBe(false);
    expect(r.offered).toBe(false);
  });

  test('el horizonte descarta lo que llegó demasiado tarde', () => {
    const f = fila({ 2: 100 }, {});
    expect(classifyOpportunity(f).offered).toBe(true);              // ventana 7d
    expect(classifyOpportunity(f, { horizonH: 24 }).offered).toBe(false); // en 24h, no
  });

  test('elige el sentido que llegó antes cuando ambos son limpios', () => {
    const r = classifyOpportunity(fila({ 2: 20 }, { 2: 4 }), { adverseK: 3 });
    expect(r.direction).toBe('down');
    expect(r.hours_to).toBe(4);
  });

  test('acepta el JSON crudo de SQLite', () => {
    const raw = JSON.stringify({ up: { 2: 6 }, down: {} });
    expect(classifyOpportunity({ path_first_passage: raw }).offered).toBe(true);
    expect(classifyOpportunity({ path_first_passage: '{roto' }).evaluable).toBe(false);
  });

  test('un objetivo más exigente reduce las oportunidades contadas', () => {
    const f = fila({ 2: 6, 3: null }, {});
    expect(classifyOpportunity(f, { targetK: 2 }).offered).toBe(true);
    expect(classifyOpportunity(f, { targetK: 3 }).offered).toBe(false);
  });
});

describe('maxExcursionAtr', () => {
  test('normaliza el mayor de los dos lados por el ATR', () => {
    const row = { atr_pct_at_analysis: 2, max_up_pct_24h: 3, max_down_pct_24h: -5 };
    expect(maxExcursionAtr(row)).toBe(2.5); // 5 / 2
  });

  test('sin ATR no hay escala → null', () => {
    expect(maxExcursionAtr({ max_up_pct_24h: 3 })).toBeNull();
    expect(maxExcursionAtr({ atr_pct_at_analysis: 0, max_up_pct_24h: 3 })).toBeNull();
  });

  test('el horizonte selecciona las columnas correctas', () => {
    const row = {
      atr_pct_at_analysis: 1,
      max_up_pct_24h: 2, max_down_pct_24h: -1,
      max_up_pct_7d: 9, max_down_pct_7d: -1,
    };
    expect(maxExcursionAtr(row, '24h')).toBe(2);
    expect(maxExcursionAtr(row, '7d')).toBe(9);
  });
});

describe('classifyPathOutcome', () => {
  const fila = (up, down) => ({ path_first_passage: { up, down } });

  test('Comprar que toca objetivo antes que stop → win', () => {
    expect(classifyPathOutcome('Comprar', fila({ 2: 5 }, { 1: 20 }))).toBe('win');
  });

  test('Comprar que toca el stop antes → loss aunque el precio recupere después', () => {
    // Es justo lo que outcome_24h no ve: mira el destino, no el camino.
    expect(classifyPathOutcome('Comprar', fila({ 2: 20 }, { 1: 3 }))).toBe('loss');
  });

  test('Vender invierte los sentidos', () => {
    expect(classifyPathOutcome('Vender', fila({ 1: 20 }, { 2: 5 }))).toBe('win');
    expect(classifyPathOutcome('Vender', fila({ 1: 3 }, { 2: 20 }))).toBe('loss');
  });

  test('sin resolver por ningún lado → flat', () => {
    expect(classifyPathOutcome('Comprar', fila({}, {}))).toBe('flat');
  });

  test('no direccional o sin rejilla → null', () => {
    expect(classifyPathOutcome('Esperar', fila({ 2: 5 }, {}))).toBeNull();
    expect(classifyPathOutcome('Comprar', { path_first_passage: null })).toBeNull();
  });
});

describe('convictionBucket', () => {
  test('reparte en baja/media/alta', () => {
    expect(convictionBucket(0.3)).toBe('baja');
    expect(convictionBucket(0.4)).toBe('media');
    expect(convictionBucket(0.69)).toBe('media');
    expect(convictionBucket(0.7)).toBe('alta');
  });
  test('valor ausente → null', () => {
    expect(convictionBucket(null)).toBeNull();
    expect(convictionBucket(undefined)).toBeNull();
  });
});

describe('summarizeOpportunity — comparación contra la tasa base', () => {
  const fila = (up, down) => ({
    atr_pct_at_analysis: 1,
    path_first_passage: { up, down },
  });

  test('el lift compara el offered_pct con la tasa base medida', () => {
    // 2 de 4 ofrecen → 50%, contra una base de 34.8% a 24h.
    const rows = [fila({ 2: 5 }, {}), fila({ 2: 6 }, {}), fila({}, {}), fila({}, {})];
    const s = summarizeOpportunity(rows, { horizonH: 24 });
    expect(s.offered_pct).toBe(50);
    expect(s.base_rate_pct).toBe(OPPORTUNITY_BASE_RATE['24h'].pct);
    expect(s.lift_pct).toBeCloseTo(15.2, 1);
  });

  test('el horizonte de 7d se marca como poco discriminante', () => {
    const s = summarizeOpportunity([fila({ 2: 5 }, {})], { horizonH: null });
    expect(s.base_rate_pct).toBe(OPPORTUNITY_BASE_RATE['7d'].pct);
    expect(s.base_rate_discriminates).toBe(false);
  });

  test('con múltiplos NO por defecto no se compara (la base medida no aplica)', () => {
    const s = summarizeOpportunity([fila({ 3: 5 }, {})], { horizonH: 24, targetK: 3 });
    expect(s.base_rate_pct).toBeNull();
    expect(s.lift_pct).toBeNull();
  });

  test('sin filas evaluables no se inventa un lift', () => {
    const s = summarizeOpportunity([{ path_first_passage: null }], { horizonH: 24 });
    expect(s.offered_pct).toBeNull();
    expect(s.lift_pct).toBeNull();
  });
});
