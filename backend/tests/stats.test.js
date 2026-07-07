/**
 * stats.test.js — intervalo de Wilson para el win-rate (auditoría C5).
 */

import { describe, test, expect } from '@jest/globals';
import { wilsonInterval } from '../src/utils/stats.js';

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
