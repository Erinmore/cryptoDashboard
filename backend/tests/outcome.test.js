/**
 * outcome.test.js — funciones puras de backtesting (utils/outcome.js).
 */

import { describe, test, expect } from '@jest/globals';
import { classifyOutcome, setupExpiryMs, candlesWithinValidity } from '../src/utils/outcome.js';

describe('classifyOutcome', () => {
  test('Comprar con subida → win', () => {
    expect(classifyOutcome('Comprar', 100, 102)).toBe('win');
  });
  test('Comprar con bajada → loss', () => {
    expect(classifyOutcome('Comprar', 100, 98)).toBe('loss');
  });
  test('Vender con bajada → win (a favor del short)', () => {
    expect(classifyOutcome('Vender', 100, 98)).toBe('win');
  });
  test('Vender con subida → loss', () => {
    expect(classifyOutcome('Vender', 100, 102)).toBe('loss');
  });
  test('movimiento dentro de la banda muerta → flat', () => {
    expect(classifyOutcome('Comprar', 100, 100.1)).toBe('flat'); // 0.1% < 0.3%
  });
  test('Esperar con movimiento relevante → moved', () => {
    expect(classifyOutcome('Esperar', 100, 105)).toBe('moved');
  });
  test('Esperar sin movimiento → flat', () => {
    expect(classifyOutcome('Esperar', 100, 100.1)).toBe('flat');
  });
  test('Preparar tratado como no direccional', () => {
    expect(classifyOutcome('Preparar', 100, 110)).toBe('moved');
  });
  test('datos faltantes → null', () => {
    expect(classifyOutcome('Comprar', null, 100)).toBeNull();
    expect(classifyOutcome('Comprar', 100, null)).toBeNull();
    expect(classifyOutcome('Comprar', 0, 100)).toBeNull();
  });
  test('threshold personalizado respeta la banda', () => {
    expect(classifyOutcome('Comprar', 100, 101, 2)).toBe('flat'); // 1% < 2%
    expect(classifyOutcome('Comprar', 100, 103, 2)).toBe('win');  // 3% > 2%
  });
});

// El barrier del setup ejecutable (`evaluateSetupBarrier`) se retiró de la ruta de decisión
// con el pivot a ayudante de riesgo (§REORIENTACIÓN): ningún análisis vuelve a declarar un
// `setup` que evaluar. La función se conserva en utils/outcome.js (dead-but-available, ver
// outcomeService.js) pero su cobertura de test se retira con ella.

// ─────────────────────────────────────────────────────────────────────────────
// Vigencia del setup (2026-07-28) — `setup_validity_candles` se persistía y no lo
// leía nadie: el barrier recorría los 7d completos y acreditaba como `tp1` un TP
// tocado mucho después de que el propio análisis se declarase caducado.
// ─────────────────────────────────────────────────────────────────────────────

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 6, 28, 8, 0, 0);

describe('setupExpiryMs', () => {
  test('4h × 6 velas = 24h desde el análisis', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: 6, tfExecution: '4h' })).toBe(T0 + 24 * H);
  });

  test('tf_execution manda sobre primary_tf', () => {
    // El setup se ejecuta en 1h aunque el análisis sea de 4h → 3h, no 12h.
    expect(setupExpiryMs({ tMs: T0, validityCandles: 3, tfExecution: '1h', primaryTf: '4h' }))
      .toBe(T0 + 3 * H);
  });

  test('cae a primary_tf si no hay tf_execution', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: 2, primaryTf: '1D' })).toBe(T0 + 48 * H);
  });

  test('FAIL-OPEN: sin vigencia utilizable → null (el caller no recorta)', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: null, tfExecution: '4h' })).toBeNull();
    expect(setupExpiryMs({ tMs: T0, validityCandles: 0, tfExecution: '4h' })).toBeNull();
    expect(setupExpiryMs({ tMs: T0, validityCandles: -3, tfExecution: '4h' })).toBeNull();
    expect(setupExpiryMs({ tMs: T0, validityCandles: 'seis', tfExecution: '4h' })).toBeNull();
  });

  test('FAIL-OPEN: TF no reconocido o timestamp inválido → null', () => {
    expect(setupExpiryMs({ tMs: T0, validityCandles: 6, tfExecution: '30m' })).toBeNull();
    expect(setupExpiryMs({ tMs: NaN, validityCandles: 6, tfExecution: '4h' })).toBeNull();
  });
});

describe('candlesWithinValidity', () => {
  const candles = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * H, high: 1, low: 1 }));

  test('recorta a las velas que ABREN antes de la caducidad', () => {
    const r = candlesWithinValidity(candles, T0 + 4 * H);
    expect(r).toHaveLength(4);                    // t = T0, +1h, +2h, +3h
    expect(r.at(-1).t).toBe(T0 + 3 * H);
  });

  test('la vela que abre justo en la caducidad queda FUERA', () => {
    expect(candlesWithinValidity(candles, T0 + 1 * H)).toHaveLength(1);
  });

  test('expiry null → serie intacta (misma referencia, sin copia)', () => {
    expect(candlesWithinValidity(candles, null)).toBe(candles);
  });

  test('serie vacía o no-array → se devuelve tal cual', () => {
    expect(candlesWithinValidity([], T0)).toEqual([]);
    expect(candlesWithinValidity(null, T0)).toBeNull();
  });
});

