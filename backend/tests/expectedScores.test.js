/**
 * expectedScores.test.js — score direccional esperado por el backend (guardia C2, total B2).
 *
 * Coarse por diseño: solo detecta el signo/dirección aproximada para cazar divergencias
 * flagrantes del LLM. No replica la ponderación fina del prompt.
 */

import { describe, test, expect } from '@jest/globals';
import {
  expectedDerivativesScore, expectedVolumeScore, backendScoreTotal, computeExpectedScores,
} from '../src/utils/expectedScores.js';

describe('expectedDerivativesScore', () => {
  test('funding negativo extremo → +2 (short squeeze)', () => {
    const r = expectedDerivativesScore({ funding_rate: { severity_negative: 'extreme_short_overload' } });
    expect(r.score).toBe(2);
  });

  test('funding positivo high → -1 (longs sobre-apalancados)', () => {
    expect(expectedDerivativesScore({ funding_rate: { severity: 'high' } }).score).toBe(-1);
  });

  test('LSR contrarian bear → -1', () => {
    const r = expectedDerivativesScore({ long_short_ratio: { signal: 'longs_dominant_contrarian_bear' } });
    expect(r.score).toBe(-1);
  });

  test('LSR contrarian bull + funding negativo alto → +2 (clamp)', () => {
    const r = expectedDerivativesScore({
      funding_rate: { severity_negative: 'high_short_overload' },
      long_short_ratio: { signal: 'shorts_dominant_contrarian_bull' },
    });
    expect(r.score).toBe(2);
  });

  test('sin datos → 0', () => {
    expect(expectedDerivativesScore(null).score).toBe(0);
    expect(expectedDerivativesScore({}).score).toBe(0);
  });
});

describe('expectedVolumeScore', () => {
  test('buy_pressure alta → score positivo', () => {
    expect(expectedVolumeScore({ buy_pressure_pct: 66 }, null).score).toBe(2);
    expect(expectedVolumeScore({ buy_pressure_pct: 58 }, null).score).toBe(1);
  });

  test('sell pressure → score negativo', () => {
    expect(expectedVolumeScore({ buy_pressure_pct: 34 }, null).score).toBe(-2);
  });

  test('equilibrio (49.6) → 0', () => {
    expect(expectedVolumeScore({ buy_pressure_pct: 49.6 }, null).score).toBe(0);
  });

  test('imbalance del order book ajusta', () => {
    const up = expectedVolumeScore({ buy_pressure_pct: 55 }, { imbalance_signal: 'buy_pressure' });
    const down = expectedVolumeScore({ buy_pressure_pct: 45 }, { imbalance_signal: 'sell_pressure' });
    expect(up.score).toBeGreaterThanOrEqual(1);
    expect(down.score).toBeLessThanOrEqual(-1);
  });
});

describe('backendScoreTotal (B2 — reproducible)', () => {
  test('determinista desde los componentes del LLM', () => {
    const t = backendScoreTotal({ derivatives: 2, volume: 1, structure: 1, onchain: 0 });
    // 0.35*2 + 0.30*1 + 0.25*1 + 0.10*0 = 1.25 (pesos suman 1)
    expect(t).toBeCloseTo(1.25, 2);
  });

  test('renormaliza si falta on-chain (alts)', () => {
    const t = backendScoreTotal({ derivatives: 2, volume: 2, structure: 2 }); // sin onchain
    expect(t).toBeCloseTo(2, 2); // todos +2 → total +2 pese a faltar onchain
  });

  test('sin componentes válidos → null', () => {
    expect(backendScoreTotal({})).toBeNull();
    expect(backendScoreTotal(null)).toBeNull();
  });
});

describe('computeExpectedScores', () => {
  test('extrae volume_delta del TF primario y devuelve ambos bloques', () => {
    const ctx = {
      derivatives: { funding_rate: { severity_negative: 'extreme_short_overload' }, long_short_ratio: {} },
      technical: { '4h': { volume_delta: { buy_pressure_pct: 60 } } },
      order_book: { imbalance_signal: 'buy_pressure' },
    };
    const r = computeExpectedScores(ctx, '4h');
    expect(r.derivatives.score).toBe(2);
    expect(r.volume.score).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r.derivatives.basis)).toBe(true);
  });
});
