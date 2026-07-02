/**
 * fundingSummary.test.js — resumen de funding en computeHistorySummaries.
 *
 * Verifica el fix de escala: los candles de Coinalyze guardan el funding en
 * decimal crudo, pero el resumen debe exponerse en % (×100) para coincidir con
 * el top-level `funding_rate.rate_pct`, y severity_last_candle debe clasificar
 * sobre esa escala % (no sobre el decimal crudo).
 */

import { describe, test, expect } from '@jest/globals';
import { computeHistorySummaries } from '../src/controllers/analysisController.js';

// Candle de funding tal cual lo guarda historyService (decimal crudo de Coinalyze).
const fr = (c, { o = c, h = c, l = c, trend = null } = {}) => ({ t: 0, o, h, l, c, trend });

describe('computeHistorySummaries — funding rate scale (% vs decimal crudo)', () => {
  test('expone open/close/high/low en % (×100), no en decimal crudo', () => {
    const histories = {
      funding_rate: [
        fr(0.007228, { o: 0.007228 }),
        fr(-0.002441, { h: 0.01, l: -0.002441, trend: 'falling' }),
      ],
    };
    const { fundingRateSummary } = computeHistorySummaries(histories);

    // -0.002441 crudo → -0.2441 %
    expect(fundingRateSummary.close_current).toBeCloseTo(-0.2441, 4);
    expect(fundingRateSummary.open_48h).toBeCloseTo(0.7228, 4);
    expect(fundingRateSummary.high_48h).toBeCloseTo(1, 4);      // 0.01 crudo → 1 %
    expect(fundingRateSummary.low_48h).toBeCloseTo(-0.2441, 4);
  });

  test('severity_last_candle clasifica sobre la escala % (no siempre "normal")', () => {
    // 0.003 crudo = 0.3 % → "high" (> 0.2). Con el bug anterior (umbral sobre crudo)
    // habría dado "normal" porque 0.003 < 0.05.
    const histories = {
      funding_rate: [fr(0.001), fr(0.003)],
    };
    const { fundingRateSummary } = computeHistorySummaries(histories);
    expect(fundingRateSummary.severity_last_candle).toBe('high');
  });

  test('funding "normal" en % sigue siendo normal', () => {
    // 0.0004 crudo = 0.04 % → "normal" (< 0.05).
    const histories = { funding_rate: [fr(0.0002), fr(0.0004)] };
    const { fundingRateSummary } = computeHistorySummaries(histories);
    expect(fundingRateSummary.severity_last_candle).toBe('normal');
  });

  test('pct_candles_positive cuenta signos correctamente tras el ×100', () => {
    const histories = {
      funding_rate: [fr(0.005), fr(-0.002), fr(0.003), fr(-0.001)],
    };
    const { fundingRateSummary } = computeHistorySummaries(histories);
    expect(fundingRateSummary.pct_candles_positive).toBe(50);
  });
});
