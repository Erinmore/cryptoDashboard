/**
 * fundingSummary.test.js — resumen de funding en computeHistorySummaries.
 *
 * Coinalyze devuelve el funding YA en porcentaje (verificado en vivo: value=0.01
 * ⇔ 0.01% de Binance). Los candles guardados en historyService están en esa misma
 * escala %, así que el resumen los pasa tal cual y coincide con el top-level
 * `funding_rate.rate_pct`. severity_last_candle clasifica sobre % directamente.
 */

import { describe, test, expect } from '@jest/globals';
import { computeHistorySummaries } from '../src/controllers/analysisController.js';

// Candle de funding tal cual lo guarda historyService (en %, como lo da Coinalyze).
const fr = (c, { o = c, h = c, l = c, trend = null } = {}) => ({ t: 0, o, h, l, c, trend });

describe('computeHistorySummaries — funding rate (escala % de Coinalyze)', () => {
  test('pasa open/close/high/low tal cual (ya en %)', () => {
    const histories = {
      funding_rate: [
        fr(0.007228, { o: 0.007228 }),
        fr(-0.002441, { h: 0.01, l: -0.002441, trend: 'stable' }),
      ],
    };
    const { fundingRateSummary } = computeHistorySummaries(histories);

    expect(fundingRateSummary.close_current).toBeCloseTo(-0.002441, 6);
    expect(fundingRateSummary.open_48h).toBeCloseTo(0.007228, 6);
    expect(fundingRateSummary.high_48h).toBeCloseTo(0.01, 6);
    expect(fundingRateSummary.low_48h).toBeCloseTo(-0.002441, 6);
  });

  test('severity_last_candle clasifica sobre % (0.3% → high)', () => {
    const histories = { funding_rate: [fr(0.1), fr(0.3)] };
    const { fundingRateSummary } = computeHistorySummaries(histories);
    expect(fundingRateSummary.severity_last_candle).toBe('high');
  });

  test('funding normal (0.01%) → severity normal', () => {
    const histories = { funding_rate: [fr(0.007), fr(0.01)] };
    const { fundingRateSummary } = computeHistorySummaries(histories);
    expect(fundingRateSummary.severity_last_candle).toBe('normal');
  });

  test('pct_candles_positive cuenta signos correctamente', () => {
    const histories = {
      funding_rate: [fr(0.005), fr(-0.002), fr(0.003), fr(-0.001)],
    };
    const { fundingRateSummary } = computeHistorySummaries(histories);
    expect(fundingRateSummary.pct_candles_positive).toBe(50);
  });
});
