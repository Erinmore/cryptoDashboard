/**
 * gating.test.js — vetos deterministas (utils/gating.js).
 *
 * Verifica computeVetos(): traslada el HARD GATING del SYSTEM_PROMPT a código.
 * VETO LONG y VETO SHORT exigen sus tres condiciones simultáneas; falta cualquiera
 * → no hay veto. La S/R se toma del TF primario. Datos ausentes no activan veto.
 */

import { describe, test, expect } from '@jest/globals';
import { computeVetos, computeContradictions, nearStrongLevel } from '../src/utils/gating.js';

// Contexto base con TF primario 4h que dispara VETO LONG:
//  - CVD 1D bearish
//  - OI change_24h_pct < +1%
//  - resistencia 4h a <1.5% con 3+ toques
function longVetoContext() {
  return {
    technical: {
      '1D': { cvd: { divergence: 'bearish' } },
      '4h': {
        support_resistance: {
          supports: [{ price: 90, touches: 5 }],
          resistances: [{ price: 101, touches: 4 }], // 1% arriba de 100, 4 toques
        },
      },
    },
    openInterest: { change_24h_pct: 0.3 },
    funding: { severity: 'normal', rate_pct: 0.01 },
    currentPrice: 100,
    primaryTf: '4h',
  };
}

