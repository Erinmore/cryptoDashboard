/**
 * decisionGates.test.js — puertas de decisión post-LLM (applyDecisionGates).
 *
 * Cubre el cableado que hasta ahora solo estaba en el controller (analyze()):
 *  - Hard gates backend-autoritativos (veto + conviction decay) fuerzan Esperar SIEMPRE,
 *    incluso con el fail-safe de observación apagado (regresión del fix §21.1, que quedaba
 *    a merced de ANALYSIS_FAILSAFE_ENABLED).
 *  - Violaciones de reglas del prompt (buy_gate) degradan SOLO con el fail-safe activo.
 */

import { describe, test, expect } from '@jest/globals';
import { applyDecisionGates } from '../src/services/decisionGates.js';

// Comprar bien fundamentado (pasa buy_gate) — el LLM NO reporta gating.
const buyStructured = () => ({
  action: 'Comprar',
  confidence: 'Alta',
  risk_score: 4,
  conviction: 0.7,
  primary_driver: 'derivatives',
  has_executable_setup: true,
  gating_active: false,
  gating_reason: null,
  contradictions_found: false,
  missing_confirmations: [],
  scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 },
  setup: { entry_price: 100, stop_price: 95, tp1_price: 110, tp2_price: 120, validity_candles: 8, tf_execution: '4h' },
  executive_summary: 'Compra clara.',
});

const noGating = { veto_long: false, veto_short: false, veto_reason: null, contradiction_count: 0 };

describe('applyDecisionGates — veto autoritativo', () => {
  test('veto_long + Comprar + fail-safe APAGADO → degrada a Esperar (hard gate)', () => {
    const raw = buyStructured();
    const gating = { veto_long: true, veto_short: false, veto_reason: 'VETO LONG: ...', contradiction_count: 1 };
    const { structured, degraded, hardGate } = applyDecisionGates(raw, gating, /* failsafeEnabled */ false);
    expect(hardGate).toBe(true);
    expect(degraded).toBe(true);
    expect(structured.action).toBe('Esperar');
    expect(structured.has_executable_setup).toBe(false);
    expect(structured.setup).toBeNull();
    expect(structured.gating_active).toBe(true);         // impuesto por el backend
    expect(structured.gating_reason).toBe('VETO LONG: ...');
    expect(structured.fail_safe_rules).toContain('gating_forces_wait');
  });

  test('veto_long + Comprar + fail-safe ENCENDIDO → también Esperar', () => {
    const { structured, degraded } = applyDecisionGates(
      buyStructured(), { ...noGating, veto_long: true, veto_reason: 'r' }, true);
    expect(degraded).toBe(true);
    expect(structured.action).toBe('Esperar');
  });

  test('veto activo pero el LLM ya puso Esperar → no degrada, gating_active persiste', () => {
    const raw = { ...buyStructured(), action: 'Esperar', has_executable_setup: false, setup: null };
    const { structured, degraded, hardGate } = applyDecisionGates(raw, { ...noGating, veto_short: true, veto_reason: 'r' }, false);
    expect(hardGate).toBe(false);
    expect(degraded).toBe(false);
    expect(structured.action).toBe('Esperar');
    expect(structured.gating_active).toBe(true);
  });
});

describe('applyDecisionGates — conviction decay', () => {
  test('contradiction_count=3 + Comprar + fail-safe APAGADO → Esperar (hard gate)', () => {
    const { structured, degraded, hardGate } = applyDecisionGates(
      buyStructured(), { ...noGating, contradiction_count: 3 }, false);
    expect(hardGate).toBe(true);
    expect(degraded).toBe(true);
    expect(structured.action).toBe('Esperar');
    expect(structured.fail_safe_rules).toContain('conviction_decay_forces_wait');
  });

  test('contradiction_count=2 + 6ª contradicción (volume<0 & structure>0) → Esperar', () => {
    const raw = { ...buyStructured(), scores: { derivatives: 1, structure: 1, volume: -1, onchain: 0, total: 0.5 } };
    // Nota: volume=-1 hace fallar buy_gate también, pero con fail-safe apagado eso NO degradaría;
    // aquí degrada por el hard gate del decay (backend 2 + 6ª = 3).
    const { structured, degraded } = applyDecisionGates(raw, { ...noGating, contradiction_count: 2 }, false);
    expect(degraded).toBe(true);
    expect(structured.action).toBe('Esperar');
  });
});

