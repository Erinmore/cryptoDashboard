/**
 * derivativesScore.test.js — rúbrica determinista del Derivatives Score (2026-07-29).
 *
 * Contexto: hasta esta fecha el score lo puntuaba el LLM con dos reglas que disparaban el
 * 0,0 % del tiempo sobre 90 días × 3 monedas, así que salía 0 siempre y con él quedaban
 * cerradas AMBAS puertas direccionales. Estos tests fijan la rúbrica medida que lo sustituye.
 */

import { describe, test, expect } from '@jest/globals';
import {
  computeDerivativesScore, oiPriceCell, liquidationCascade, fundingTerm, windowScale, priceBandPct,
  priceChange24hFromCandles, DERIVATIVES_RUBRIC,
} from '../src/utils/derivativesScore.js';

// ATR% 1,3 en 4h → banda de precio = 0,5 × 1,3 × √6 ≈ 1,59 %.
const ATR = 1.3;
const BAND = 0.5 * ATR * Math.sqrt(6);

/** Cascada válida por defecto: mediana sobre 30 días completos. */
const cascada = (over = {}) => ({
  skew: -0.8, magnitude_vs_median_30d: 3.0, median_window_points: 697, ...over,
});

describe('windowScale', () => {
  test('4h → √6 (24h son 6 velas)', () => {
    expect(windowScale('4h')).toBeCloseTo(Math.sqrt(6), 6);
  });
  test('1h → √24', () => {
    expect(windowScale('1h')).toBeCloseTo(Math.sqrt(24), 6);
  });
  test('1D y 1W → 1: la ventana de 24h no llega a una vela, no se sub-escala', () => {
    expect(windowScale('1D')).toBe(1);
    expect(windowScale('1W')).toBe(1);
  });
  test('TF desconocido → fallback a 4h, el TF de producción', () => {
    expect(windowScale('30m')).toBeCloseTo(Math.sqrt(6), 6);
  });
});

describe('priceChange24hFromCandles — la fuente del precio está FIJADA a propósito', () => {
  // La banda 0,5×ATR%×√n se calibró contra cierre-a-cierre de klines de Binance en fronteras
  // de vela. Usar `price_change_24h_pct` (CoinGecko, rolling, otra fuente) invalidaría la
  // constante en silencio. Estos tests fijan el contrato.
  const velas = (closes) => closes.map((close) => ({ close }));

  test('4h → compara contra 6 velas atrás (24h)', () => {
    // 8 velas: la última es 110, la de 6 atrás es 100 → +10 %.
    const c = velas([90, 100, 101, 102, 103, 104, 105, 110]);
    expect(priceChange24hFromCandles(c, '4h')).toBeCloseTo(10, 6);
  });

  test('1h → compara contra 24 velas atrás', () => {
    const c = velas([...Array(24).fill(100), 105]);
    expect(priceChange24hFromCandles(c, '1h')).toBeCloseTo(5, 6);
  });

  test('1D → una sola vela atrás (24h no da para más)', () => {
    expect(priceChange24hFromCandles(velas([100, 97]), '1D')).toBeCloseTo(-3, 6);
  });

  test('signo negativo en caída', () => {
    // La referencia es la vela 6 ATRÁS desde la última, o sea el índice 1 en un array de 8.
    const c = velas([999, 100, 99, 98, 97, 96, 95, 90]);
    expect(priceChange24hFromCandles(c, '4h')).toBeCloseTo(-10, 6);
  });

  test('sin historia suficiente → null (no se inventa un 0)', () => {
    expect(priceChange24hFromCandles(velas([100, 101, 102]), '4h')).toBeNull();
    expect(priceChange24hFromCandles([], '4h')).toBeNull();
    expect(priceChange24hFromCandles(null, '4h')).toBeNull();
  });

  test('cierres corruptos → null', () => {
    const c = velas([100, 1, 1, 1, 1, 1, 1]);
    c[0].close = 0;                       // divisor cero
    expect(priceChange24hFromCandles(c, '4h')).toBeNull();
  });

  test('null se propaga a data_missing en el score, no a un 0 silencioso', () => {
    const r = computeDerivativesScore({
      oiChange24hPct: 5,
      priceChange24hPct: priceChange24hFromCandles(velas([100, 101]), '4h'),
      atrPct: ATR,
    });
    expect(r.data_insufficient).toBe(true);
  });
});