// Contexto base que dispara VETO SHORT:
//  - CVD 1D bullish
//  - funding severity normal (o negativo)
//  - soporte 4h a <1.5% con 3+ toques
function shortVetoContext() {
  return {
    technical: {
      '1D': { cvd: { divergence: 'bullish' } },
      '4h': {
        support_resistance: {
          supports: [{ price: 99, touches: 3 }], // 1% abajo de 100, 3 toques
          resistances: [{ price: 120, touches: 5 }],
        },
      },
    },
    openInterest: { change_24h_pct: 5 },
    funding: { severity: 'normal', rate_pct: 0.0 },
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

  test('nivel cercano pero con <3 toques → no cuenta', () => {
    const r = nearStrongLevel([{ price: 101, touches: 2 }], 100);
    expect(r.found).toBe(false);
  });

  test('nivel con 3+ toques pero >1.5% de distancia → no cuenta', () => {
    const r = nearStrongLevel([{ price: 105, touches: 8 }], 100);
    expect(r.found).toBe(false);
  });

  test('escanea toda la lista: elige el nivel algo más lejano pero con toques suficientes', () => {
    const r = nearStrongLevel(
      [{ price: 100.5, touches: 1 }, { price: 101.2, touches: 4 }],
      100,
    );
    expect(r.found).toBe(true);
    expect(r.level.touches).toBe(4);
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

  test('OI ausente (null) → no se afirma la condición → sin veto', () => {
    const ctx = longVetoContext();
    ctx.openInterest = null;
    expect(computeVetos(ctx).veto_long).toBe(false);
  });
});

describe('computeVetos — VETO SHORT', () => {
  test('las tres condiciones a la vez → veto_short activo', () => {
    const r = computeVetos(shortVetoContext());
    expect(r.veto_short).toBe(true);
    expect(r.veto_long).toBe(false);
    expect(r.veto_reason).toMatch(/VETO SHORT/);
  });

  test('funding favorable (severity elevated y rate positivo) → sin veto', () => {
    const ctx = shortVetoContext();
    ctx.funding = { severity: 'elevated', rate_pct: 0.08 };
    expect(computeVetos(ctx).veto_short).toBe(false);
  });

  test('funding negativo cuenta como no favorable para short → veto activo', () => {
    const ctx = shortVetoContext();
    ctx.funding = { severity: 'high', rate_pct: -0.1 };
    expect(computeVetos(ctx).veto_short).toBe(true);
  });

  test('soporte a más de 1.5% → sin veto', () => {
    const ctx = shortVetoContext();
    ctx.technical['4h'].support_resistance.supports = [{ price: 97, touches: 5 }];
    expect(computeVetos(ctx).veto_short).toBe(false);
  });
});

describe('computeVetos — robustez y TF primario', () => {
  test('technical vacío → sin vetos, sin crash', () => {
    const r = computeVetos({ technical: {}, openInterest: null, funding: null, currentPrice: 100, primaryTf: '4h' });
    expect(r.veto_long).toBe(false);
    expect(r.veto_short).toBe(false);
    expect(r.veto_reason).toBeNull();
    expect(r.conditions.sr_timeframe).toBe('4h');
  });

  test('usa la S/R del TF primario indicado (1h), no de 4h', () => {
    const ctx = longVetoContext();
    // Mover la resistencia disparadora al 1h y marcar 1h como primario.
    ctx.primaryTf = '1h';
    ctx.technical['1h'] = {
      support_resistance: {
        supports: [{ price: 90, touches: 5 }],
        resistances: [{ price: 101, touches: 4 }],
      },
    };
    // La resistencia de 4h deja de importar; el veto sale del 1h.
    ctx.technical['4h'].support_resistance.resistances = [{ price: 130, touches: 4 }];
    const r = computeVetos(ctx);
    expect(r.veto_long).toBe(true);
    expect(r.conditions.sr_timeframe).toBe('1h');
  });
});

describe('computeContradictions', () => {
  // Contexto que dispara las 5 contradicciones deterministas a la vez.
  function fiveContradictions() {
    return {
      technical: {
        '1D': { cvd: { divergence: 'bearish' }, trend: 'bullish' },
        '1W': { trend: 'bearish' }, // opuesto a 1D → conflicto HTF
        '4h': {
          distance_to_nearest_support_pct: 0.8, // <=1.5% → near key level
          distance_to_nearest_resistance_pct: 4,
          smc: { last_bos: null, last_choch: null }, // sin estructura activa
        },
      },
      openInterest: { change_24h_pct: -2 }, // OI cayendo
      primaryTf: '4h',
    };
  }

  test('detecta las 5 contradicciones deterministas', () => {
    const r = computeContradictions(fiveContradictions());
    expect(r.contradiction_count).toBe(5);
    const codes = r.contradictions.map((c) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'cvd_1d_divergence',
        'oi_flat_or_falling',
        'price_near_key_level',
        'htf_conflict_1w_1d',
        'no_active_smc_structure',
      ]),
    );
  });

  test('mercado limpio → sin contradicciones', () => {
    const r = computeContradictions({
      technical: {
        '1D': { cvd: { divergence: 'none' }, trend: 'bullish' },
        '1W': { trend: 'bullish' }, // alineado con 1D
        '4h': {
          distance_to_nearest_support_pct: 5,
          distance_to_nearest_resistance_pct: 6,
          smc: { last_bos: { direction: 'bull', signal_status: 'active' }, last_choch: null },
        },
      },
      openInterest: { change_24h_pct: 3 },
      primaryTf: '4h',
    });
    expect(r.contradiction_count).toBe(0);
    expect(r.contradictions).toEqual([]);
  });

  test('BOS con signal_status="context" (fuera del umbral táctico) cuenta como contradicción', () => {
    const ctx = fiveContradictions();
    // Existe estructura pero solo de contexto, no táctica → sigue faltando confirmación activa.
    ctx.technical['4h'].smc = { last_bos: { signal_status: 'context' }, last_choch: null };
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).toContain('no_active_smc_structure');
  });

  test('BOS con signal_status="active" suprime la contradicción estructural', () => {
    const ctx = fiveContradictions();
    ctx.technical['4h'].smc = { last_bos: { signal_status: 'active' }, last_choch: null };
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).not.toContain('no_active_smc_structure');
  });

  test('OI ausente no cuenta como contradicción (dato faltante ≠ OI cayendo)', () => {
    const ctx = fiveContradictions();
    ctx.openInterest = null;
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).not.toContain('oi_flat_or_falling');
  });

  test('1D o 1W neutral → sin conflicto HTF', () => {
    const ctx = fiveContradictions();
    ctx.technical['1W'].trend = 'neutral';
    const r = computeContradictions(ctx);
    expect(r.contradictions.map((c) => c.code)).not.toContain('htf_conflict_1w_1d');
  });
});
