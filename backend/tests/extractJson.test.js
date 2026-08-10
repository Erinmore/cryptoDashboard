/**
 * extractJson.test.js — robustez del parse del output del LLM.
 *
 * Algunos modelos (Sonnet 5) no respetan "JSON puro": añaden preámbulo y/o
 * envuelven el objeto en un bloque markdown ```json ... ```. extractJson lo
 * normaliza antes de JSON.parse. Con JSON puro (Opus) es inofensivo.
 */

import { describe, test, expect } from '@jest/globals';
import { extractJson, assertNarrativeShape } from '../src/services/anthropicService.js';

const obj = { narrative: { text: 'ok' }, executive_summary: 'resumen' };

const fullNarrative = {
  structure_read: 'a', divergences_anomalies: 'a', key_levels_and_liquidity: 'a',
  volatility_and_regime: 'a', cycle_and_macro_read: 'a', scenarios: 'a',
};

describe('extractJson', () => {
  test('JSON puro pasa tal cual', () => {
    const raw = JSON.stringify(obj);
    expect(JSON.parse(extractJson(raw))).toEqual(obj);
  });

  test('preámbulo + fence ```json (caso Sonnet 5)', () => {
    const raw = `Analizando el dataset de ETH...\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
    expect(JSON.parse(extractJson(raw))).toEqual(obj);
  });

  test('fence sin etiqueta de lenguaje', () => {
    const raw = `texto previo\n\`\`\`\n${JSON.stringify(obj)}\n\`\`\`\ntexto posterior`;
    expect(JSON.parse(extractJson(raw))).toEqual(obj);
  });

  test('preámbulo + JSON sin fence (primer { a último })', () => {
    const raw = `Aquí está tu análisis:\n${JSON.stringify(obj)}`;
    expect(JSON.parse(extractJson(raw))).toEqual(obj);
  });

  test('sin JSON devuelve la cadena tal cual (JSON.parse fallará aguas arriba)', () => {
    expect(extractJson('no hay json aqui')).toBe('no hay json aqui');
  });

  test('} espurio en prosa posterior no rompe el recorte (escaneo balanceado)', () => {
    // El slice(first,last) greedy incluía la } de la prosa → JSON.parse fallaba.
    const raw = `${JSON.stringify(obj)}\n\nNota: vigila el nivel } como referencia.`;
    expect(JSON.parse(extractJson(raw))).toEqual(obj);
  });

  test('} dentro de un string del narrative se ignora', () => {
    const withBrace = { narrative: { text: 'cierra } y sigue' }, executive_summary: 'x' };
    const raw = `preámbulo\n${JSON.stringify(withBrace)}\ntrailing`;
    expect(JSON.parse(extractJson(raw))).toEqual(withBrace);
  });
});

describe('assertNarrativeShape', () => {
  test('narrative + executive_summary completos no lanza', () => {
    expect(() => assertNarrativeShape({ narrative: fullNarrative, executive_summary: 'x' })).not.toThrow();
  });

  test('falta executive_summary → AppError 502', () => {
    expect(() => assertNarrativeShape({ narrative: fullNarrative })).toThrow(/executive_summary/);
  });

  test('falta un campo de narrative → AppError 502', () => {
    const { scenarios, ...bad } = fullNarrative;
    expect(() => assertNarrativeShape({ narrative: bad, executive_summary: 'x' })).toThrow(/narrative\.scenarios/);
  });

  test('narrative ausente por completo → AppError 502', () => {
    expect(() => assertNarrativeShape({ executive_summary: 'x' })).toThrow(/narrative/);
  });
});