describe('oiPriceCell — las dos celdas que sobrevivieron al control de momentum', () => {
  const base = { atrPct: ATR, primaryTf: '4h' };

  test('OI↑ px↑ → +1 (dinero nuevo comprando)', () => {
    const r = oiPriceCell({ ...base, oiChange24hPct: 3, priceChange24hPct: BAND + 0.5 });
    expect(r).toEqual({ score: 1, cell: 'new_money_long' });
  });

  test('OI↓ px↑ → -1 (rally sin dinero nuevo: el efecto mejor evidenciado)', () => {
    const r = oiPriceCell({ ...base, oiChange24hPct: -3, priceChange24hPct: BAND + 0.5 });
    expect(r).toEqual({ score: -1, cell: 'failed_rally' });
  });

  test('OI↑ px↓ → 0 pero ETIQUETADA: su efecto aparente era momentum del precio', () => {
    const r = oiPriceCell({ ...base, oiChange24hPct: 3, priceChange24hPct: -(BAND + 0.5) });
    expect(r).toEqual({ score: 0, cell: 'new_money_short' });
  });

  test('OI↓ px↓ → 0 (des-apalancamiento: sin señal en las tres monedas)', () => {
    const r = oiPriceCell({ ...base, oiChange24hPct: -3, priceChange24hPct: -(BAND + 0.5) });
    expect(r).toEqual({ score: 0, cell: 'deleveraging' });
  });

  test('banda muerta del OI (±1 %) anula la celda', () => {
    expect(oiPriceCell({ ...base, oiChange24hPct: 0.5, priceChange24hPct: BAND + 1 }).cell)
      .toBe('no_signal');
  });

  test('banda muerta del precio (0,5×ATR×√6) anula la celda', () => {
    expect(oiPriceCell({ ...base, oiChange24hPct: 5, priceChange24hPct: BAND - 0.1 }).cell)
      .toBe('no_signal');
  });

  test('la banda de precio ESCALA con el ATR: el mismo % puntúa o no según volatilidad', () => {
    const px = 2.0;   // 2 % en 24h
    // ATR 1,3 → banda 1,59: el 2 % la supera.
    expect(oiPriceCell({ ...base, oiChange24hPct: 3, priceChange24hPct: px }).score).toBe(1);
    // ATR 3,0 → banda 3,67: el mismo 2 % ya no la supera.
    expect(oiPriceCell({ ...base, atrPct: 3.0, oiChange24hPct: 3, priceChange24hPct: px }).score).toBe(0);
  });

  test('sin OI, precio o ATR → data_missing, no se inventa señal', () => {
    expect(oiPriceCell({ ...base, oiChange24hPct: null, priceChange24hPct: 5 }).cell).toBe('data_missing');
    expect(oiPriceCell({ ...base, oiChange24hPct: 5, priceChange24hPct: null }).cell).toBe('data_missing');
    expect(oiPriceCell({ ...base, atrPct: 0, oiChange24hPct: 5, priceChange24hPct: 5 }).cell).toBe('data_missing');
  });
});

describe('liquidationCascade — solo la de longs', () => {
  test('longs liquidados con magnitud ≥2× → -1', () => {
    expect(liquidationCascade(cascada()).score).toBe(-1);
  });

  test('shorts liquidados NO puntúa (contradictorio entre monedas, n=7-25)', () => {
    expect(liquidationCascade(cascada({ skew: 0.9 })).score).toBe(0);
  });

  test('skew bajista pero magnitud normal → 0 (es ruido de fondo, no cascada)', () => {
    expect(liquidationCascade(cascada({ magnitude_vs_median_30d: 1.2 })).score).toBe(0);
  });

  test('skew justo en el umbral (-0.5) dispara; por encima no', () => {
    expect(liquidationCascade(cascada({ skew: -0.5 })).score).toBe(-1);
    expect(liquidationCascade(cascada({ skew: -0.49 })).score).toBe(0);
  });

  test('magnitud justo en 2× dispara; por debajo no', () => {
    expect(liquidationCascade(cascada({ magnitude_vs_median_30d: 2 })).score).toBe(-1);
    expect(liquidationCascade(cascada({ magnitude_vs_median_30d: 1.99 })).score).toBe(0);
  });

  test('mediana sobre ventana corta → se ABSTIENE (una mediana adaptativa se apaga en estrés)', () => {
    const r = liquidationCascade(cascada({ median_window_points: 400 }));
    expect(r.score).toBe(0);
    expect(r.reason).toMatch(/insuficiente/);
  });

  test('sin datos normalizados → 0, sin lanzar', () => {
    expect(liquidationCascade({}).score).toBe(0);
    expect(liquidationCascade(null).score).toBe(0);
  });
});

