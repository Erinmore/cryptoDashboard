/**
 * analysisValidator.test.js — validador determinista del output del LLM (Fase 1).
 *
 * Patrón: para cada regla, un caso válido (sin warning) y un caso de violación.
 */

import { describe, test, expect } from '@jest/globals';
import { validateAnalysis, applyFailSafe } from '../src/services/analysisValidator.js';

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

describe('validateAnalysis — conviction decay (>=3 contradicciones)', () => {
  const rulesWith = (structured, count) =>
    validateAnalysis(structured, { backendContradictionCount: count }).warnings.map(w => w.rule);

  test('backendContradictionCount>=3 con action!=Esperar → severe', () => {
    const bad = base({ action: 'Comprar', scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 } });
    const { warnings, hasSevere } = validateAnalysis(bad, { backendContradictionCount: 3 });
    expect(warnings.map(w => w.rule)).toContain('conviction_decay_forces_wait');
    expect(hasSevere).toBe(true);
  });

  test('la 6ª contradicción (volume<0 & structure>0) cierra el conteo a 3', () => {
    // backend cuenta 2; el LLM aporta la 6ª (volume<0 con structure>0) → total 3 → dispara.
    const bad = base({ action: 'Comprar', scores: { derivatives: 1, structure: 1, volume: -1, onchain: 0, total: 0.5 } });
    expect(rulesWith(bad, 2)).toContain('conviction_decay_forces_wait');
  });

  test('sin la 6ª, backend=2 no llega al umbral', () => {
    const bad = base({ action: 'Comprar', scores: { derivatives: 1, structure: 1, volume: 1, onchain: 0, total: 1 } });
    expect(rulesWith(bad, 2)).not.toContain('conviction_decay_forces_wait');
  });

  test('total>=3 pero action=Esperar → no dispara (ya cumple)', () => {
    expect(rulesWith(base({ action: 'Esperar' }), 5)).not.toContain('conviction_decay_forces_wait');
  });

  test('sin opts (llamada de un solo arg) → nunca dispara decay', () => {
    const bad = base({ action: 'Comprar', scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 } });
    expect(validateAnalysis(bad).warnings.map(w => w.rule)).not.toContain('conviction_decay_forces_wait');
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

describe('validateAnalysis — cotas de sanidad del setup (H6, minor)', () => {
  test('entry lejos del precio → setup_entry_far', () => {
    const far = base({
      action: 'Comprar', has_executable_setup: true,
      scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 },
      setup: { entry_price: 120, stop_price: 115, tp1_price: 130, tp2_price: 140 },
    });
    // precio 100, entry 120 → 20% de distancia.
    const w = validateAnalysis(far, { currentPrice: 100 }).warnings.map((x) => x.rule);
    expect(w).toContain('setup_entry_far');
  });

  test('R:R < 1 → setup_low_rr', () => {
    const poor = base({
      action: 'Comprar', has_executable_setup: true,
      scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 },
      setup: { entry_price: 100, stop_price: 90, tp1_price: 103, tp2_price: 106 }, // risk 10, reward 3
    });
    expect(validateAnalysis(poor, { currentPrice: 100 }).warnings.map((x) => x.rule)).toContain('setup_low_rr');
  });

  test('setup bien calibrado → sin warnings de sanidad', () => {
    const w = validateAnalysis(buyValid, { currentPrice: 100 }).warnings.map((x) => x.rule);
    expect(w).not.toContain('setup_entry_far');
    expect(w).not.toContain('setup_low_rr');
  });

  test('sin currentPrice no evalúa distancia de entrada (retrocompatible)', () => {
    const w = validateAnalysis(buyValid).warnings.map((x) => x.rule);
    expect(w).not.toContain('setup_entry_far');
  });
});

describe('applyFailSafe — Fase 2 (degradar a Esperar ante violación severa)', () => {
  test('sin violación severa no altera el structured', () => {
    const s = base();
    const { structured, applied } = applyFailSafe(s, validateAnalysis(s));
    expect(applied).toBe(false);
    expect(structured).toBe(s);          // misma referencia, sin copia
    expect(structured.action).toBe('Esperar');
  });

  test('violación solo-menor NO dispara fail-safe', () => {
    const s = base({ conviction: 1.5 });  // fuera de rango → minor
    const v = validateAnalysis(s);
    expect(v.hasSevere).toBe(false);
    expect(applyFailSafe(s, v).applied).toBe(false);
  });

  test('Comprar sin puerta → degrada a Esperar y neutraliza setup', () => {
    const bad = base({
      action: 'Comprar',
      scores: { derivatives: 0, structure: 1, volume: 1, onchain: 0, total: 0.6 },
      has_executable_setup: true,
      setup: { entry_price: 100, stop_price: 95, tp1_price: 110, tp2_price: 120, validity_candles: 8, tf_execution: '4h' },
      executive_summary: 'Tesis alcista.',
    });
    const { structured, applied } = applyFailSafe(bad, validateAnalysis(bad));
    expect(applied).toBe(true);
    expect(structured.action).toBe('Esperar');
    expect(structured.has_executable_setup).toBe(false);
    expect(structured.setup).toBeNull();
    expect(structured.fail_safe_applied).toBe(true);
    expect(structured.fail_safe_original_action).toBe('Comprar');
    expect(structured.fail_safe_rules).toContain('buy_gate');
    expect(structured.executive_summary).toMatch(/FAIL-SAFE/);
    expect(structured.executive_summary).toContain('Tesis alcista.');  // conserva el resumen original
  });

  test('gating ignorado → degrada a Esperar', () => {
    const bad = base({ gating_active: true, action: 'Vender', scores: { derivatives: -2, structure: -1, volume: -1, onchain: 0, total: -1.3 } });
    const { structured, applied } = applyFailSafe(bad, validateAnalysis(bad));
    expect(applied).toBe(true);
    expect(structured.action).toBe('Esperar');
    expect(structured.fail_safe_rules).toContain('gating_forces_wait');
  });

  test('es puro: no muta el structured de entrada', () => {
    const bad = base({ action: 'Comprar', scores: { derivatives: 0, structure: 0, volume: 0, onchain: 0, total: 0 } });
    applyFailSafe(bad, validateAnalysis(bad));
    expect(bad.action).toBe('Comprar');   // el original intacto
    expect(bad.fail_safe_applied).toBeUndefined();
  });

  test('missing_confirmations vacío → se rellena con el motivo (coherente con Esperar)', () => {
    const bad = base({
      action: 'Comprar',
      scores: { derivatives: 0, structure: 1, volume: 1, onchain: 0, total: 0.6 },
      missing_confirmations: [],  // el LLM dijo "setup ejecutable, no falta nada"
    });
    const { structured } = applyFailSafe(bad, validateAnalysis(bad));
    expect(structured.action).toBe('Esperar');
    expect(structured.missing_confirmations.length).toBeGreaterThan(0);
    expect(structured.missing_confirmations[0]).toContain('buy_gate');
  });

  test('missing_confirmations no vacío → se respeta el del LLM', () => {
    const bad = base({
      action: 'Comprar',
      scores: { derivatives: 0, structure: 1, volume: 1, onchain: 0, total: 0.6 },
      missing_confirmations: ['expansión de Open Interest'],
    });
    const { structured } = applyFailSafe(bad, validateAnalysis(bad));
    expect(structured.missing_confirmations).toEqual(['expansión de Open Interest']);
  });
});
