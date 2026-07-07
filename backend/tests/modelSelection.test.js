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

describe('buildLlmRequest — temperatura fijada (C1, reproducibilidad)', () => {
  const ctx = { coin: 'BTC' };

  test('todos los modelos llevan temperature = env.analysisTemperature (default 0)', () => {
    expect(env.analysisTemperature).toBe(0);
    for (const id of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(buildLlmRequest(ctx, id).temperature).toBe(0);
    }
  });

  test('Sonnet 5 combina thinking:disabled con temperature 0 (ninguno activa thinking)', () => {
    const req = buildLlmRequest(ctx, 'claude-sonnet-5');
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req.temperature).toBe(0);
  });

  test('Opus/Haiku no envían thinking pero sí temperature', () => {
    const opus = buildLlmRequest(ctx, 'claude-opus-4-8');
    expect(opus.thinking).toBeUndefined();
    expect(opus.temperature).toBe(0);
  });
});
