/**
 * percentiles.test.js — auto-normalización de umbrales (auditoría de umbrales 2026-07-26).
 *
 * Cubre la utilidad pura y los cuatro consumidores que se recalibraron: cvd_strength,
 * régimen de mercado, techo del umbral de cercanía y generador de S/R.
 */

import { describe, test, expect } from '@jest/globals';
import { quantile, percentileRank, rollingSums, bucketByPercentile } from '../src/utils/percentiles.js';
import { calculateCVD, calculateSupportResistance, detectMarketRegime } from '../src/utils/indicators.js';

// Vela sintética con taker_buy controlable (para dirigir el CVD).
const candle = (close, { high = close + 1, low = close - 1, volume = 100, buyFrac = 0.5 } = {}) => ({
  t: 0, open: close, high, low, close, volume, taker_buy_base: volume * buyFrac,
});

describe('quantile / percentileRank / rollingSums', () => {
  test('quantile interpola linealmente y respeta los extremos', () => {
    const xs = [1, 2, 3, 4, 5];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(5);
    expect(quantile(xs, 0.5)).toBe(3);
    expect(quantile(xs, 0.25)).toBe(2);
  });

  test('quantile ignora no-finitos y no muta la entrada', () => {
    const xs = [3, NaN, 1, undefined, 2];
    expect(quantile(xs, 0.5)).toBe(2);
    expect(xs[0]).toBe(3); // sin ordenar in-place
  });

  test('quantile con muestra vacía → null', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([NaN], 0.5)).toBeNull();
  });

  test('percentileRank devuelve la fracción por debajo', () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(50);
    expect(percentileRank([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileRank([1, 2, 3, 4], 99)).toBe(100);
  });

  test('rollingSums desliza en O(n) y devuelve n-w+1 elementos', () => {
    expect(rollingSums([1, 2, 3, 4, 5], 2)).toEqual([3, 5, 7, 9]);
    expect(rollingSums([1, 2, 3], 3)).toEqual([6]);
    expect(rollingSums([1, 2], 5)).toEqual([]); // ventana mayor que la serie
  });
});

describe('bucketByPercentile', () => {
  const sample = Array.from({ length: 100 }, (_, i) => i); // 0..99

  test('reparte por terciles de la propia distribución', () => {
    expect(bucketByPercentile(10, sample).label).toBe('low');
    expect(bucketByPercentile(50, sample).label).toBe('mid');
    expect(bucketByPercentile(90, sample).label).toBe('high');
  });

  test('expone percentil y cortes vigentes (trazabilidad de la calibración)', () => {
    const r = bucketByPercentile(50, sample);
    expect(r.percentile).toBeCloseTo(50, 0);
    expect(r.cuts).toHaveLength(2);
    expect(r.cuts[0]).toBeLessThan(r.cuts[1]);
  });

  test('muestra insuficiente → null en vez de inventar un corte', () => {
    expect(bucketByPercentile(5, [1, 2, 3]).label).toBeNull();
    expect(bucketByPercentile(5, [1, 2, 3]).percentile).toBeNull();
  });

  // El riesgo intrínseco de un umbral relativo: en un mercado muerto, el tercio superior
  // de casi nada seguiría etiquetándose como "alto". El suelo absoluto lo impide.
  test('el suelo absoluto gana al percentil: un mercado plano no genera señales fuertes', () => {
    const flat = Array.from({ length: 50 }, (_, i) => 0.001 * i); // todo diminuto
    const sinSuelo = bucketByPercentile(0.045, flat);
    expect(sinSuelo.label).toBe('high');

    const conSuelo = bucketByPercentile(0.045, flat, { absoluteFloor: 1 });
    expect(conSuelo.label).toBe('low');
    expect(conSuelo.percentile).toBeGreaterThan(60); // el percentil sigue siendo alto
  });

  test('respeta etiquetas personalizadas', () => {
    const r = bucketByPercentile(90, sample, { labels: ['marginal', 'moderate', 'strong'] });
    expect(r.label).toBe('strong');
  });
});

