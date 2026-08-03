import { describeConditionalPlan } from '../src/utils/conditionalPlan.js';
import { SHADOW_FILL_RULE } from '../src/utils/shadowTrade.js';

/**
 * Lo que estos tests protegen no es la aritmética (esa es trivial) sino las tres NEGATIVAS
 * del módulo: que no invente cifras cuando falta el dato, que no exponga `expectancy_r`
 * mientras su línea base sea una curva sin medir, y que la regla de llenado viaje SIEMPRE
 * pegada a los números en vez de en una nota al pie.
 */

// El último análisis REAL de producción (SOL, 2026-08-03 08:05 UTC).
const REAL = {
  conditionalSetup: {
    trigger: 'cierre 4h < 72.09 con OI expandiendo y CVD 4h vendedor',
    direction: 'short', entry_price: 71.9, stop_price: 73.6, tp1_price: 68.32,
    validity_candles: 12, tf_execution: '4h',
  },
  atrPct__outcome_19: 1.09, priceAtAnalysis: 72.43, primaryTf: '4h',
  timestamp: '2026-08-03T08:05:55.077Z',
};

describe('describeConditionalPlan — el plan que el panel enseña', () => {
  test('reproduce las cuatro cifras del análisis real', () => {
    const p = describeConditionalPlan(REAL);
    expect(p.rr).toBe(2.11);
    expect(p.breakeven_win_rate_pct).toBe(32.2);
    expect(p.trigger_prob_pct).toBeCloseTo(73.7, 1);
    expect(p.target_reachability_pct).toBeCloseTo(7.9, 1);
  });

  test('la vigencia se convierte en un INSTANTE (12 velas 4h = 48 h)', () => {
    const p = describeConditionalPlan(REAL);
    const dt = Date.parse(p.expires_at) - Date.parse(REAL.timestamp);
    expect(dt).toBe(48 * 3600 * 1000);
  });

  test('acepta el conditional_setup como JSON persistido, no sólo como objeto', () => {
    const p = describeConditionalPlan({ ...REAL, conditionalSetup: JSON.stringify(REAL.conditionalSetup) });
    expect(p.rr).toBe(2.11);
  });

  test('la regla de llenado viaja SIEMPRE con las cifras', () => {
    expect(describeConditionalPlan(REAL).fill_rule).toBe(SHADOW_FILL_RULE);
  });

  test('NO expone expectancy_r — su línea base es una curva sin medir (M10)', () => {
    const p = describeConditionalPlan(REAL);
    expect(p).not.toHaveProperty('expectancy_r');
    expect(p.expectancy_r_unavailable_reason).toMatch(/curva sin medir/);
  });

  test('NO expone ninguna probabilidad de acierto direccional (fase 0 y M9: NO-GO)', () => {
    const p = describeConditionalPlan(REAL);
    // `breakeven_win_rate_pct` es GEOMETRÍA (aritmética del R:R), no pronóstico → se excluye.
    for (const k of Object.keys(p).filter((x) => x !== 'breakeven_win_rate_pct')) {
      expect(k).not.toMatch(/win_rate|accuracy|prob_up|prob_down|edge/);
    }
    expect(p.breakeven_win_rate_pct).toBe(32.2);
  });

  describe('se niega a estimar cuando falta el dato (null, no un valor por defecto)', () => {
    test('sin ATR no hay curvas, pero el R:R sí (es aritmética)', () => {
      const p = describeConditionalPlan({ ...REAL, atrPct__outcome_19: null });
      expect(p.trigger_prob_pct).toBeNull();
      expect(p.target_reachability_pct).toBeNull();
      expect(p.rr).toBe(2.11);
      expect(p.breakeven_win_rate_pct).toBe(32.2);
    });

    test('sin precio del análisis no se normaliza el gatillo, pero el objetivo sí', () => {
      const p = describeConditionalPlan({ ...REAL, priceAtAnalysis: null });
      expect(p.trigger_prob_pct).toBeNull();
      expect(p.target_reachability_pct).toBeCloseTo(7.9, 1);
    });

    test('sin vigencia utilizable no se inventa una caducidad', () => {
      const cs = { ...REAL.conditionalSetup, validity_candles: null };
      const p = describeConditionalPlan({ ...REAL, conditionalSetup: cs });
      expect(p.expires_at).toBeNull();
    });

    test('stop == entrada (riesgo cero) no produce un R:R infinito', () => {
      const cs = { ...REAL.conditionalSetup, stop_price: REAL.conditionalSetup.entry_price };
      const p = describeConditionalPlan({ ...REAL, conditionalSetup: cs });
      expect(p.rr).toBeNull();
      expect(p.breakeven_win_rate_pct).toBeNull();
    });
  });

  describe('entradas inservibles → null, sin lanzar', () => {
    test.each([
      ['sin argumentos', undefined],
      ['setup nulo', { conditionalSetup: null }],
      ['JSON corrupto', { conditionalSetup: '{no json' }],
      ['string vacío', { conditionalSetup: '' }],
      ['número', { conditionalSetup: 42 }],
    ])('%s', (_label, args) => {
      expect(describeConditionalPlan(args)).toBeNull();
    });
  });

  test('un plan LARGO se describe igual de bien (el R:R no depende del signo)', () => {
    const cs = {
      direction: 'long', entry_price: 100, stop_price: 98, tp1_price: 106,
      validity_candles: 6, tf_execution: '4h',
    };
    const p = describeConditionalPlan({
      conditionalSetup: cs, atrPct__outcome_19: 1.5, priceAtAnalysis: 99,
      primaryTf: '4h', timestamp: '2026-08-03T00:00:00.000Z',
    });
    expect(p.direction).toBe('long');
    expect(p.rr).toBe(3);
    expect(p.breakeven_win_rate_pct).toBe(25);
  });
});
