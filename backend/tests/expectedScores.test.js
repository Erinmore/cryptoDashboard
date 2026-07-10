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

describe('expectedVolumeScore (CVD del TF primario + carve-out de absorción)', () => {
  test('CVD alineado al alza: strong → +2, moderate → +1', () => {
    expect(expectedVolumeScore({ trend: 'rising', divergence: 'none', cvd_strength: 'strong' }).score).toBe(2);
    expect(expectedVolumeScore({ trend: 'rising', divergence: 'none', cvd_strength: 'moderate' }).score).toBe(1);
  });

  test('CVD alineado a la baja: strong → -2, moderate → -1 (capitulación/distribución)', () => {
    expect(expectedVolumeScore({ trend: 'falling', divergence: 'none', cvd_strength: 'strong' }).score).toBe(-2);
    expect(expectedVolumeScore({ trend: 'falling', divergence: 'none', cvd_strength: 'moderate' }).score).toBe(-1);
  });

  test('CARVE-OUT: divergencia (absorción) → 0 aunque el CVD caiga con fuerza', () => {
    // precio↑ + CVD↓ = absorción ALCISTA según el prompt: la guardia NO debe penalizarlo.
    expect(expectedVolumeScore({ trend: 'falling', divergence: 'bearish', cvd_strength: 'strong' }).score).toBe(0);
    expect(expectedVolumeScore({ trend: 'rising', divergence: 'bullish', cvd_strength: 'strong' }).score).toBe(0);
  });

  test('marginal / sin strength → 0 (ruido de fondo)', () => {
    expect(expectedVolumeScore({ trend: 'falling', divergence: 'none', cvd_strength: 'marginal' }).score).toBe(0);
    expect(expectedVolumeScore({ trend: 'rising', divergence: 'none', cvd_strength: null }).score).toBe(0);
  });

  test('source=heuristic → magnitud limitada a ±1 (sin taker real)', () => {
    expect(expectedVolumeScore({ trend: 'falling', divergence: 'none', cvd_strength: 'strong', source: 'heuristic' }).score).toBe(-1);
    expect(expectedVolumeScore({ trend: 'rising', divergence: 'none', cvd_strength: 'strong', source: 'taker_real' }).score).toBe(2);
  });

  test('sin CVD → 0', () => {
    expect(expectedVolumeScore(null).score).toBe(0);
  });

  test('trend=flat alineado → 0', () => {
    expect(expectedVolumeScore({ trend: 'flat', divergence: 'none', cvd_strength: 'strong' }).score).toBe(0);
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
  test('extrae el CVD del TF primario y devuelve ambos bloques', () => {
    const ctx = {
      derivatives: { funding_rate: { severity_negative: 'extreme_short_overload' }, long_short_ratio: {} },
      technical: { '4h': { cvd: { trend: 'rising', divergence: 'none', cvd_strength: 'moderate', source: 'taker_real' } } },
    };
    const r = computeExpectedScores(ctx, '4h');
    expect(r.derivatives.score).toBe(2);
    expect(r.volume.score).toBe(1);
    expect(Array.isArray(r.derivatives.basis)).toBe(true);
  });
});
