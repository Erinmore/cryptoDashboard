/**
 * outcome.test.js — funciones puras de backtesting (utils/outcome.js).
 */

import { describe, test, expect } from '@jest/globals';
import { classifyOutcome, evaluateSetupBarrier } from '../src/utils/outcome.js';

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

describe('evaluateSetupBarrier — long (stop < entry)', () => {
  const setup = { entry_price: 100, stop_price: 95, tp1_price: 105, tp2_price: 110 };

  test('toca TP1 y luego TP2 → tp2', () => {
    const candles = [
      { high: 103, low: 99 },
      { high: 106, low: 102 }, // TP1
      { high: 111, low: 107 }, // TP2
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('tp2');
    expect(r.hit_tp1).toBe(true);
    expect(r.hit_tp2).toBe(true);
    expect(r.hit_stop).toBe(false);
  });

  test('toca el stop antes que TP → stop', () => {
    const candles = [
      { high: 102, low: 99 },
      { high: 103, low: 94 }, // stop
      { high: 106, low: 101 },
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('stop');
    expect(r.hit_stop).toBe(true);
    expect(r.hit_tp1).toBe(false);
  });

  test('TP1 y stop en la misma vela → conservador: stop primero', () => {
    const candles = [{ high: 106, low: 94 }];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('stop');
  });

  test('tras TP1 ignora el stop (break-even) → se queda en tp1', () => {
    const candles = [
      { high: 106, low: 102 }, // TP1
      { high: 107, low: 93 },  // caería al stop, pero ya se ignora
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('tp1');
    expect(r.hit_tp1).toBe(true);
    expect(r.hit_stop).toBe(false);
  });

  test('sin tocar nada → open', () => {
    const candles = [{ high: 103, low: 98 }, { high: 104, low: 99 }];
    expect(evaluateSetupBarrier(setup, candles).outcome).toBe('open');
  });
});

describe('evaluateSetupBarrier — short (stop > entry)', () => {
  const setup = { entry_price: 100, stop_price: 105, tp1_price: 95, tp2_price: 90 };

  test('precio baja a TP1 y TP2 → tp2', () => {
    const candles = [
      { high: 101, low: 97 },
      { high: 99, low: 94 },  // TP1
      { high: 96, low: 89 },  // TP2
    ];
    const r = evaluateSetupBarrier(setup, candles);
    expect(r.outcome).toBe('tp2');
  });

  test('precio sube al stop → stop', () => {
    const candles = [{ high: 106, low: 99 }];
    expect(evaluateSetupBarrier(setup, candles).outcome).toBe('stop');
  });
});

describe('evaluateSetupBarrier — validación', () => {
  test('setup inválido (stop == entry) → null', () => {
    expect(evaluateSetupBarrier({ entry_price: 100, stop_price: 100 }, [{ high: 1, low: 1 }])).toBeNull();
  });
  test('sin velas → null', () => {
    expect(evaluateSetupBarrier({ entry_price: 100, stop_price: 95 }, [])).toBeNull();
  });
});
