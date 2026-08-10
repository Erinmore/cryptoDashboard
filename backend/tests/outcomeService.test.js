/**
 * outcomeService.test.js — job de grabación de mercado (services/outcomeService.js).
 *
 * `processAnalysis` es interna; se ejerce vía `runOutcomeJob` con mocks ESM de
 * coingeckoService (fetch de precios/klines) y dbService (candidatos + upsert), dejando
 * `utils/outcome.js` real (funciones puras). Se captura lo que recibe `upsertOutcome`.
 *
 * Pivot a ayudante de riesgo (§REORIENTACIÓN): el barrier del `setup` ejecutable y el
 * shadow trade del `conditional_setup` se retiraron de `processAnalysis` — ningún análisis
 * nuevo declara ninguno de los dos. Lo que queda es la grabación PURA de mercado: precios a
 * horizonte, PnL (crudo y firmado por dirección, cuando la haya) y métricas de recorrido.
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

// El barrier del `setup` ejecutable y el shadow trade del `conditional_setup` se retiraron
// de `processAnalysis` con el pivot a ayudante de riesgo (§REORIENTACIÓN): ningún análisis
// nuevo declara ninguno de los dos, así que no hay nada que cablear aquí. Las columnas
// `setup_*`/`cond_*` se preservan explícitamente para filas viejas (ver outcomeService.js) —
// esa preservación se ejercita indirectamente en las suites que quedan, no necesita su
// propia batería de escenarios de barrier/shadow trade.

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

describe('runOutcomeJob — banda muerta normalizada por ATR', () => {
  const velas = (tMs, pares) => pares.map(([high, low], i) => ({
    t: tMs + i * HOUR, open: low, close: high, high, low, volume: 1,
  }));

  test('con ATR alto, un movimiento pequeño se clasifica flat (no win)', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    // +0.5% a 24h. Con el 0.3% fijo sería 'win'; con ATR% 4 la banda es 1% → 'flat'.
    fetchHistoricalClose.mockResolvedValue(100.5);
    fetchHistoricalKlines
      .mockResolvedValueOnce(velas(tMs, [[101, 99]]))
      .mockResolvedValueOnce(velas(tMs - 80 * HOUR, Array(20).fill([104, 96])));
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Comprar', primary_tf: '4h', timestamp: iso(tMs),
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.atr_pct_at_analysis).toBeGreaterThan(2);
    expect(out.outcome_24h).toBe('flat');
  });

  test('sin ATR reconstruible se cae al 0.3% fijo', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    fetchHistoricalClose.mockResolvedValue(100.5); // +0.5% > 0.3% → win
    fetchHistoricalKlines
      .mockResolvedValueOnce(velas(tMs, [[101, 99]]))
      .mockResolvedValueOnce([]);
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Comprar', primary_tf: '4h', timestamp: iso(tMs),
    })]);

    await runOutcomeJob();

    const out = upsertOutcome.mock.calls[0][0];
    expect(out.atr_pct_at_analysis).toBeNull();
    expect(out.outcome_24h).toBe('win');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B1 (2026-08-09) — unificación de los dos ATR%. `atr_pct_decision` (180 velas, persistido
// desde `assembleAnalyzeContext`) se prefiere sobre la reconstrucción de 19 velas
// (`fetchAtrPctAt`), que queda de fallback solo para filas anteriores a este campo.
// ─────────────────────────────────────────────────────────────────────────────
describe('runOutcomeJob — atr_pct_decision (B1, unificación de los dos ATR%)', () => {
  const velas = (tMs, pares) => pares.map(([high, low], i) => ({
    t: tMs + i * HOUR, open: low, close: high, high, low, volume: 1,
  }));

  test('atr_pct_decision presente → se usa tal cual, sin reconstruir con klines', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    fetchHistoricalKlines.mockResolvedValueOnce(velas(tMs, [[103, 99]]));
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar', primary_tf: '4h', timestamp: iso(tMs),
      atr_pct_decision: 1.75,
    })]);

    await runOutcomeJob();

    // Solo la llamada del recorrido: ninguna para reconstruir el ATR.
    expect(fetchHistoricalKlines).toHaveBeenCalledTimes(1);
    const out = upsertOutcome.mock.calls[0][0];
    expect(out.atr_pct_at_analysis).toBe(1.75);
  });

  test('atr_pct_at_analysis ya persistido gana sobre atr_pct_decision (no lo pisa)', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    fetchHistoricalKlines.mockResolvedValueOnce(velas(tMs, [[103, 99]]));
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar', primary_tf: '4h', timestamp: iso(tMs),
      atr_pct_at_analysis: 2.5, atr_pct_decision: 1.75,
    })]);

    await runOutcomeJob();

    expect(fetchHistoricalKlines).toHaveBeenCalledTimes(1);
    expect(upsertOutcome.mock.calls[0][0].atr_pct_at_analysis).toBe(2.5);
  });

  test('fila LEGACY sin atr_pct_decision → cae al fallback de 19 velas (sin regresión)', async () => {
    const now = Date.now();
    const tMs = now - 25 * HOUR;
    fetchHistoricalKlines
      .mockResolvedValueOnce(velas(tMs, [[103, 99]]))
      .mockResolvedValueOnce(velas(tMs - 30 * 4 * HOUR, Array(20).fill([102, 98])));
    getAnalysesNeedingOutcome.mockReturnValue([analysisRow({
      action: 'Esperar', primary_tf: '4h', timestamp: iso(tMs),
      // sin atr_pct_decision ni atr_pct_at_analysis
    })]);

    await runOutcomeJob();

    // Recorrido + reconstrucción de 19 velas: el fallback sigue vivo para filas viejas.
    expect(fetchHistoricalKlines).toHaveBeenCalledTimes(2);
    expect(upsertOutcome.mock.calls[0][0].atr_pct_at_analysis).toBeGreaterThan(0);
  });
});

