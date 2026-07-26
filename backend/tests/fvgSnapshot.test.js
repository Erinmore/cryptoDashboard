/**
 * fvgSnapshot.test.js — persistencia detallada de FVGs (deuda §6, último ítem).
 *
 * `analysis_tf_snapshot` ya guardaba el CONTEO de FVGs, pero no su geometría: a posteriori
 * no se podía comprobar si el precio llegó a rellenar el gap, que es justo lo que valida (o
 * refuta) la tesis del FVG como imán de precio. `buildFvgRows` construye las filas de
 * `analysis_fvg_snapshot` desde technical[tf].smc.unmitigated_fvgs.
 */

import { describe, test, expect } from '@jest/globals';
import { buildFvgRows, fvgDistancePct } from '../src/controllers/analysisController.js';

const fvg = (over = {}) => ({
  low: 95, high: 98, size_pct: 3.16, mitigation_pct: 0,
  candles_ago: 3, signal_status: 'active', t_right: 1700000000, ...over,
});

describe('fvgDistancePct — distancia con signo a la zona', () => {
  test('precio por ENCIMA de la zona → negativo (hay que caer para rellenar)', () => {
    expect(fvgDistancePct(100, 95, 98)).toBe(-2);   // (98-100)/100*100
  });

  test('precio por DEBAJO de la zona → positivo (hay que subir)', () => {
    expect(fvgDistancePct(100, 105, 110)).toBe(5);  // (105-100)/100*100
  });

  test('precio DENTRO de la zona → 0 (mitigándose ahora)', () => {
    expect(fvgDistancePct(96, 95, 98)).toBe(0);
    expect(fvgDistancePct(95, 95, 98)).toBe(0);     // borde inferior incluido
    expect(fvgDistancePct(98, 95, 98)).toBe(0);     // borde superior incluido
  });

  test('datos ausentes → null (no inventa distancias)', () => {
    expect(fvgDistancePct(null, 95, 98)).toBeNull();
    expect(fvgDistancePct(100, null, 98)).toBeNull();
    expect(fvgDistancePct(100, 95, null)).toBeNull();
    expect(fvgDistancePct(0, 95, 98)).toBeNull();
  });
});

describe('buildFvgRows', () => {
  const technical = {
    '4h': {
      smc: {
        unmitigated_fvgs: {
          bullish: [fvg(), fvg({ low: 90, high: 92, candles_ago: 20, signal_status: 'context' })],
          bearish: [fvg({ low: 110, high: 112, mitigation_pct: 85, signal_status: 'expired' })],
        },
      },
    },
    '1D': {
      smc: { unmitigated_fvgs: { bullish: [fvg({ low: 80, high: 85 })], bearish: [] } },
    },
  };

  test('genera una fila por FVG, con tf/tipo/rank correctos', () => {
    const rows = buildFvgRows('a1', technical, 100);
    expect(rows).toHaveLength(4);            // 2 bull 4h + 1 bear 4h + 1 bull 1D

    const bull4h = rows.filter(r => r.tf === '4h' && r.fvg_type === 'bullish');
    expect(bull4h.map(r => r.fvg_rank)).toEqual([0, 1]);   // 0 = más reciente
    expect(bull4h[0].zone_low).toBe(95);
    expect(bull4h[0].zone_high).toBe(98);
    expect(bull4h[0].signal_status).toBe('active');
    expect(bull4h[1].signal_status).toBe('context');
  });

  test('persiste geometría completa + distancia al precio', () => {
    const [row] = buildFvgRows('a1', technical, 100);
    expect(row).toMatchObject({
      analysis_id: 'a1', tf: '4h', fvg_type: 'bullish', fvg_rank: 0,
      zone_low: 95, zone_high: 98, size_pct: 3.16, mitigation_pct: 0,
      candles_ago: 3, signal_status: 'active', formed_t: 1700000000,
      distance_pct: -2,   // precio 100 por encima de la zona
    });
  });

  test('un FVG expirado también se persiste (telemetría, no solo los activos)', () => {
    const rows = buildFvgRows('a1', technical, 100);
    const bear = rows.find(r => r.fvg_type === 'bearish');
    expect(bear.signal_status).toBe('expired');
    expect(bear.mitigation_pct).toBe(85);
    expect(bear.distance_pct).toBe(10);   // zona 110-112, precio 100 → subir 10%
  });

  test('TF sin SMC / sin FVGs no aporta filas', () => {
    expect(buildFvgRows('a1', { '1h': {}, '4h': { smc: null } }, 100)).toEqual([]);
    expect(buildFvgRows('a1', { '1h': { smc: { unmitigated_fvgs: { bullish: [], bearish: [] } } } }, 100)).toEqual([]);
  });

  test('technical vacío o null → sin filas (no lanza)', () => {
    expect(buildFvgRows('a1', null, 100)).toEqual([]);
    expect(buildFvgRows('a1', {}, 100)).toEqual([]);
  });

  test('sin precio actual → distance_pct null, resto intacto', () => {
    const rows = buildFvgRows('a1', technical, null);
    expect(rows[0].distance_pct).toBeNull();
    expect(rows[0].zone_low).toBe(95);
  });
});
