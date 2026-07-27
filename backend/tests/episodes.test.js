/**
 * episodes.test.js — agrupación de análisis en episodios (utils/episodes.js).
 *
 * Lo que se protege aquí es el caveat 2 del checkpoint: dos análisis de la misma vela 4h
 * comparten casi todo el input, así que contarlos como dos observaciones independientes
 * estrecha el IC de Wilson por debajo de la incertidumbre real.
 */

import { describe, test, expect } from '@jest/globals';
import { episodeKey, dedupeByEpisode, countEpisodes } from '../src/utils/episodes.js';

const row = (timestamp, over = {}) => ({ timestamp, coin: 'SOL', primary_tf: '4h', ...over });

describe('episodeKey', () => {
  test('dos análisis de la misma vela 4h comparten episodio', () => {
    expect(episodeKey(row('2026-07-27T08:05:00Z')))
      .toBe(episodeKey(row('2026-07-27T11:55:00Z')));
  });

  test('velas 4h distintas → episodios distintos', () => {
    expect(episodeKey(row('2026-07-27T11:55:00Z')))
      .not.toBe(episodeKey(row('2026-07-27T12:05:00Z')));
  });

  test('el TF cambia el tamaño del episodio', () => {
    // Las mismas dos horas caen en velas 1h distintas pero en la misma vela 1D.
    const a = '2026-07-27T08:30:00Z', b = '2026-07-27T09:30:00Z';
    expect(episodeKey(row(a, { primary_tf: '1h' }))).not.toBe(episodeKey(row(b, { primary_tf: '1h' })));
    expect(episodeKey(row(a, { primary_tf: '1D' }))).toBe(episodeKey(row(b, { primary_tf: '1D' })));
  });

  test('monedas distintas nunca comparten episodio', () => {
    expect(episodeKey(row('2026-07-27T08:05:00Z', { coin: 'SOL' })))
      .not.toBe(episodeKey(row('2026-07-27T08:05:00Z', { coin: 'BTC' })));
  });

  test('TF desconocido cae al agrupamiento más fino (1h), no colapsa de más', () => {
    const a = row('2026-07-27T08:30:00Z', { primary_tf: 'raro' });
    const b = row('2026-07-27T09:30:00Z', { primary_tf: 'raro' });
    expect(episodeKey(a)).not.toBe(episodeKey(b));
  });

  test('timestamp inutilizable → null', () => {
    expect(episodeKey({ timestamp: 'no-es-fecha' })).toBeNull();
    expect(episodeKey({})).toBeNull();
  });
});

describe('dedupeByEpisode', () => {
  test('conserva una sola fila por vela del TF primario', () => {
    const rows = [
      row('2026-07-27T08:05:00Z', { id: 'a' }),
      row('2026-07-27T11:55:00Z', { id: 'b' }), // misma vela 4h que 'a'
      row('2026-07-27T12:05:00Z', { id: 'c' }),
    ];
    expect(dedupeByEpisode(rows).map((r) => r.id)).toEqual(['a', 'c']);
  });

  test('se queda con la PRIMERA del episodio aunque llegue desordenada', () => {
    // Elegir por resultado sería seleccionar la muestra a posteriori.
    const rows = [
      row('2026-07-27T11:55:00Z', { id: 'tarde' }),
      row('2026-07-27T08:05:00Z', { id: 'temprano' }),
    ];
    expect(dedupeByEpisode(rows).map((r) => r.id)).toEqual(['temprano']);
  });

  test('devuelve orden cronológico ascendente', () => {
    const rows = [
      row('2026-07-27T20:00:00Z', { id: 'c' }),
      row('2026-07-27T04:00:00Z', { id: 'a' }),
      row('2026-07-27T12:00:00Z', { id: 'b' }),
    ];
    expect(dedupeByEpisode(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  test('una fila con timestamp corrupto se conserva en vez de descartarse', () => {
    const rows = [row('2026-07-27T08:05:00Z', { id: 'ok' }), { timestamp: 'x', id: 'roto' }];
    expect(dedupeByEpisode(rows).map((r) => r.id).sort()).toEqual(['ok', 'roto']);
  });

  test('entradas vacías o no-array → []', () => {
    expect(dedupeByEpisode([])).toEqual([]);
    expect(dedupeByEpisode(null)).toEqual([]);
  });
});

describe('countEpisodes', () => {
  test('n de episodios < n de análisis cuando hay autocorrelación intradía', () => {
    const rows = [
      row('2026-07-27T08:05:00Z'), row('2026-07-27T09:05:00Z'), row('2026-07-27T10:05:00Z'),
      row('2026-07-27T20:05:00Z'),
    ];
    expect(rows).toHaveLength(4);
    expect(countEpisodes(rows)).toBe(2); // dos velas 4h distintas
  });
});