describe('fundingTerm — sin cambios respecto al prompt anterior', () => {
  test('severity_negative extreme → +2 · high → +1', () => {
    expect(fundingTerm({ severity_negative: 'extreme_short_overload' }).score).toBe(2);
    expect(fundingTerm({ severity_negative: 'high_short_overload' }).score).toBe(1);
  });
  test('severity positiva extreme/high → -1', () => {
    expect(fundingTerm({ severity: 'extreme' }).score).toBe(-1);
    expect(fundingTerm({ severity: 'high' }).score).toBe(-1);
  });
  test('normal y elevated no puntúan (el 100 % del tiempo en 90 días: es correcto, son colas)', () => {
    expect(fundingTerm({ severity: 'normal' }).score).toBe(0);
    expect(fundingTerm({ severity: 'elevated' }).score).toBe(0);
    expect(fundingTerm({ severity_negative: 'elevated_short_overload' }).score).toBe(0);
    expect(fundingTerm(null).score).toBe(0);
  });
});

describe('computeDerivativesScore — composición', () => {
  const alcista = { oiChange24hPct: 3, priceChange24hPct: BAND + 1, atrPct: ATR, primaryTf: '4h' };
  const rallyFallido = { oiChange24hPct: -3, priceChange24hPct: BAND + 1, atrPct: ATR, primaryTf: '4h' };
  const sinSenal = { oiChange24hPct: 0.2, priceChange24hPct: 0.1, atrPct: ATR, primaryTf: '4h' };

  test('dinero nuevo comprando → +1', () => {
    expect(computeDerivativesScore(alcista).score).toBe(1);
  });

  test('rally sin dinero nuevo → -1', () => {
    expect(computeDerivativesScore(rallyFallido).score).toBe(-1);
  });

  test('ANTI-DOBLE-CONTEO: la cascada NO suma si la celda ya emitió señal', () => {
    // La celda dice -1 y hay cascada: sin la regla saldría -2.
    const r = computeDerivativesScore({ ...rallyFallido, liquidations: cascada() });
    expect(r.score).toBe(-1);
    expect(r.components.cascade_score).toBe(0);
    expect(r.components.cascade_reason).toMatch(/anti-doble-conteo/);
  });

  test('la cascada SÍ suma cuando la celda calla (49-65 % de los casos medidos)', () => {
    const r = computeDerivativesScore({ ...sinSenal, liquidations: cascada() });
    expect(r.score).toBe(-1);
    expect(r.components.oi_price_score).toBe(0);
    expect(r.components.cascade_score).toBe(-1);
  });

  test('celda + funding de cola llegan a ±2 (la única vía al extremo)', () => {
    const r = computeDerivativesScore({
      ...alcista, funding: { severity_negative: 'high_short_overload' },
    });
    expect(r.score).toBe(2);
  });

  test('clamp a [-2, +2]', () => {
    const r = computeDerivativesScore({
      ...alcista, funding: { severity_negative: 'extreme_short_overload' },  // +1 +2 = 3
    });
    expect(r.score).toBe(2);
  });

  test('OI↑ px↓ NO produce score, y el basis explica por qué', () => {
    const r = computeDerivativesScore({
      oiChange24hPct: 3, priceChange24hPct: -(BAND + 1), atrPct: ATR, primaryTf: '4h',
    });
    expect(r.score).toBe(0);
    expect(r.components.oi_price_cell).toBe('new_money_short');
    expect(r.basis.join(' ')).toMatch(/momentum/);
  });

  test('FAIL-CLOSED: sin eje principal la cascada se abstiene aunque haya cascada real', () => {
    // Patrón H2: sin OI/precio no se puede descartar el doble conteo, así que no se emite
    // señal direccional a ciegas desde un input secundario.
    const r = computeDerivativesScore({
      oiChange24hPct: null, priceChange24hPct: null, atrPct: ATR,
      liquidations: cascada(),
    });
    expect(r.data_insufficient).toBe(true);
    expect(r.components.cascade_score).toBe(0);
    expect(r.score).toBe(0);
    expect(r.components.cascade_reason).toMatch(/doble conteo/);
  });

  test('con eje principal presente, data_insufficient es false', () => {
    expect(computeDerivativesScore(alcista).data_insufficient).toBe(false);
  });

  test('el funding SÍ sigue puntuando sin eje: es absoluto y ortogonal', () => {
    const r = computeDerivativesScore({
      oiChange24hPct: null, priceChange24hPct: null, atrPct: null,
      funding: { severity_negative: 'extreme_short_overload' },
    });
    expect(r.data_insufficient).toBe(true);
    expect(r.score).toBe(2);
  });

  test('sin datos → 0 con basis explícito, nunca lanza', () => {
    const r = computeDerivativesScore();
    expect(r.score).toBe(0);
    expect(r.basis.length).toBeGreaterThan(0);
  });

  test('la salida lleva SIEMPRE la fecha de medición (caduca con el régimen)', () => {
    const r = computeDerivativesScore(alcista);
    expect(r.rubric.measured_at).toBe(DERIVATIVES_RUBRIC.measured_at);
    expect(r.rubric.measured_scope).toMatch(/90d/);
  });

  test('el score cubre el rango que las puertas necesitan', () => {
    // Comprar exige >= +1 y Vender <= -1: ambos alcanzables (antes: 0,0 % del tiempo).
    expect(computeDerivativesScore(alcista).score).toBeGreaterThanOrEqual(1);
    expect(computeDerivativesScore(rallyFallido).score).toBeLessThanOrEqual(-1);
  });
});

