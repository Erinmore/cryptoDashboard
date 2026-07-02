/**
 * analysisValidator.test.js — validador determinista del output del LLM (Fase 1).
 *
 * Patrón: para cada regla, un caso válido (sin warning) y un caso de violación.
 */

import { describe, test, expect } from '@jest/globals';
import { validateAnalysis } from '../src/services/analysisValidator.js';

// Baseline totalmente válido: Esperar neutro, sin setup.
const base = (over = {}) => ({
  action: 'Esperar',
  confidence: 'Media',
  risk_score: 5,
  conviction: 0.4,
  primary_driver: 'derivatives',
  has_executable_setup: false,
  gating_active: false,
  gating_reason: null,
  contradictions_found: false,
  scores: { derivatives: 0, structure: 0, volume: 0, onchain: 0, total: 0 },
  setup: null,
  executive_summary: 'ok',
  ...over,
});

// Setup long válido coherente con Comprar.
const longSetup = { entry_price: 100, stop_price: 95, tp1_price: 110, tp2_price: 120, validity_candles: 8, tf_execution: '4h' };
const buyValid = base({
  action: 'Comprar',
  scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 },
  has_executable_setup: true,
  setup: longSetup,
});

const rules = (structured) => validateAnalysis(structured).warnings.map(w => w.rule);

describe('validateAnalysis — baseline y estructura', () => {
  test('Esperar neutro no genera warnings', () => {
    const { warnings, hasSevere } = validateAnalysis(base());
    expect(warnings).toEqual([]);
    expect(hasSevere).toBe(false);
  });

  test('Comprar bien fundamentado no genera warnings', () => {
    const { warnings, hasSevere } = validateAnalysis(buyValid);
    expect(warnings).toEqual([]);
    expect(hasSevere).toBe(false);
  });

  test('structured null → severe', () => {
    const { warnings, hasSevere } = validateAnalysis(null);
    expect(hasSevere).toBe(true);
    expect(warnings[0].rule).toBe('structured_present');
  });
});

describe('validateAnalysis — enums', () => {
  test('action inválida → severe action_enum', () => {
    expect(rules(base({ action: 'Hold' }))).toContain('action_enum');
    expect(validateAnalysis(base({ action: 'Hold' })).hasSevere).toBe(true);
  });

  test('confidence inválida → minor confidence_enum', () => {
    expect(rules(base({ confidence: 'High' }))).toContain('confidence_enum');
  });
});

describe('validateAnalysis — rangos', () => {
  test('conviction fuera de [0,1]', () => {
    expect(rules(base({ conviction: 1.5 }))).toContain('conviction_range');
    expect(rules(base({ conviction: 0.5 }))).not.toContain('conviction_range');
  });

  test('risk_score no entero o fuera de [1,10]', () => {
    expect(rules(base({ risk_score: 0 }))).toContain('risk_score_range');
    expect(rules(base({ risk_score: 11 }))).toContain('risk_score_range');
    expect(rules(base({ risk_score: 5.5 }))).toContain('risk_score_range');
  });

  test('score de componente fuera de [-2,+2]', () => {
    const r = rules(base({ scores: { derivatives: 3, structure: 0, volume: 0, onchain: 0, total: 0 } }));
    expect(r).toContain('score_derivatives_range');
  });
});

describe('validateAnalysis — gating', () => {
  test('gating_active=true con action!=Esperar → severe', () => {
    const bad = base({ gating_active: true, action: 'Comprar', scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 } });
    const { warnings, hasSevere } = validateAnalysis(bad);
    expect(warnings.map(w => w.rule)).toContain('gating_forces_wait');
    expect(hasSevere).toBe(true);
  });

  test('gating_active=true con Esperar → ok', () => {
    expect(rules(base({ gating_active: true, action: 'Esperar' }))).not.toContain('gating_forces_wait');
  });
});

describe('validateAnalysis — puertas Comprar/Vender', () => {
  test('Comprar sin derivatives>=+1 y volume>=+1 → severe buy_gate', () => {
    const bad = base({ action: 'Comprar', scores: { derivatives: 0, structure: 1, volume: 1, onchain: 0, total: 0.6 } });
    expect(rules(bad)).toContain('buy_gate');
    expect(validateAnalysis(bad).hasSevere).toBe(true);
  });

  test('Vender sin derivatives<=-1 y volume<=-1 → severe sell_gate', () => {
    const bad = base({ action: 'Vender', scores: { derivatives: -1, structure: -1, volume: 0, onchain: 0, total: -0.8 } });
    expect(rules(bad)).toContain('sell_gate');
  });

  test('Vender bien fundamentado no dispara sell_gate', () => {
    const ok = base({ action: 'Vender', scores: { derivatives: -2, structure: -1, volume: -1, onchain: 0, total: -1.3 } });
    expect(rules(ok)).not.toContain('sell_gate');
  });
});

describe('validateAnalysis — coherencia de setup', () => {
  test('has_executable_setup=false pero setup presente → minor', () => {
    expect(rules(base({ has_executable_setup: false, setup: longSetup }))).toContain('setup_should_be_null');
  });

  test('has_executable_setup=true pero setup null → minor', () => {
    expect(rules(base({ has_executable_setup: true, setup: null }))).toContain('setup_missing');
  });

  test('Comprar con setup short (stop>entry) → severe setup_action_dir', () => {
    const bad = base({
      action: 'Comprar',
      scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 },
      has_executable_setup: true,
      setup: { entry_price: 100, stop_price: 105, tp1_price: 90, tp2_price: 80, validity_candles: 8, tf_execution: '4h' },
    });
    expect(rules(bad)).toContain('setup_action_dir');
    expect(validateAnalysis(bad).hasSevere).toBe(true);
  });

  test('setup long con tp1 por debajo de entry → minor setup_tp_side', () => {
    const bad = base({
      action: 'Preparar',
      has_executable_setup: true,
      setup: { entry_price: 100, stop_price: 95, tp1_price: 98, tp2_price: 110, validity_candles: 8, tf_execution: '4h' },
    });
    expect(rules(bad)).toContain('setup_tp_side');
  });
});

describe('validateAnalysis — signo de scores.total', () => {
  test('total positivo con todos los componentes <=0 → minor total_sign', () => {
    const bad = base({ scores: { derivatives: 0, structure: -1, volume: -1, onchain: 0, total: 1.2 } });
    expect(rules(bad)).toContain('total_sign');
  });

  test('total coherente no dispara total_sign', () => {
    const ok = base({ scores: { derivatives: 1, structure: 1, volume: 0, onchain: 0, total: 1.1 } });
    expect(rules(ok)).not.toContain('total_sign');
  });
});
