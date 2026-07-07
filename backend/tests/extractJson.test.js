/**
 * extractJson.test.js — robustez del parse del output del LLM.
 *
 * Algunos modelos (Sonnet 5) no respetan "JSON puro": añaden preámbulo y/o
 * envuelven el objeto en un bloque markdown ```json ... ```. extractJson lo
 * normaliza antes de JSON.parse. Con JSON puro (Opus) es inofensivo.
 */

import { describe, test, expect } from '@jest/globals';
import { extractJson, assertStructuredShape } from '../src/services/anthropicService.js';

const obj = { structured: { action: 'Esperar' }, narrative: { text: 'ok' } };

const fullStructured = {
  action: 'Esperar', confidence: 'Media', risk_score: 6, conviction: 0.4,
  scores: { derivatives: 0, structure: 0, volume: 0, total: 0 },
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
    const withBrace = { structured: { action: 'Esperar' }, narrative: { text: 'cierra } y sigue' } };
    const raw = `preámbulo\n${JSON.stringify(withBrace)}\ntrailing`;
    expect(JSON.parse(extractJson(raw))).toEqual(withBrace);
  });
});

describe('assertStructuredShape', () => {
  test('structured completo no lanza', () => {
    expect(() => assertStructuredShape(fullStructured)).not.toThrow();
  });

  test('falta un campo de nivel superior → AppError 502', () => {
    const { conviction, ...noConviction } = fullStructured;
    expect(() => assertStructuredShape(noConviction)).toThrow(/conviction/);
  });

  test('falta un score requerido → AppError 502', () => {
    const bad = { ...fullStructured, scores: { derivatives: 0, structure: 0, total: 0 } };
    expect(() => assertStructuredShape(bad)).toThrow(/scores\.volume/);
  });

  test('scores ausente por completo → AppError 502', () => {
    const { scores, ...noScores } = fullStructured;
    expect(() => assertStructuredShape(noScores)).toThrow(/scores/);
  });
});
