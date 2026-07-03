/**
 * lsrSummary.test.js — resumen de Long/Short Ratio en computeHistorySummaries.
 *
 * Los campos *_7d exigen >=2 puntos (simétrico con funding/OI): con 1 solo punto
 * (arranque en frío / respuesta parcial de la API) no se fabrica una ventana "7d"
 * desde un único valor. current_* sí está siempre (snapshot "ahora").
 */

import { describe, test, expect } from '@jest/globals';
import { computeHistorySummaries } from '../src/controllers/analysisController.js';

const ls = (long_pct, t = 0) => ({ t, long_pct, short_pct: parseFloat((100 - long_pct).toFixed(1)) });

describe('computeHistorySummaries — long/short ratio (guard de longitud)', () => {
  test('1 solo punto: current_* presente, *_7d a null', () => {
    const { longShortSummary } = computeHistorySummaries({ long_short_ratio: [ls(62)] });
    expect(longShortSummary.current_long_pct).toBe(62);
    expect(longShortSummary.current_short_pct).toBe(38);
    expect(longShortSummary.open_7d_long_pct).toBeNull();
    expect(longShortSummary.change_7d_long_pct).toBeNull();
    expect(longShortSummary.avg_7d_long_pct).toBeNull();
    expect(longShortSummary.max_7d_long_pct).toBeNull();
    expect(longShortSummary.min_7d_long_pct).toBeNull();
    expect(longShortSummary.trend_7d).toBeNull();
  });

  test('>=2 puntos: *_7d se calculan', () => {
    const { longShortSummary } = computeHistorySummaries({
      long_short_ratio: [ls(55, 1), ls(60, 2), ls(65, 3)],
    });
    expect(longShortSummary.open_7d_long_pct).toBe(55);
    expect(longShortSummary.current_long_pct).toBe(65);
    expect(longShortSummary.change_7d_long_pct).toBeCloseTo(10, 5);
    expect(longShortSummary.avg_7d_long_pct).toBeCloseTo(60, 5);
    expect(longShortSummary.max_7d_long_pct).toBe(65);
    expect(longShortSummary.min_7d_long_pct).toBe(55);
    expect(longShortSummary.trend_7d).toBe('longs_increasing');
  });

  test('sin datos: summary null', () => {
    const { longShortSummary } = computeHistorySummaries({ long_short_ratio: [] });
    expect(longShortSummary).toBeNull();
  });
});
