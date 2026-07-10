/**
 * gating.test.js — gating determinista (utils/gating.js) tras la auditoría (Fase 2).
 *
 * Cambios cubiertos:
 *  - H3 · Vetos LONG/SHORT SIMÉTRICOS (CVD 1D + OI + S/R del TF primario). Sin funding.
 *  - H2 · data_insufficient cuando falta CVD 1D u Open Interest (fail-closed).
 *  - H1 · Ausencia de estructura ≠ contradicción (→ missing_structural_confirmation);
 *         solo un CONFLICTO estructural activo (BOS vs CHoCH opuestos) cuenta.
 *  - H1 · price_near_key_level exige nivel con 2+ toques.
 *  - H4 · computeGating deduplica veto↔contradicciones.
 */

import { describe, test, expect } from '@jest/globals';
import { computeVetos, computeContradictions, computeGating, nearStrongLevel } from '../src/utils/gating.js';

// Contexto que dispara VETO LONG: CVD 1D bearish + OI plano + resistencia 4h <1.5% con 3+ toques.
function longVetoContext() {
  return {
    technical: {
      '1D': { cvd: { divergence: 'bearish' } },
      '4h': {
        support_resistance: {
          supports: [{ price: 90, touches: 5 }],
          resistances: [{ price: 101, touches: 4 }],
        },
      },
    },
    openInterest: { change_24h_pct: 0.3 },
    currentPrice: 100,
    primaryTf: '4h',
  };
}

// Contexto que dispara VETO SHORT (espejo): CVD 1D bullish + OI plano + soporte 4h <1.5% con 3+ toques.
function shortVetoContext() {
  return {
    technical: {
      '1D': { cvd: { divergence: 'bullish' } },
      '4h': {
        support_resistance: {
          supports: [{ price: 99, touches: 3 }],
          resistances: [{ price: 120, touches: 5 }],
        },
      },
    },
    openInterest: { change_24h_pct: 0.3 },
    currentPrice: 100,
    primaryTf: '4h',
  };
}

describe('nearStrongLevel', () => {
  test('encuentra un nivel a <=1.5% con >=3 toques', () => {
    const r = nearStrongLevel([{ price: 101, touches: 3 }], 100);
    expect(r.found).toBe(true);
    expect(r.distance_pct).toBe(1);
  });

  test('nivel cercano pero con <3 toques → no cuenta (umbral por defecto)', () => {
    expect(nearStrongLevel([{ price: 101, touches: 2 }], 100).found).toBe(false);
  });

  test('minTouches configurable: con 2 sí cuenta', () => {
    expect(nearStrongLevel([{ price: 101, touches: 2 }], 100, 2).found).toBe(true);
  });

  test('nivel con 3+ toques pero >1.5% de distancia → no cuenta', () => {
    expect(nearStrongLevel([{ price: 105, touches: 8 }], 100).found).toBe(false);
  });

  test('lista vacía / precio null → no crashea', () => {
    expect(nearStrongLevel([], 100).found).toBe(false);
    expect(nearStrongLevel(undefined, 100).found).toBe(false);
    expect(nearStrongLevel([{ price: 101, touches: 5 }], null).found).toBe(false);
  });
});

describe('computeVetos — VETO LONG', () => {
  test('las tres condiciones a la vez → veto_long activo', () => {
    const r = computeVetos(longVetoContext());
    expect(r.veto_long).toBe(true);
    expect(r.veto_short).toBe(false);
    expect(r.veto_reason).toMatch(/VETO LONG/);
    expect(r.conditions.long).toEqual({
      cvd_1d_bearish: true,
      oi_not_expanding: true,
      near_resistance_3plus_touches: true,
    });
  });

  test('CVD 1D no bearish → sin veto', () => {
    const ctx = longVetoContext();
    ctx.technical['1D'].cvd.divergence = 'none';
    expect(computeVetos(ctx).veto_long).toBe(false);
  });

  test('OI expandiendo (change >= +1%) → sin veto', () => {
    const ctx = longVetoContext();
    ctx.openInterest.change_24h_pct = 3.5;
    expect(computeVetos(ctx).veto_long).toBe(false);
  });

  test('resistencia con solo 2 toques → sin veto', () => {
    const ctx = longVetoContext();
    ctx.technical['4h'].support_resistance.resistances = [{ price: 101, touches: 2 }];
    expect(computeVetos(ctx).veto_long).toBe(false);
  });
});

describe('computeVetos — VETO SHORT (simétrico)', () => {
  test('las tres condiciones a la vez → veto_short activo', () => {
    const r = computeVetos(shortVetoContext());
    expect(r.veto_short).toBe(true);
    expect(r.veto_long).toBe(false);
    expect(r.veto_reason).toMatch(/VETO SHORT/);
    expect(r.conditions.short).toEqual({
      cvd_1d_bullish: true,
      oi_not_expanding: true,
      near_support_3plus_touches: true,
    });
  });

  test('OI expandiendo → sin veto short (mismo eje que long)', () => {
    const ctx = shortVetoContext();
    ctx.openInterest.change_24h_pct = 4;
    expect(computeVetos(ctx).veto_short).toBe(false);
  });

  test('soporte a más de 1.5% → sin veto', () => {
    const ctx = shortVetoContext();
    ctx.technical['4h'].support_resistance.supports = [{ price: 97, touches: 5 }];
    expect(computeVetos(ctx).veto_short).toBe(false);
  });
});

