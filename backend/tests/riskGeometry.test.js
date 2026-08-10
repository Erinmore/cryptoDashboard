import { computeRiskGeometry } from '../src/utils/riskGeometry.js';

/**
 * Lo que estos tests protegen: que la geometría es EXACTAMENTE simétrica entre long y short
 * (misma prueba de que no codifica ninguna opinión direccional), que no inventa cifras sin
 * ATR/precio, y que la vigencia/alcanzabilidad delegan en las funciones ya medidas
 * (`setupExpiryMs`, `targetReachabilityFor`) en vez de reimplementar su aritmética.
 */

const BASE = { currentPrice: 100, atrPct: 1.5, primaryTf: '4h', tMs: Date.parse('2026-08-03T00:00:00.000Z') };

describe('computeRiskGeometry — geometría simétrica long/short', () => {
  test('long y short son EXACTAMENTE simétricos en rr/breakeven/reachability', () => {
    const g = computeRiskGeometry(BASE);
    expect(g.long.rr).toBe(g.short.rr);
    expect(g.long.breakeven_win_rate_pct).toBe(g.short.breakeven_win_rate_pct);
    expect(g.long.target_reachability_pct).toBe(g.short.target_reachability_pct);
    expect(g.long.target_unreachable).toBe(g.short.target_unreachable);
  });

  test('reproduce las cifras del caso base (2×/1×ATR, 24h)', () => {
    const g = computeRiskGeometry(BASE);
    expect(g.long.stop_price).toBe(98.5);
    expect(g.long.tp1_price).toBe(103);
    expect(g.short.stop_price).toBe(101.5);
    expect(g.short.tp1_price).toBe(97);
    expect(g.long.rr).toBe(2);
    expect(g.long.breakeven_win_rate_pct).toBe(33.3);
  });

  test('el objetivo está a 2×ATR del precio en AMBAS direcciones (no solo en magnitud)', () => {
    const g = computeRiskGeometry(BASE);
    expect(g.long.tp1_price - g.long.entry_price).toBeCloseTo(2 * 1.5, 5);
    expect(g.long.entry_price - g.short.tp1_price).toBeCloseTo(2 * 1.5, 5);
  });

  test('la vigencia es SIEMPRE 24h (6 velas en 4h) — delega en setupExpiryMs', () => {
    const g = computeRiskGeometry(BASE);
    const dt = Date.parse(g.expires_at) - BASE.tMs;
    expect(dt).toBe(24 * 3600 * 1000);
    expect(g.validity_candles).toBe(6);
  });

  test('el ATR declarado es el de decisión (180 velas), no el de 19', () => {
    const g = computeRiskGeometry(BASE);
    expect(g.atr_pct_source).toBe('decision_180');
    expect(g.atr_pct).toBe(1.5);
  });

  test('no expone ninguna probabilidad de acierto direccional', () => {
    const g = computeRiskGeometry(BASE);
    for (const side of [g.long, g.short]) {
      for (const k of Object.keys(side).filter((x) => x !== 'breakeven_win_rate_pct')) {
        expect(k).not.toMatch(/win_rate|accuracy|prob_up|prob_down|edge/);
      }
    }
    expect(g).not.toHaveProperty('expectancy_r');
  });

  describe('se niega a estimar cuando falta el dato (null, no un valor por defecto)', () => {
    test.each([
      ['sin argumentos', undefined],
      ['sin currentPrice', { atrPct: 1.5, primaryTf: '4h' }],
      ['sin atrPct', { currentPrice: 100, primaryTf: '4h' }],
      ['currentPrice negativo', { currentPrice: -5, atrPct: 1, primaryTf: '4h' }],
      ['atrPct cero', { currentPrice: 100, atrPct: 0, primaryTf: '4h' }],
      ['atrPct no finito', { currentPrice: 100, atrPct: NaN, primaryTf: '4h' }],
    ])('%s → null', (_label, args) => {
      expect(computeRiskGeometry(args)).toBeNull();
    });

    test('sin timestamp no se inventa una caducidad', () => {
      const g = computeRiskGeometry({ ...BASE, tMs: null });
      expect(g).not.toBeNull();
      expect(g.expires_at).toBeNull();
      // El resto de la geometría no depende del tiempo — sigue siendo utilizable.
      expect(g.long.rr).toBe(2);
    });
  });

  test('escala con el ATR: el doble de ATR% duplica la distancia de stop/objetivo', () => {
    const g1 = computeRiskGeometry(BASE);
    const g2 = computeRiskGeometry({ ...BASE, atrPct: 3 });
    const dist1 = g1.long.tp1_price - g1.long.entry_price;
    const dist2 = g2.long.tp1_price - g2.long.entry_price;
    expect(dist2).toBeCloseTo(dist1 * 2, 5);
  });
});
