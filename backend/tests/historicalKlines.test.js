/**
 * historicalKlines.test.js — `fetchHistoricalKlines` debe arrastrar los campos de AGRESOR.
 *
 * Regresión concreta: el mapeo devolvía solo OHLCV y descartaba `taker_buy_base` (índice 9
 * de la kline), aunque Binance lo sirve también para fechas pasadas. Sin ese campo,
 * `calculateCVD` cae al proxy heurístico `(close-low)/(high-low)`, que NO es la misma
 * medida: sobre el mismo día de SOL el delta salía −7.566 con taker real y +542.289 con la
 * heurística — signo opuesto. Reconstruir histórico así mezclaría filas `heuristic` con las
 * `taker_real` del poller, en la misma serie y sin marca que las distinga.
 *
 * La omisión era inocua mientras la función solo alimentaba el barrier de setups y las
 * métricas de recorrido (que usan high/low), y por eso pasó desapercibida. Este test la
 * fija para que no vuelva.
 */

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const get = jest.fn();
jest.unstable_mockModule('axios', () => ({
  default: { get, create: () => ({ get, interceptors: { request: { use: () => {} }, response: { use: () => {} } } }) },
}));

const { fetchHistoricalKlines } = await import('../src/services/coingeckoService.js');
const { calculateCVD } = await import('../src/utils/indicators.js');

/** Kline de Binance: 12 campos, con taker_buy_base en el índice 9. */
const kline = (t, o, h, l, c, vol, takerBuy) => ([
  t, String(o), String(h), String(l), String(c), String(vol),
  t + 59999, String(vol * c), 100, String(takerBuy), String(takerBuy * c), '0',
]);

beforeEach(() => jest.clearAllMocks());

describe('fetchHistoricalKlines — campos de agresor', () => {
  test('mapea taker_buy_base, taker_buy_quote y quote_volume', async () => {
    get.mockResolvedValue({ data: [kline(1000, 10, 12, 9, 11, 100, 70)] });

    const [c] = await fetchHistoricalKlines('SOL', '1d', 0, 1);

    expect(c.taker_buy_base).toBe(70);
    expect(c.taker_buy_quote).toBe(770);
    expect(c.quote_volume).toBe(1100);
    expect(c.high).toBe(12);  // no se rompe lo que ya funcionaba
    expect(c.low).toBe(9);
  });

  test('el CVD reconstruido sale taker_real, no heurístico', async () => {
    // Compradores agresores en minoría (30/100) pero el cierre pegado al máximo: la
    // heurística leería compra fuerte y el dato real dice lo contrario. Es justo el caso
    // en el que las dos definiciones divergen en SIGNO.
    const velas = Array.from({ length: 30 }, (_, i) =>
      kline(i * 86400000, 10, 12, 9, 11.9, 100, 30));
    get.mockResolvedValue({ data: velas });

    const candles = await fetchHistoricalKlines('SOL', '1d', 0, 1);
    const cvd = calculateCVD(candles);

    expect(cvd.source).toBe('taker_real');
    expect(cvd.value).toBeLessThan(0); // 2*30 - 100 = -40 por vela → presión vendedora
  });

  test('sin los campos de agresor el mismo cálculo daría el signo contrario', async () => {
    // Documenta POR QUÉ importa el mapeo: mismas velas, sin taker → heurística → alcista.
    const velas = Array.from({ length: 30 }, (_, i) =>
      kline(i * 86400000, 10, 12, 9, 11.9, 100, 30));
    get.mockResolvedValue({ data: velas });
    const candles = await fetchHistoricalKlines('SOL', '1d', 0, 1);

    const sinTaker = candles.map(({ taker_buy_base, ...resto }) => resto);
    const cvd = calculateCVD(sinTaker);

    expect(cvd.source).toBe('heuristic');
    expect(cvd.value).toBeGreaterThan(0); // signo OPUESTO al real
  });
});