describe('computeVetos — fail-closed (H2) y robustez', () => {
  test('OI ausente → data_insufficient=true, sin veto afirmado', () => {
    const ctx = longVetoContext();
    ctx.openInterest = null;
    const r = computeVetos(ctx);
    expect(r.veto_long).toBe(false);
    expect(r.data_insufficient).toBe(true);
    expect(r.missing_inputs).toContain('open_interest');
  });

  test('CVD 1D ausente → data_insufficient=true', () => {
    const ctx = longVetoContext();
    delete ctx.technical['1D'];
    const r = computeVetos(ctx);
    expect(r.data_insufficient).toBe(true);
    expect(r.missing_inputs).toContain('cvd_1d');
  });

  test('datos completos → data_insufficient=false', () => {
    expect(computeVetos(longVetoContext()).data_insufficient).toBe(false);
  });

  test('technical vacío → sin vetos, data_insufficient, sin crash', () => {
    const r = computeVetos({ technical: {}, openInterest: null, currentPrice: 100, primaryTf: '4h' });
    expect(r.veto_long).toBe(false);
    expect(r.veto_short).toBe(false);
    expect(r.data_insufficient).toBe(true);
    expect(r.conditions.sr_timeframe).toBe('4h');
  });

  test('usa la S/R del TF primario indicado (1h)', () => {
    const ctx = longVetoContext();
    ctx.primaryTf = '1h';
    ctx.technical['1h'] = {
      support_resistance: { supports: [{ price: 90, touches: 5 }], resistances: [{ price: 101, touches: 4 }] },
    };
    ctx.technical['4h'].support_resistance.resistances = [{ price: 130, touches: 4 }];
    const r = computeVetos(ctx);
    expect(r.veto_long).toBe(true);
    expect(r.conditions.sr_timeframe).toBe('1h');
  });
});

describe('computeContradictions', () => {
  // Contexto con 4 contradicciones deterministas (sin conflicto estructural).
  function fourContradictions() {
    return {
      technical: {
        '1D': { cvd: { divergence: 'bearish' }, trend: 'bullish' },
        '1W': { trend: 'bearish' },
        '4h': {
          support_resistance: { supports: [{ price: 99.2, touches: 3 }], resistances: [{ price: 130, touches: 2 }] },
          smc: { last_bos: null, last_choch: null },
        },
      },
      openInterest: { change_24h_pct: -2 },
      currentPrice: 100,
      primaryTf: '4h',
    };
  }

  test('detecta las 4 señales deterministas (sin la estructural) → 3 bloques distintos', () => {
    const r = computeContradictions(fourContradictions());
    const codes = r.contradictions.map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining([
      'cvd_1d_divergence', 'oi_flat_or_falling', 'price_near_key_level', 'htf_conflict_1w_1d',
    ]));
    expect(codes).not.toContain('smc_structural_conflict');
    // 4 señales pero solo 3 bloques (volume + derivatives + structure): price_near_key_level
    // y htf_conflict son ambos 'structure' → cuentan como uno (ANTI-DOUBLE-COUNT / B1).
    expect(r.contradiction_count).toBe(3);
  });

  test('B1 · dos señales estructurales (nivel + HTF) cuentan como UN bloque', () => {
    const ctx = fourContradictions();
    ctx.openInterest = { change_24h_pct: 3 };            // quita oi_flat (derivatives)
    ctx.technical['1D'].cvd = { divergence: 'none' };    // quita cvd_1d (volume)
    const r = computeContradictions(ctx);
    // Quedan price_near_key_level + htf_conflict_1w_1d (ambos 'structure').
    expect(r.contradictions.length).toBe(2);
    expect(r.contradiction_count).toBe(1);
  });

  test('H1 · ausencia de estructura NO es contradicción, sí missing_structural_confirmation', () => {
    const r = computeContradictions(fourContradictions());
    expect(r.contradictions.map((c) => c.code)).not.toContain('smc_structural_conflict');
    expect(r.missing_structural_confirmation).toBe(true);
  });

  test('H1 · smc null tampoco cuenta como contradicción (solo missing_confirmation)', () => {
    const ctx = fourContradictions();
    ctx.technical['4h'].smc = null;
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).not.toContain('smc_structural_conflict');
    expect(r.missing_structural_confirmation).toBe(true);
  });

  test('H1 · BOS y CHoCH activos y OPUESTOS → contradicción estructural', () => {
    const ctx = fourContradictions();
    ctx.technical['4h'].smc = {
      last_bos: { direction: 'bullish', signal_status: 'active' },
      last_choch: { direction: 'bearish', signal_status: 'active' },
    };
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).toContain('smc_structural_conflict');
    expect(r.missing_structural_confirmation).toBe(false);
  });

  test('BOS y CHoCH activos en la MISMA dirección → sin conflicto', () => {
    const ctx = fourContradictions();
    ctx.technical['4h'].smc = {
      last_bos: { direction: 'bullish', signal_status: 'active' },
      last_choch: { direction: 'bullish', signal_status: 'active' },
    };
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).not.toContain('smc_structural_conflict');
    expect(r.missing_structural_confirmation).toBe(false);
  });

  test('price_near_key_level exige 2+ toques (nivel con 1 toque no cuenta)', () => {
    const ctx = fourContradictions();
    ctx.technical['4h'].support_resistance = { supports: [{ price: 99.5, touches: 1 }], resistances: [] };
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).not.toContain('price_near_key_level');
  });

  test('mercado limpio → sin contradicciones', () => {
    const r = computeContradictions({
      technical: {
        '1D': { cvd: { divergence: 'none' }, trend: 'bullish' },
        '1W': { trend: 'bullish' },
        '4h': {
          support_resistance: { supports: [{ price: 90, touches: 3 }], resistances: [{ price: 110, touches: 3 }] },
          smc: { last_bos: { direction: 'bullish', signal_status: 'active' }, last_choch: null },
        },
      },
      openInterest: { change_24h_pct: 3 },
      currentPrice: 100,
      primaryTf: '4h',
    });
    expect(r.contradiction_count).toBe(0);
    expect(r.missing_structural_confirmation).toBe(false);
  });

  test('OI ausente no cuenta como contradicción (dato faltante ≠ OI cayendo)', () => {
    const ctx = fourContradictions();
    ctx.openInterest = null;
    expect(computeContradictions(ctx).contradictions.map((c) => c.code)).not.toContain('oi_flat_or_falling');
  });

  test('1D o 1W neutral → sin conflicto HTF', () => {
    const ctx = fourContradictions();
    ctx.technical['1W'].trend = 'neutral';
    expect(computeContradictions(ctx).contradictions.map((c) => c.code)).not.toContain('htf_conflict_1w_1d');
  });
});