describe('T3 · cvd_strength auto-normalizado', () => {
  // Serie con desequilibrio comprador creciente: el final debe destacar sobre su historia.
  const rampa = Array.from({ length: 120 }, (_, i) =>
    candle(100 + i * 0.1, { buyFrac: i > 100 ? 0.95 : 0.5 }));

  test('devuelve etiqueta, percentil y cortes derivados de la propia serie', () => {
    const cvd = calculateCVD(rampa);
    expect(['marginal', 'moderate', 'strong']).toContain(cvd.cvd_strength);
    expect(cvd.cvd_strength_pctile).toBeGreaterThanOrEqual(0);
    expect(cvd.cvd_strength_cuts).toHaveLength(2);
  });

  test('un desequilibrio comprador extremo al final sale como strong', () => {
    expect(calculateCVD(rampa).cvd_strength).toBe('strong');
  });

  test('serie equilibrada → marginal por el suelo absoluto, no por percentil', () => {
    const plana = Array.from({ length: 120 }, () => candle(100, { buyFrac: 0.5 }));
    const cvd = calculateCVD(plana);
    expect(cvd.cvd_strength).toBe('marginal');
  });
});

// T5 (techo del umbral de cercanía, `dynamicNearLevelPct`) se retiró con `utils/gating.js`
// en el pivot a ayudante de riesgo (§REORIENTACIÓN): sin veto ni contradicciones que gatear,
// no queda ningún consumidor de "cuán cerca está el precio de un nivel fuerte".

describe('T4 · S/R sobre pivotes con ancla fija', () => {
  // Onda de periodo 6: con lookback=2 los picos y valles son extremos locales ESTRICTOS,
  // así que producen pivotes. (Un zigzag que alterna cada vela NO los produce: los vecinos
  // a ±2 empatan y la comparación es estricta — comportamiento correcto, no un bug.)
  const onda = [];
  for (let i = 0; i < 120; i++) {
    const phase = i % 6;
    const base = phase === 0 ? 110 : phase === 3 ? 100 : 105;
    onda.push(candle(base, { high: base + 0.2, low: base - 0.2 }));
  }

  test('un nivel visitado muchas veces acumula toques y strength', () => {
    const { supports, resistances } = calculateSupportResistance(onda, 100, 1, 0.005);
    const all = [...supports, ...resistances];
    const top = all.sort((a, b) => b.touches - a.touches)[0];
    expect(top.touches).toBeGreaterThan(3);
    expect(top.strength).toBe(Math.min(Math.floor(top.touches / 2), 5));
  });

  // La prueba de no-encadenamiento: los pivotes están en 100 y 110 exactos. Con el ancla
  // móvil anterior un cluster podía derivar y acabar representando un precio intermedio
  // que nunca fue tocado; con ancla fija cada nivel se queda pegado a su banda real.
  test('los niveles caen sobre los pivotes reales, no en un punto intermedio derivado', () => {
    const { supports, resistances } = calculateSupportResistance(onda, 100, 1, 0.005);
    for (const lv of [...supports, ...resistances]) {
      const cercaDe100 = Math.abs(lv.price - 100) / 100 <= 0.01;
      const cercaDe110 = Math.abs(lv.price - 110) / 110 <= 0.01;
      expect(cercaDe100 || cercaDe110).toBe(true);
    }
  });

  test('una tendencia monótona no produce niveles: no hay pivotes que agrupar', () => {
    const rampa = Array.from({ length: 120 }, (_, i) => candle(100 + i * 0.05));
    const { supports, resistances } = calculateSupportResistance(rampa, 100, 1, 0.005);
    expect([...supports, ...resistances]).toHaveLength(0);
  });

  test('supports quedan por debajo del precio y resistances por encima', () => {
    const { supports, resistances } = calculateSupportResistance(onda, 100, 1, 0.005);
    const price = onda[onda.length - 1].close;
    for (const s of supports) expect(s.price).toBeLessThan(price);
    for (const r of resistances) expect(r.price).toBeGreaterThanOrEqual(price);
  });

  test('ventana sin velas suficientes no rompe', () => {
    expect(calculateSupportResistance([], 100, 1, 0.005)).toEqual({ supports: [], resistances: [] });
  });
});

describe('T1 · high_volatility exige percentil ALTO y expansión real', () => {
  test('mercado plano NO es alta volatilidad aunque su ATR esté en el decil superior', () => {
    const plana = Array.from({ length: 80 }, (_, i) =>
      candle(100 + (i % 3) * 0.1, { high: 100.2, low: 99.8 }));
    expect(detectMarketRegime(plana, plana.map((c) => c.close))).not.toBe('high_volatility');
  });

  test('una expansión de rango genuina al final sí lo activa', () => {
    const c = [];
    for (let i = 0; i < 80; i++) c.push(candle(100, { high: 100.5, low: 99.5 }));
    // Últimas velas con rango 20× → salto real sobre la mediana, no solo percentil.
    for (let i = 0; i < 20; i++) c.push(candle(100 + i, { high: 110 + i, low: 90 + i }));
    expect(detectMarketRegime(c, c.map((x) => x.close))).toBe('high_volatility');
  });
});