describe('applyDecisionGates — fail-closed por datos ausentes (H2)', () => {
  const insufficient = { ...noGating, data_insufficient: true, missing_inputs: ['open_interest'] };

  test('data_insufficient + Comprar + fail-safe APAGADO → Esperar (hard gate)', () => {
    const { structured, degraded, hardGate } = applyDecisionGates(buyStructured(), insufficient, false, true);
    expect(hardGate).toBe(true);
    expect(degraded).toBe(true);
    expect(structured.action).toBe('Esperar');
    expect(structured.gating_active).toBe(true);
    expect(structured.gating_reason).toMatch(/open_interest/);
  });

  test('data_insufficient pero failClosedOnMissing=false → NO bloquea', () => {
    const { degraded, hardGate } = applyDecisionGates(buyStructured(), insufficient, false, false);
    expect(hardGate).toBe(false);
    expect(degraded).toBe(false);
  });

  test('data_insufficient con acción NO direccional (Esperar) → no aplica', () => {
    const raw = { ...buyStructured(), action: 'Esperar', has_executable_setup: false, setup: null };
    const { hardGate } = applyDecisionGates(raw, insufficient, false, true);
    expect(hardGate).toBe(false);
  });
});

describe('applyDecisionGates — guardia de divergencia de scores (C2)', () => {
  // El backend espera derivados bajistas pero el LLM afirma Comprar con derivatives=+2.
  const expectedBearishDeriv = { derivatives: { score: -1, basis: ['LSR contrarian bear (-1)'] }, volume: { score: 0, basis: [] } };

  // ⚠️ CAMBIO 2026-07-29: el término `derivatives` de la guardia se RETIRÓ. Desde que el
  // backend calcula el Derivatives Score no hay nada que vigilar, y mantenerlo era dañino:
  // `expectedDerivativesScore` usaba otra rúbrica (LSR contrarian, ±1 el 33 % del tiempo por
  // terciles), así que un Comprar legítimo con derivatives=+1 chocaba con expected=-1 →
  // SEVERE → degradado a Esperar. Habría matado ~1 de cada 3 señales direccionales.
  test('divergencia en DERIVATIVES ya NO se vigila (el backend calcula ese score)', () => {
    const { structured, degraded, validation } = applyDecisionGates(
      buyStructured(), noGating, true, true, expectedBearishDeriv);
    expect(validation.warnings.some((w) => w.rule === 'score_divergence_derivatives')).toBe(false);
    expect(degraded).toBe(false);
    expect(structured.action).toBe('Comprar');
  });

  test('la guardia de VOLUME sí sigue viva (ahí el LLM sigue puntuando)', () => {
    const expectedBearishVol = { volume: { score: -1, basis: ['CVD bajista alineado (-1)'] } };
    const { structured, degraded, validation } = applyDecisionGates(
      buyStructured(), noGating, true, true, expectedBearishVol);
    expect(validation.warnings.some((w) => w.rule === 'score_divergence_volume')).toBe(true);
    expect(degraded).toBe(true);
    expect(structured.action).toBe('Esperar');
  });

  test('sin expectedScores → no evalúa divergencia (retrocompatible)', () => {
    const { validation } = applyDecisionGates(buyStructured(), noGating, true, true, null);
    expect(validation.warnings.some((w) => w.rule?.startsWith('score_divergence'))).toBe(false);
  });

  test('scores del LLM alineados con lo esperado → sin divergencia', () => {
    const aligned = { derivatives: { score: 2, basis: [] }, volume: { score: 1, basis: [] } };
    const { validation, degraded } = applyDecisionGates(buyStructured(), noGating, true, true, aligned);
    expect(validation.warnings.some((w) => w.rule?.startsWith('score_divergence'))).toBe(false);
    expect(degraded).toBe(false);
  });
});

describe('applyDecisionGates — fail-safe de observación (reglas del prompt, no hard gate)', () => {
  test('buy_gate violado + sin veto/decay + fail-safe APAGADO → NO degrada (output crudo)', () => {
    // Comprar con volume=0 (no pasa buy_gate) pero sin veto ni decay: es una violación de regla
    // del prompt, gobernada por el flag. Apagado → se preserva el crudo para observación.
    const raw = { ...buyStructured(), scores: { derivatives: 2, structure: 1, volume: 0, onchain: 0, total: 1 } };
    const { structured, degraded, hardGate } = applyDecisionGates(raw, noGating, false);
    expect(hardGate).toBe(false);
    expect(degraded).toBe(false);
    expect(structured.action).toBe('Comprar');
  });

  test('mismo caso con fail-safe ENCENDIDO → degrada a Esperar', () => {
    const raw = { ...buyStructured(), scores: { derivatives: 2, structure: 1, volume: 0, onchain: 0, total: 1 } };
    const { structured, degraded } = applyDecisionGates(raw, noGating, true);
    expect(degraded).toBe(true);
    expect(structured.action).toBe('Esperar');
    expect(structured.fail_safe_rules).toContain('buy_gate');
  });

  test('Comprar limpio, sin veto/decay → no degrada en ningún modo', () => {
    expect(applyDecisionGates(buyStructured(), noGating, false).degraded).toBe(false);
    expect(applyDecisionGates(buyStructured(), noGating, true).degraded).toBe(false);
  });
});

