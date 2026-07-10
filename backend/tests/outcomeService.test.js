/**
 * outcomeService.test.js — job de backtesting (services/outcomeService.js).
 *
 * `processAnalysis` es interna; se ejerce vía `runOutcomeJob` con mocks ESM de
 * coingeckoService (fetch de precios/klines) y dbService (candidatos + upsert), dejando
 * `utils/outcome.js` real (funciones puras). Se captura lo que recibe `upsertOutcome`.
 *
 * Cubre en particular el fix 3a (seguimiento revisión crítica 2026-07-07): un setup con
 * has_executable_setup=1 pero setup_entry_price nulo se marca 'invalid' DE INMEDIATO —
 * geometría irreconstruible y permanente— en vez de esperar al horizonte de 7d
 * re-evaluando el barrier cada ciclo.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const fetchHistoricalClose = jest.fn();
const fetchHistoricalKlines = jest.fn();
const getAnalysesNeedingOutcome = jest.fn();
const upsertOutcome = jest.fn();

jest.unstable_mockModule('../src/services/coingeckoService.js', () => ({
  fetchHistoricalClose,
  fetchHistoricalKlines,
}));
jest.unstable_mockModule('../src/services/dbService.js', () => ({
  getAnalysesNeedingOutcome,
  upsertOutcome,
}));

const { runOutcomeJob } = await import('../src/services/outcomeService.js');

const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** Fila base de análisis con overrides. */
function analysisRow(overrides = {}) {
  return {
    id: 'a1', coin: 'BTC', action: 'Comprar',
    price_current: 100, price_at_analysis: 100, // evita el fetch de baseline
    has_executable_setup: 0,
    setup_entry_price: null, setup_stop_price: null, setup_tp1_price: null, setup_tp2_price: null,
    setup_outcome: null, setup_hit_tp1: null, setup_hit_tp2: null, setup_hit_stop: null,
    price_1h_later: null, price_4h_later: null, price_24h_later: null, price_7d_later: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchHistoricalClose.mockResolvedValue(100);
  fetchHistoricalKlines.mockResolvedValue([]);
});

describe('runOutcomeJob — setup con entry_price nulo (fix 3a)', () => {
  test('has_executable_setup=1 sin entry_price → setup_outcome="invalid" YA (sin esperar 7d)', async () => {
    const now = Date.now();
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      timestamp: iso(now - 2 * HOUR),     // 2h → horizonte de 7d NO vencido
      has_executable_setup: 1,
      setup_entry_price: null,            // geometría irreconstruible y permanente
    })]);

    await runOutcomeJob();

    expect(upsertOutcome).toHaveBeenCalledTimes(1);
    const out = upsertOutcome.mock.calls[0][0];
    expect(out.analysis_id).toBe('a1');
    // El corazón del fix: terminal 'invalid' de inmediato, no null/'open' hasta el 7d.
    expect(out.setup_outcome).toBe('invalid');
    expect(out.setup_hit_tp1).toBe(0);
    expect(out.setup_hit_tp2).toBe(0);
    expect(out.setup_hit_stop).toBe(0);
    // No hay geometría → nunca se intenta el barrier (no se piden klines de 1h).
    expect(fetchHistoricalKlines).not.toHaveBeenCalled();
  });

  test('ya invalidado antes → no reprocesa el setup (setupResolved), no pide klines', async () => {
    const now = Date.now();
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      timestamp: iso(now - 2 * HOUR),
      has_executable_setup: 1,
      setup_entry_price: null,
      setup_outcome: 'invalid', setup_hit_tp1: 0, setup_hit_tp2: 0, setup_hit_stop: 0,
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.setup_outcome).toBe('invalid'); // preservado
    expect(fetchHistoricalKlines).not.toHaveBeenCalled();
  });
});

describe('runOutcomeJob — contraste: setup con entry_price válido sí corre el barrier', () => {
  test('setup válido no disparado (precio nunca toca entry) → "open" (no "invalid")', async () => {
    const now = Date.now();
    // Velas 1h que NUNCA tocan la entrada (low>entry): la orden condicional no se llena.
    fetchHistoricalKlines.mockResolvedValue([
      { high: 108, low: 103 }, { high: 107, low: 104 }, { high: 106, low: 103 },
    ]);
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      timestamp: iso(now - 2 * 24 * HOUR),  // 2d → barrier corre, horizonte 7d NO vencido
      has_executable_setup: 1,
      setup_entry_price: 100, setup_stop_price: 95, setup_tp1_price: 110, setup_tp2_price: 120,
    })]);

    await runOutcomeJob();

    expect(fetchHistoricalKlines).toHaveBeenCalledTimes(1);
    const out = upsertOutcome.mock.calls[0][0];
    // not_triggered dentro del horizonte → 'open' (puede llenarse aún), NO 'invalid'.
    expect(out.setup_outcome).toBe('open');
  });

  test('setup válido que llena la entrada y toca TP1 → "tp1"', async () => {
    const now = Date.now();
    // Vela 1 toca la entrada (low<=100<=high) y ya alcanza TP1 (high>=110).
    fetchHistoricalKlines.mockResolvedValue([
      { high: 112, low: 99 }, { high: 113, low: 108 },
    ]);
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      timestamp: iso(now - 2 * 24 * HOUR),
      has_executable_setup: 1,
      setup_entry_price: 100, setup_stop_price: 95, setup_tp1_price: 110, setup_tp2_price: 120,
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.setup_hit_tp1).toBe(1);
    expect(out.setup_outcome).toBe('tp1');
  });
});