/**
 * TELEMETRÍA DE CALIBRACIÓN (2026-08-01). Categoría A: no toca la decisión.
 *
 * Sin `band_pct` no se puede saber a qué distancia del corte quedó cada `no_signal`, que es
 * la magnitud con la que el checkpoint decide 0,50× vs 0,35× y la única forma de falsar la
 * hipótesis del ATR retrasado. Reconstruirla a posteriori no es exacto (la última vela sigue
 * formándose entre el análisis y la auditoría).
 */
describe('components.atr_pct / band_pct — telemetría de la banda', () => {
  const alcista = { oiChange24hPct: 3, priceChange24hPct: BAND + 1, atrPct: ATR, primaryTf: '4h' };

  test('expone el ATR% recibido y la banda derivada de él', () => {
    const r = computeDerivativesScore({ ...alcista });
    expect(r.components.atr_pct).toBe(ATR);
    expect(r.components.band_pct).toBeCloseTo(BAND, 3);
  });

  test('UN SOLO DUEÑO: la banda expuesta es la que usó la celda para decidir', () => {
    // Un movimiento justo por DEBAJO de la banda expuesta no debe puntuar, y justo por
    // encima sí. Si `band_pct` fuese una copia desincronizada, uno de los dos fallaría.
    const base = { oiChange24hPct: 3, atrPct: ATR, primaryTf: '4h' };
    const dentro = computeDerivativesScore({ ...base, priceChange24hPct: BAND - 0.01 });
    const fuera  = computeDerivativesScore({ ...base, priceChange24hPct: BAND + 0.01 });
    expect(dentro.components.oi_price_cell).toBe('no_signal');
    expect(fuera.components.oi_price_cell).toBe('new_money_long');
    expect(dentro.components.band_pct).toBe(fuera.components.band_pct);
    expect(Math.abs(dentro.components.price_change_24h_pct_candles))
      .toBeLessThan(dentro.components.band_pct);
    expect(Math.abs(fuera.components.price_change_24h_pct_candles))
      .toBeGreaterThan(fuera.components.band_pct);
  });

  test('la banda escala con el TF primario (√n), no es una constante', () => {
    const a = computeDerivativesScore({ ...alcista, primaryTf: '4h' });
    const b = computeDerivativesScore({ ...alcista, primaryTf: '1D' });
    expect(a.components.band_pct).toBeCloseTo(0.5 * ATR * Math.sqrt(6), 3);
    expect(b.components.band_pct).toBeCloseTo(0.5 * ATR, 3);   // 24h no llega a una vela → ×1
  });

  test('sin ATR utilizable la banda es null (nunca NaN ni 0) y el fail-closed aguanta', () => {
    for (const atrPct of [null, 0, -1, NaN, undefined]) {
      const r = computeDerivativesScore({ ...alcista, atrPct });
      expect(r.components.band_pct).toBeNull();
      expect(r.data_insufficient).toBe(true);   // el fail-closed sigue intacto
    }
  });

  /**
   * `atr_pct` registra lo que LLEGÓ, no lo que era utilizable — a propósito. Un 0 o un
   * negativo no sirven para calcular la banda (por eso `band_pct` sí es null), pero
   * distinguirlos de "no llegó nada" es justo lo que hace útil una telemetría de diagnóstico:
   * si algún día `technical[tf].atr.pct` empezara a emitir 0 por un bug aguas arriba, un
   * `null` lo confundiría con un dato ausente y el fallo pasaría desapercibido.
   */
  test('atr_pct es un registro FIEL del input: distingue "llegó 0" de "no llegó nada"', () => {
    expect(computeDerivativesScore({ ...alcista, atrPct: 0 }).components.atr_pct).toBe(0);
    expect(computeDerivativesScore({ ...alcista, atrPct: -1 }).components.atr_pct).toBe(-1);
    for (const ausente of [null, undefined, NaN]) {
      expect(computeDerivativesScore({ ...alcista, atrPct: ausente }).components.atr_pct).toBeNull();
    }
  });

  test('priceBandPct es una función pura y coincide con lo expuesto', () => {
    expect(priceBandPct(ATR, '4h')).toBeCloseTo(BAND, 10);
    expect(priceBandPct(null, '4h')).toBeNull();
    expect(priceBandPct(0, '4h')).toBeNull();
    expect(computeDerivativesScore({ ...alcista }).components.band_pct)
      .toBeCloseTo(priceBandPct(ATR, '4h'), 3);
  });
});