describe('computeGating — dedupe veto↔contradicciones (H4)', () => {
  test('sin veto → contradicciones intactas', () => {
    const ctx = {
      technical: {
        '1D': { cvd: { divergence: 'bearish' }, trend: 'bullish' },
        '1W': { trend: 'bearish' },
        '4h': { support_resistance: { supports: [{ price: 99.2, touches: 3 }], resistances: [{ price: 130, touches: 2 }] }, smc: null },
      },
      openInterest: { change_24h_pct: 3 }, // OI expandiendo → sin veto, sin oi_flat
      currentPrice: 100,
      primaryTf: '4h',
    };
    const g = computeGating(ctx);
    expect(g.veto_long).toBe(false);
    expect(g.deduped_by_veto).toEqual([]);
    // cvd_1d_divergence + price_near_key_level + htf_conflict presentes.
    expect(g.contradiction_count).toBe(g.contradictions_raw_count);
  });

  test('con veto activo → se descuentan cvd_1d_divergence y price_near_key_level', () => {
    const g = computeGating(longVetoContext());
    expect(g.veto_long).toBe(true);
    // El veto se construyó con CVD 1D bearish + resistencia fuerte cercana → esas
    // contradicciones no se recuentan como evidencia independiente.
    expect(g.contradictions.map((c) => c.code)).not.toContain('cvd_1d_divergence');
    expect(g.contradictions.map((c) => c.code)).not.toContain('price_near_key_level');
    expect(g.deduped_by_veto.length).toBeGreaterThan(0);
    expect(g.contradiction_count).toBeLessThan(g.contradictions_raw_count);
  });

  // Auditoría #2 (hallazgo 6): el OI es la tercera pata del veto (oi_not_expanding con
  // change<+1% subsume el <0 de la contradicción) — con veto activo tampoco se recuenta.
  test('con veto activo y OI cayendo → oi_flat_or_falling también se descuenta', () => {
    const ctx = longVetoContext();
    ctx.openInterest = { change_24h_pct: -2 }; // <0: contradicción; <+1%: pata del veto
    const g = computeGating(ctx);
    expect(g.veto_long).toBe(true);
    expect(g.contradictions.map((c) => c.code)).not.toContain('oi_flat_or_falling');
    expect(g.deduped_by_veto).toContain('oi_flat_or_falling');
  });

  test('SIN veto, OI cayendo → oi_flat_or_falling sí cuenta (el dedupe es solo con veto)', () => {
    const ctx = longVetoContext();
    ctx.technical['1D'].cvd.divergence = 'none'; // rompe la pata CVD → sin veto
    ctx.openInterest = { change_24h_pct: -2 };
    const g = computeGating(ctx);
    expect(g.veto_long).toBe(false);
    expect(g.contradictions.map((c) => c.code)).toContain('oi_flat_or_falling');
  });

  test('propaga data_insufficient y missing_structural_confirmation', () => {
    const ctx = longVetoContext();
    ctx.openInterest = null;
    const g = computeGating(ctx);
    expect(g.data_insufficient).toBe(true);
    expect(g).toHaveProperty('missing_structural_confirmation');
  });
});