describe('applyDecisionGates — fail-closed cubre Preparar accionable (auditoría #2, hallazgo 5)', () => {
  const gatingInsufficient = {
    veto_long: false, veto_short: false, veto_reason: null,
    data_insufficient: true, missing_inputs: ['cvd_1d'], contradiction_count: 0,
  };

  test('data_insufficient + Preparar CON setup ejecutable → degradado a Esperar', () => {
    const raw = {
      action: 'Preparar', confidence: 'Media', risk_score: 5, conviction: 0.5,
      has_executable_setup: true, gating_active: false,
      scores: { derivatives: 1, structure: 0, volume: 0, onchain: 0, total: 0.5 },
      setup: { entry_price: 105, stop_price: 100, tp1_price: 115 },
    };
    const r = applyDecisionGates(raw, gatingInsufficient, false, true);
    expect(r.hardGate).toBe(true);
    expect(r.structured.action).toBe('Esperar');
    expect(r.structured.setup).toBeNull();
  });

  test('data_insufficient + Preparar SIN setup → no se bloquea', () => {
    const raw = {
      action: 'Preparar', confidence: 'Media', risk_score: 5, conviction: 0.5,
      has_executable_setup: false, gating_active: false,
      scores: { derivatives: 1, structure: 0, volume: 0, onchain: 0, total: 0.5 },
      setup: null,
    };
    const r = applyDecisionGates(raw, gatingInsufficient, false, true);
    expect(r.hardGate).toBe(false);
    expect(r.structured.action).toBe('Preparar');
  });
});

describe('applyDecisionGates — Derivatives Score autoritativo (F1, 2026-07-29)', () => {
  // El prompt ordena COPIAR derivatives_score.score en scores.derivatives, pero las puertas
  // validan contra la copia. Estos tests cubren la sobrescritura autoritativa: sin ella una
  // copia infiel contaminaría la muestra en silencio en ambos sentidos.

  const ds = (score) => ({ score, data_insufficient: false, basis: [], components: {} });

  test('copia inflada (LLM +1, backend 0): sobrescribe → buy_gate cae → degradado', () => {
    const raw = { ...buyStructured(), scores: { derivatives: 1, structure: 1, volume: 1, onchain: 0, total: 1 } };
    const r = applyDecisionGates(raw, noGating, true, true, null, null, ds(0));
    expect(r.structured.action).toBe('Esperar');            // sin respaldo determinista no hay Comprar
    expect(r.degraded).toBe(true);
    expect(r.validation.warnings.map((w) => w.rule)).toEqual(
      expect.arrayContaining(['derivatives_copy_mismatch', 'buy_gate']),
    );
    const mm = r.validation.warnings.find((w) => w.rule === 'derivatives_copy_mismatch');
    expect(mm.severity).toBe('minor');
  });

  test('copia desinflada (LLM 0 en Esperar, backend +1): sobrescribe sin degradar', () => {
    const raw = {
      action: 'Esperar', confidence: 'Media', risk_score: 5, conviction: 0.5,
      has_executable_setup: false, gating_active: false, setup: null,
      scores: { derivatives: 0, structure: 0, volume: 0, onchain: 0, total: 0 },
    };
    const r = applyDecisionGates(raw, noGating, true, true, null, null, ds(1));
    expect(r.structured.action).toBe('Esperar');
    expect(r.degraded).toBe(false);
    // La columna score_derivatives persistirá el valor verdadero del backend, no la copia.
    expect(r.structured.scores.derivatives).toBe(1);
    expect(r.validation.warnings.some((w) => w.rule === 'derivatives_copy_mismatch')).toBe(true);
  });

  test('copia fiel: sin warning y sin mutación', () => {
    const raw = { ...buyStructured(), scores: { derivatives: 2, structure: 1, volume: 1, onchain: 0, total: 1.3 } };
    const r = applyDecisionGates(raw, noGating, true, true, null, null, ds(2));
    expect(r.structured.action).toBe('Comprar');
    expect(r.validation.warnings.some((w) => w.rule === 'derivatives_copy_mismatch')).toBe(false);
  });

  test('sin derivatives_score en contexto (null): comportamiento anterior intacto', () => {
    const raw = buyStructured(); // derivatives: 2 del LLM
    const r = applyDecisionGates(raw, noGating, true, true, null, null, null);
    expect(r.structured.action).toBe('Comprar');
    expect(r.structured.scores.derivatives).toBe(2);
    expect(r.validation.warnings.some((w) => w.rule === 'derivatives_copy_mismatch')).toBe(false);
  });

  test('un Comprar legítimo respaldado por el backend NO se toca (anti-regresión)', () => {
    const raw = { ...buyStructured(), scores: { derivatives: 1, structure: 1, volume: 1, onchain: 0, total: 1 } };
    const r = applyDecisionGates(raw, noGating, true, true, null, null, ds(1));
    expect(r.structured.action).toBe('Comprar');
    expect(r.degraded).toBe(false);
    expect(r.validation.warnings).toHaveLength(0);
  });
});
