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
    // Sin geometría el barrier no se evalúa. Las klines de 1h SÍ se piden desde la Fase 5,
    // pero para las métricas de recorrido (que no dependen del setup), no para el barrier.
    expect(out.setup_hit_tp1).toBe(0);
  });

  test('ya invalidado antes → no reprocesa el setup (setupResolved)', async () => {
    const now = Date.now();
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      timestamp: iso(now - 2 * HOUR),
      has_executable_setup: 1,
      setup_entry_price: null,
      setup_outcome: 'invalid', setup_hit_tp1: 0, setup_hit_tp2: 0, setup_hit_stop: 0,
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.setup_outcome).toBe('invalid'); // preservado, sin re-evaluar el barrier
  });
});

describe('runOutcomeJob — métricas de recorrido (Fase 5)', () => {
  /** Velas horarias desde `tMs` a partir de pares [high, low]. */
  const pathCandles = (tMs, pairs) => pairs.map(([high, low], i) => ({
    t: tMs + i * HOUR, open: low, close: high, high, low, volume: 1,
  }));

  test('un Esperar obtiene recorrido medible — lo que classifyOutcome no puede dar', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    // 1ª llamada = recorrido posterior (1h); 2ª = velas del TF primario para el ATR.
    fetchHistoricalKlines
      .mockResolvedValueOnce(pathCandles(tMs, [[103, 99], [106, 100], [104, 97]]))
      .mockResolvedValueOnce(pathCandles(tMs - 30 * 4 * HOUR, Array(20).fill([102, 98])));
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar', primary_tf: '4h', timestamp: iso(tMs),
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    // El win-rate direccional es null para un Esperar; el recorrido no.
    expect(out.pnl_signed_pct_24h).toBeNull();
    expect(out.max_up_pct_24h).toBe(6);
    expect(out.max_down_pct_24h).toBe(-3);
    expect(out.atr_pct_at_analysis).toBeGreaterThan(0);
    expect(out.path_first_passage).not.toBeNull();
  });

  test('ATR ya persistido → no se vuelve a pedir (una sola llamada de klines)', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    fetchHistoricalKlines.mockResolvedValue(pathCandles(tMs, [[103, 99]]));
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar', primary_tf: '4h', timestamp: iso(tMs),
      atr_pct_at_analysis: 1.5,
    })]);

    await runOutcomeJob();

    expect(fetchHistoricalKlines).toHaveBeenCalledTimes(1); // solo el recorrido
    const out = upsertOutcome.mock.calls[0][0];
    expect(out.atr_pct_at_analysis).toBe(1.5);
  });

  test('fallo de klines → métricas a null, sin romper el resto del outcome', async () => {
    const now = Date.now();
    fetchHistoricalKlines.mockRejectedValue(new Error('binance down'));
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar', primary_tf: '4h', timestamp: iso(now - 25 * HOUR),
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.max_up_pct_24h).toBeUndefined(); // no se escriben → el COALESCE preserva
    expect(out.atr_pct_at_analysis).toBeNull();
    expect(out.pnl_pct_24h).toBe(0); // el resto del outcome sigue calculándose
  });

  test('sin ATR reconstruible se conservan las excursiones y se pierde solo la rejilla', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    fetchHistoricalKlines
      .mockResolvedValueOnce(pathCandles(tMs, [[110, 99]]))
      .mockResolvedValueOnce([]);  // ATR: sin velas previas utilizables
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar', primary_tf: '4h', timestamp: iso(tMs),
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.atr_pct_at_analysis).toBeNull();
    expect(out.max_up_pct_24h).toBe(10);
    expect(out.path_first_passage).toBeNull();
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

describe('runOutcomeJob — PnL firmado por dirección (auditoría #2, hallazgo 3)', () => {
  test('Vender con precio cayendo → pnl crudo negativo, pnl firmado positivo (win)', async () => {
    const now = Date.now();
    fetchHistoricalClose.mockResolvedValue(90); // -10% a todos los horizontes vencidos
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Vender',
      timestamp: iso(now - 25 * HOUR), // 24h vencido, 7d no
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.pnl_pct_24h).toBe(-10);        // drift crudo del precio
    expect(out.pnl_signed_pct_24h).toBe(10);  // PnL de la estrategia (short ganador)
    expect(out.outcome_24h).toBe('win');
  });

  test('Esperar → pnl firmado null (no direccional), crudo se conserva', async () => {
    const now = Date.now();
    fetchHistoricalClose.mockResolvedValue(105);
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar',
      timestamp: iso(now - 25 * HOUR),
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.pnl_pct_24h).toBe(5);
    expect(out.pnl_signed_pct_24h).toBeNull();
  });
});
