/**
 * timeframeConflicts.test.js — analyzeTimeframeConflicts en analysisController.
 *
 * Regla: solo hay conflicto cuando el TF corto y el largo son AMBOS direccionales y
 * OPUESTOS. 'neutral' NO cuenta como bajista (bug previo: se infería la dirección con
 * !includes('bullish'), que colapsaba neutral→bajista y fabricaba conflictos falsos que
 * llegaban al LLM con un reasoning engañoso).
 */

import { describe, test, expect } from '@jest/globals';
import { analyzeTimeframeConflicts } from '../src/controllers/analysisController.js';

const tech = (t1h, t1D) => ({ '1h': { trend: t1h }, '4h': { trend: t1h }, '1D': { trend: t1D }, '1W': { trend: t1D } });

describe('analyzeTimeframeConflicts', () => {
  test('corto neutral + largo alcista → SIN conflicto (antes: falso short_bearish)', () => {
    const r = analyzeTimeframeConflicts(tech('neutral', 'bullish'), '4h');
    expect(r.conflict).toBeNull();
  });

  test('corto alcista + largo neutral → SIN conflicto', () => {
    const r = analyzeTimeframeConflicts(tech('bullish', 'neutral'), '4h');
    expect(r.conflict).toBeNull();
  });

  test('corto alcista + largo bajista → conflicto short_bullish_long_bearish', () => {
    const r = analyzeTimeframeConflicts(tech('strongly_bullish', 'bearish'), '4h');
    expect(r.conflict).toBe('short_term_bullish_long_term_bearish');
  });

  test('corto bajista + largo alcista → conflicto short_bearish_long_bullish', () => {
    const r = analyzeTimeframeConflicts(tech('bearish', 'strongly_bullish'), '4h');
    expect(r.conflict).toBe('short_term_bearish_long_term_bullish');
  });

  test('ambos alcistas → sin conflicto', () => {
    const r = analyzeTimeframeConflicts(tech('bullish', 'strongly_bullish'), '4h');
    expect(r.conflict).toBeNull();
  });

  test('ambos neutral → sin conflicto', () => {
    const r = analyzeTimeframeConflicts(tech('neutral', 'neutral'), '4h');
    expect(r.conflict).toBeNull();
  });

  test('technical vacío → null', () => {
    expect(analyzeTimeframeConflicts({}, '4h')).toBeNull();
  });
});
