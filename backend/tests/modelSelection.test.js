/**
 * modelSelection.test.js — whitelist de modelos de análisis.
 *
 * El modelo llega del frontend (desplegable) en POST /api/analyze; resolveModel
 * lo valida contra ANALYSIS_MODELS y cae al default si no es válido — nunca deja
 * pasar un id arbitrario a la API de pago.
 */

import { describe, test, expect } from '@jest/globals';
import { resolveModel, buildLlmRequest } from '../src/services/anthropicService.js';
import { DEFAULT_ANALYSIS_MODEL } from '../src/config/constants.js';
import env from '../src/config/env.js';

describe('resolveModel (whitelist)', () => {
  test('id válido → esa entrada', () => {
    expect(resolveModel('claude-sonnet-5').id).toBe('claude-sonnet-5');
    expect(resolveModel('claude-haiku-4-5').id).toBe('claude-haiku-4-5');
  });

  test('id fuera de la whitelist → default', () => {
    expect(resolveModel('gpt-4-turbo').id).toBe(DEFAULT_ANALYSIS_MODEL);
    expect(resolveModel('claude-opus-4-8-EVIL').id).toBe(DEFAULT_ANALYSIS_MODEL);
  });

  test('undefined/null → default', () => {
    expect(resolveModel(undefined).id).toBe(DEFAULT_ANALYSIS_MODEL);
    expect(resolveModel(null).id).toBe(DEFAULT_ANALYSIS_MODEL);
  });

  test('sólo Sonnet 5 desactiva thinking', () => {
    expect(resolveModel('claude-sonnet-5').disableThinking).toBe(true);
    expect(resolveModel('claude-opus-4-8').disableThinking).toBe(false);
    expect(resolveModel('claude-haiku-4-5').disableThinking).toBe(false);
  });
});

describe('buildLlmRequest — temperature deprecado en modelos actuales (default omitido)', () => {
  const ctx = { coin: 'BTC' };

  test('por defecto ningún modelo envía temperature (deprecado → 400 en la API)', () => {
    expect(env.analysisTemperature).toBeNull();
    for (const id of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(buildLlmRequest(ctx, id).temperature).toBeUndefined();
    }
  });

  test('Sonnet 5 lleva thinking:disabled y omite temperature', () => {
    const req = buildLlmRequest(ctx, 'claude-sonnet-5');
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req.temperature).toBeUndefined();
  });

  test('Opus/Haiku no envían ni thinking ni temperature', () => {
    const opus = buildLlmRequest(ctx, 'claude-opus-4-8');
    expect(opus.thinking).toBeUndefined();
    expect(opus.temperature).toBeUndefined();
  });
});

describe('buildLlmRequest — expected_scores NO llega al LLM (auditoría #2, hallazgo 1)', () => {
  // expected_scores es la guardia de divergencia del validador: si el modelo la viera en
  // el dataset podría copiar el score esperado y anular el chequeo independiente (C2).
  const ctx = {
    coin: 'BTC',
    gating: { veto_long: false, contradictions: [], contradiction_count: 0 },
    expected_scores: { derivatives: { score: -1, basis: ['x'] }, volume: { score: 2, basis: ['y'] } },
  };

  test('el mensaje de usuario no contiene expected_scores pero sí el resto del contexto', () => {
    const content = buildLlmRequest(ctx, 'claude-opus-4-8').messages[0].content;
    expect(content).not.toContain('expected_scores');
    expect(content).toContain('"gating"');
    expect(content).toContain('"coin": "BTC"');
  });

  test('no muta el contexto original (expected_scores sigue disponible para el validador)', () => {
    buildLlmRequest(ctx, 'claude-opus-4-8');
    expect(ctx.expected_scores.volume.score).toBe(2);
  });
});
