/**
 * levelStrength.test.js — computeLevelDistances en analysisController.
 *
 * Verifica que además de la distancia % al nivel más cercano se expone su `strength`
 * (touches del nivel, escala 0-5 de calculateSupportResistance). El soporte/resistencia
 * más cercano es siempre supports[0] / resistances[0] (ya ordenados en el indicador).
 */

import { describe, test, expect } from '@jest/globals';
import { computeLevelDistances, supertrendLevel, volumeVs30dMedian } from '../src/controllers/analysisController.js';

describe('computeLevelDistances — strength del nivel más cercano', () => {
  const price = 100;
  const supports = [
    { price: 98, touches: 6, strength: 3 },   // más cercano (supports[0])
    { price: 90, touches: 2, strength: 1 },
  ];
  const resistances = [
    { price: 104, touches: 8, strength: 4 },  // más cercana (resistances[0])
    { price: 120, touches: 3, strength: 1 },
  ];

  test('distancia % + strength del nivel más cercano', () => {
    const r = computeLevelDistances(price, supports, resistances);
    expect(r.distance_to_nearest_support_pct).toBe(2);      // (100-98)/100*100
    expect(r.distance_to_nearest_resistance_pct).toBe(4);   // (104-100)/100*100
    expect(r.nearest_support_strength).toBe(3);
    expect(r.nearest_resistance_strength).toBe(4);
  });

  test('sin niveles → distancias y strengths null (sin crash)', () => {
    const r = computeLevelDistances(price, [], []);
    expect(r.distance_to_nearest_support_pct).toBeNull();
    expect(r.distance_to_nearest_resistance_pct).toBeNull();
    expect(r.nearest_support_strength).toBeNull();
    expect(r.nearest_resistance_strength).toBeNull();
  });

  test('nivel sin campo strength → strength null (no undefined)', () => {
    const r = computeLevelDistances(price, [{ price: 99, touches: 1 }], []);
    expect(r.distance_to_nearest_support_pct).toBe(1);
    expect(r.nearest_support_strength).toBeNull();
  });

  test('arrays undefined → todo null (guard defensivo)', () => {
    const r = computeLevelDistances(price, undefined, undefined);
    expect(r.nearest_support_strength).toBeNull();
    expect(r.nearest_resistance_strength).toBeNull();
  });
});

describe('supertrendLevel — nivel numérico según dirección', () => {
  test('tendencia UP → usa el soporte (banda inferior)', () => {
    expect(supertrendLevel({ trend: 'UP', support: 95.5, resistance: null })).toBe(95.5);
  });

  test('tendencia DOWN → usa la resistencia (banda superior)', () => {
    expect(supertrendLevel({ trend: 'DOWN', support: null, resistance: 104.2 })).toBe(104.2);
  });

  test('null / banda ausente → null (sin crash)', () => {
    expect(supertrendLevel(null)).toBeNull();
    expect(supertrendLevel({ trend: 'UP', support: null, resistance: null })).toBeNull();
  });
});

describe('volumeVs30dMedian (v8_0) — participación normalizada contra el propio activo', () => {
  const velas = (vols) => vols.map((volume, i) => ({ t: i, open: 1, high: 1, low: 1, close: 1, volume }));

  test('un día normal da ~1.0', () => {
    expect(volumeVs30dMedian(velas(Array(31).fill(100)))).toBe(1);
  });

  test('el doble de lo habitual da ~2.0', () => {
    expect(volumeVs30dMedian(velas([...Array(30).fill(100), 200]))).toBe(2);
  });

  test('usa la MEDIANA, así que un pico aislado no distorsiona la referencia', () => {
    // Con media, el 5000 de un solo día inflaría la base y taparía el día alto real.
    const v = [...Array(29).fill(100), 5000, 200];
    expect(volumeVs30dMedian(velas(v))).toBe(2);
  });

  test('excluye el día en curso del cálculo de la mediana', () => {
    // Si el propio día contara en su referencia, el ratio tendería artificialmente a 1.
    expect(volumeVs30dMedian(velas([...Array(30).fill(10), 100]))).toBe(10);
  });

  test('datos insuficientes o corruptos → null (no se inventa la referencia)', () => {
    expect(volumeVs30dMedian(velas([100, 200]))).toBeNull();
    expect(volumeVs30dMedian(null)).toBeNull();
    expect(volumeVs30dMedian(velas(Array(31).fill(0)))).toBeNull(); // mediana 0
  });
});
