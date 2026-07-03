/**
 * extractJson.test.js — robustez del parse del output del LLM.
 *
 * Algunos modelos (Sonnet 5) no respetan "JSON puro": añaden preámbulo y/o
 * envuelven el objeto en un bloque markdown ```json ... ```. extractJson lo
 * normaliza antes de JSON.parse. Con JSON puro (Opus) es inofensivo.
 */

import { describe, test, expect } from '@jest/globals';
import { extractJson } from '../src/services/anthropicService.js';

const obj = { structured: { action: 'Esperar' }, narrative: { text: 'ok' } };

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
});
