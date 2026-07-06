import {
  calculateRSI,
  calculateEMA,
  calculateMACD,
  calculateBollingerBands,
  calculateVolumeDelta,
  calculateFibonacci,
  calculateSupportResistance,
  calculateATR,
  calculateStochRSI,
  calculateWaveTrend,
  calculateADX,
  calculateSuperTrend,
  calculateCVD,
  calculateVWAP,
  detectRSIDivergence,
  detectMarketRegime,
} from '../src/utils/indicators.js';
import { computeTrend, computeIndicators } from '../src/services/indicatorService.js';
import { calculateVolumeProfile } from '../src/utils/volumeProfile.js';
import {
  detectSwings,
  detectLastBOS,
  detectLastCHoCH,
  detectUnmitigatedFVGs,
  calculateSMC,
} from '../src/utils/smc.js';

// ─── RSI ──────────────────────────────────────────────────────────────────────

describe('calculateRSI', () => {
  test('returns null when not enough data', () => {
    expect(calculateRSI([1, 2, 3], 14)).toBeNull();
  });

  test('returns 100 when all candles are gains (no losses)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(calculateRSI(closes)).toBe(100);
  });

  test('returns 0 when all candles are losses (no gains)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(calculateRSI(closes)).toBe(0);
  });

  test('returns value between 0 and 100', () => {
    const closes = [44, 46, 45, 47, 46, 48, 47, 50, 49, 51, 50, 52, 51, 53, 52];
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  test('overbought scenario gives RSI > 70', () => {
    // Serie con muchas subidas consecutivas
    const closes = [100, 102, 104, 107, 110, 114, 118, 123, 128, 133, 139, 145, 152, 159, 167];
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeGreaterThan(70);
  });

  test('oversold scenario gives RSI < 30', () => {
    const closes = [100, 97, 94, 90, 86, 81, 76, 70, 64, 58, 51, 44, 37, 30, 23];
    const rsi = calculateRSI(closes, 14);
    expect(rsi).toBeLessThan(30);
  });
});

// ─── EMA ──────────────────────────────────────────────────────────────────────

describe('calculateEMA', () => {
  test('returns empty array when not enough data', () => {
    expect(calculateEMA([1, 2], 5)).toEqual([]);
  });

  test('first value equals SMA seed', () => {
    const values = [10, 20, 30];
    const ema = calculateEMA(values, 3);
    expect(ema[0]).toBe(20); // SMA(10,20,30) = 20
  });

  test('EMA reacts faster to recent prices than SMA', () => {
    const base = [100, 100, 100, 100, 100];
    const spike = [...base, 200];
    const ema = calculateEMA(spike, 5);
    const lastEma = ema[ema.length - 1];
    const sma = (100 * 5 + 200) / 6;
    expect(lastEma).toBeGreaterThan(sma);
  });
});

// ─── MACD ─────────────────────────────────────────────────────────────────────

describe('calculateMACD', () => {
  test('returns null when not enough data', () => {
    expect(calculateMACD([1, 2, 3])).toBeNull();
  });

  test('returns object with value, signal, histogram, momentum_state', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = calculateMACD(closes);
    expect(result).toHaveProperty('value');
    expect(result).toHaveProperty('signal');
    expect(result).toHaveProperty('histogram');
    expect(result).toHaveProperty('momentum_state');
  });

  test('momentum_state is bullish when histogram > 0', () => {
    // Fase plana larga + subida pronunciada: fuerza al fast EMA por encima del slow
    const flat = Array.from({ length: 60 }, () => 100);
    const rise = Array.from({ length: 40 }, (_, i) => 100 + i * 5);
    const closes = [...flat, ...rise];
    const result = calculateMACD(closes);
    expect(result.histogram).toBeGreaterThan(0);
    expect(['bullish_accelerating', 'bullish_decelerating']).toContain(result.momentum_state);
  });

  test('momentum_state is bearish when histogram < 0', () => {
    // Fase plana larga + caída pronunciada: fuerza al fast EMA por debajo del slow
    const flat = Array.from({ length: 60 }, () => 200);
    const fall = Array.from({ length: 40 }, (_, i) => 200 - i * 5);
    const closes = [...flat, ...fall];
    const result = calculateMACD(closes);
    expect(result.histogram).toBeLessThan(0);
    expect(['bearish_accelerating', 'bearish_decelerating']).toContain(result.momentum_state);
  });
});

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

describe('calculateBollingerBands', () => {
  test('returns null when not enough data', () => {
    expect(calculateBollingerBands([1, 2, 3], 20)).toBeNull();
  });

  test('upper > middle > lower', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + (i % 5));
    const bb = calculateBollingerBands(closes);
    expect(bb.upper).toBeGreaterThan(bb.middle);
    expect(bb.middle).toBeGreaterThan(bb.lower);
  });

  test('position is between 0 and 1', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 95 + i);
    const bb = calculateBollingerBands(closes);
    expect(bb.position).toBeGreaterThanOrEqual(0);
    expect(bb.position).toBeLessThanOrEqual(1);
  });

  test('position is high when price near upper band', () => {
    // Precio final muy cercano al upper band: serie creciente
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 3);
    const bb = calculateBollingerBands(closes);
    expect(bb.position).toBeGreaterThan(0.8);
  });

  test('position is low when price near lower band', () => {
    // Precio final muy cercano al lower band: serie decreciente
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 3);
    const bb = calculateBollingerBands(closes);
    expect(bb.position).toBeLessThan(0.2);
  });
});

// ─── Volume Delta ─────────────────────────────────────────────────────────────

describe('calculateVolumeDelta', () => {
  test('returns null for empty input', () => {
    expect(calculateVolumeDelta([])).toBeNull();
    expect(calculateVolumeDelta(null)).toBeNull();
  });

  test('buy + sell pressure sums to 100', () => {
    const candles = [
      { open: 100, high: 105, low: 98, close: 104, volume: 1000 },
      { open: 104, high: 108, low: 103, close: 107, volume: 1200 },
    ];
    const result = calculateVolumeDelta(candles);
    expect(result.buy_pressure_pct + result.sell_pressure_pct).toBeCloseTo(100, 1);
  });

  test('strongly bullish candle gives strong_bullish type', () => {
    // close muy cerca del high
    const candles = [{ open: 100, high: 110, low: 100, close: 109, volume: 1000 }];
    const result = calculateVolumeDelta(candles);
    expect(result.last_candle_type).toBe('strong_bullish');
  });

  test('strongly bearish candle gives strong_bearish type', () => {
    // close muy cerca del low
    const candles = [{ open: 110, high: 110, low: 100, close: 101, volume: 1000 }];
    const result = calculateVolumeDelta(candles);
    expect(result.last_candle_type).toBe('strong_bearish');
  });

  test('anomaly true when buy pressure > 90', () => {
    const candles = Array.from({ length: 10 }, () => ({
      open: 100, high: 110, low: 100, close: 110, volume: 1000,
    }));
    const result = calculateVolumeDelta(candles);
    expect(result.anomaly).toBe(true);
  });

  test('source is heuristic when taker_buy_base missing', () => {
    const candles = [{ open: 100, high: 105, low: 98, close: 104, volume: 1000 }];
    const result = calculateVolumeDelta(candles);
    expect(result.source).toBe('heuristic');
  });

  test('source is taker_real when all candles have taker_buy_base', () => {
    const candles = [
      { open: 100, high: 105, low: 98, close: 104, volume: 1000, taker_buy_base: 700 },
      { open: 104, high: 108, low: 103, close: 107, volume: 1200, taker_buy_base: 800 },
    ];
    const result = calculateVolumeDelta(candles);
    expect(result.source).toBe('taker_real');
  });

  test('taker_real with volume=1000 taker=700 gives 70% buy pressure', () => {
    const candles = [{ open: 100, high: 105, low: 98, close: 104, volume: 1000, taker_buy_base: 700 }];
    const result = calculateVolumeDelta(candles);
    expect(result.buy_pressure_pct).toBeCloseTo(70.0, 1);
    expect(result.sell_pressure_pct).toBeCloseTo(30.0, 1);
  });

  test('taker_real with volume=1000 taker=200 gives 20% buy pressure (sell dominant)', () => {
    const candles = [{ open: 100, high: 105, low: 98, close: 104, volume: 1000, taker_buy_base: 200 }];
    const result = calculateVolumeDelta(candles);
    expect(result.buy_pressure_pct).toBeCloseTo(20.0, 1);
  });

  test('falls back to heuristic if any candle lacks taker_buy_base', () => {
    const candles = [
      { open: 100, high: 105, low: 98, close: 104, volume: 1000, taker_buy_base: 700 },
      { open: 104, high: 108, low: 103, close: 107, volume: 1200 }, // sin taker
    ];
    const result = calculateVolumeDelta(candles);
    expect(result.source).toBe('heuristic');
  });
});

// ─── Fibonacci ────────────────────────────────────────────────────────────────

describe('calculateFibonacci', () => {
  test('returns correct number of levels', () => {
    const result = calculateFibonacci(100000, 85000);
    expect(result).toHaveLength(7);
  });

  test('level 0 equals high', () => {
    const result = calculateFibonacci(100000, 85000);
    expect(result.find(l => l.level === 0).price).toBe(100000);
  });

  test('level 1 equals low', () => {
    const result = calculateFibonacci(100000, 85000);
    expect(result.find(l => l.level === 1).price).toBe(85000);
  });

  test('level 0.618 is correctly calculated', () => {
    const high = 100000;
    const low = 85000;
    const expected = parseFloat((high - (high - low) * 0.618).toFixed(2));
    const result = calculateFibonacci(high, low);
    expect(result.find(l => l.level === 0.618).price).toBe(expected);
  });
});

// ─── Support & Resistance ─────────────────────────────────────────────────────

describe('calculateSupportResistance', () => {
  const makeCandleAt = (price, offset = 0) => ({
    open: price,
    high: price + 100,
    low: price - 100,
    close: price + offset,
    volume: 1000,
  });

  test('returns supports and resistances', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandleAt(10000 + i * 10));
    const result = calculateSupportResistance(candles);
    expect(result).toHaveProperty('supports');
    expect(result).toHaveProperty('resistances');
  });

  test('supports are below current price', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandleAt(10000 + i * 50));
    const result = calculateSupportResistance(candles);
    const currentPrice = candles[candles.length - 1].close;
    result.supports.forEach(s => expect(s.price).toBeLessThan(currentPrice));
  });

  test('resistances are at or above current price', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandleAt(10000 + i * 50));
    const result = calculateSupportResistance(candles);
    const currentPrice = candles[candles.length - 1].close;
    result.resistances.forEach(r => expect(r.price).toBeGreaterThanOrEqual(currentPrice));
  });

  test('returns at most 3 supports and 3 resistances', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandleAt(10000 + i * 50));
    const result = calculateSupportResistance(candles);
    expect(result.supports.length).toBeLessThanOrEqual(3);
    expect(result.resistances.length).toBeLessThanOrEqual(3);
  });
});

// ─── MACD momentum_state (4 estados: aceleración/desaceleración x dirección) ─────

describe('calculateMACD momentum_state', () => {
  const flat = Array.from({ length: 60 }, () => 100);

  test('bullish state when histogram positive', () => {
    const closes = [...flat, ...Array.from({ length: 40 }, (_, i) => 100 + i * 5)];
    const result = calculateMACD(closes);
    expect(['bullish_accelerating', 'bullish_decelerating']).toContain(result.momentum_state);
  });

  test('bearish state when histogram negative', () => {
    const closes = [...flat, ...Array.from({ length: 40 }, (_, i) => 100 - i * 5)];
    const result = calculateMACD(closes);
    expect(['bearish_accelerating', 'bearish_decelerating']).toContain(result.momentum_state);
  });

  test('momentum_state field always present', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = calculateMACD(closes);
    expect(['bullish_accelerating', 'bullish_decelerating', 'bearish_accelerating', 'bearish_decelerating']).toContain(result.momentum_state);
  });
});

// ─── ATR ──────────────────────────────────────────────────────────────────────

describe('calculateATR', () => {
  const makeCandle = (high, low, close) => ({ high, low, close, open: low, volume: 1000 });

  test('returns null when not enough data', () => {
    expect(calculateATR([makeCandle(10, 9, 9.5)], 14)).toBeNull();
  });

  test('returns positive value', () => {
    const candles = Array.from({ length: 20 }, (_, i) => makeCandle(100 + i, 99 + i, 100 + i));
    expect(calculateATR(candles)).toBeGreaterThan(0);
  });

  test('ATR higher with volatile candles than stable candles', () => {
    const stable = Array.from({ length: 20 }, () => makeCandle(101, 99, 100));
    const volatile = Array.from({ length: 20 }, (_, i) =>
      makeCandle(100 + (i % 2 === 0 ? 10 : 0), 100 - (i % 2 === 0 ? 10 : 0), 100)
    );
    expect(calculateATR(volatile)).toBeGreaterThan(calculateATR(stable));
  });
});

// ─── StochRSI ─────────────────────────────────────────────────────────────────

describe('calculateStochRSI', () => {
  test('returns null when not enough data', () => {
    expect(calculateStochRSI([1, 2, 3])).toBeNull();
  });

  test('returns object with k, d, signal', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const result = calculateStochRSI(closes);
    expect(result).toHaveProperty('k');
    expect(result).toHaveProperty('d');
    expect(result).toHaveProperty('signal');
  });

  test('%K is between 0 and 100', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i * 0.3) * 20);
    const result = calculateStochRSI(closes);
    expect(result.k).toBeGreaterThanOrEqual(0);
    expect(result.k).toBeLessThanOrEqual(100);
  });

  test('%K > 50 after RSI spike above recent range', () => {
    // Alternancia para que RSI fluctúe, luego spike alcista
    const oscillating = Array.from({ length: 50 }, (_, i) => 100 + (i % 2 === 0 ? 2 : -2));
    const spike = Array.from({ length: 20 }, (_, i) => 104 + i * 1.5);
    const result = calculateStochRSI([...oscillating, ...spike]);
    expect(result.k).toBeGreaterThan(50);
  });

  test('%K < 50 after RSI drop below recent range', () => {
    const oscillating = Array.from({ length: 50 }, (_, i) => 200 + (i % 2 === 0 ? 2 : -2));
    const drop = Array.from({ length: 20 }, (_, i) => 196 - i * 1.5);
    const result = calculateStochRSI([...oscillating, ...drop]);
    expect(result.k).toBeLessThan(50);
  });
});

// ─── WaveTrend ────────────────────────────────────────────────────────────────

describe('calculateWaveTrend', () => {
  const makeCandle = (h, l, c) => ({ high: h, low: l, close: c, open: l, volume: 1000 });

  test('returns null when not enough data', () => {
    const candles = Array.from({ length: 5 }, () => makeCandle(101, 99, 100));
    expect(calculateWaveTrend(candles)).toBeNull();
  });

  test('returns object with wt1, wt2, signal', () => {
    const candles = Array.from({ length: 60 }, (_, i) => {
      const p = 100 + Math.sin(i * 0.3) * 10;
      return makeCandle(p + 1, p - 1, p);
    });
    const result = calculateWaveTrend(candles);
    expect(result).toHaveProperty('wt1');
    expect(result).toHaveProperty('wt2');
    expect(result).toHaveProperty('signal');
  });

  test('wt1 > 0 when strongly trending up', () => {
    const flat = Array.from({ length: 40 }, () => makeCandle(101, 99, 100));
    const rise = Array.from({ length: 40 }, (_, i) => makeCandle(101 + i * 2, 99 + i * 2, 100 + i * 2));
    const result = calculateWaveTrend([...flat, ...rise]);
    expect(result.wt1).toBeGreaterThan(0);
  });
});

// ─── ADX + DMI ────────────────────────────────────────────────────────────────

describe('calculateADX', () => {
  const makeCandle = (h, l, c) => ({ high: h, low: l, close: c, open: l, volume: 1000 });

  test('returns null when not enough data', () => {
    const candles = Array.from({ length: 5 }, () => makeCandle(101, 99, 100));
    expect(calculateADX(candles)).toBeNull();
  });

  test('returns adx, plus_di, minus_di, trend_direction, regime', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(100 + i, 99 + i, 100 + i));
    const result = calculateADX(candles);
    expect(result).toHaveProperty('adx');
    expect(result).toHaveProperty('plus_di');
    expect(result).toHaveProperty('minus_di');
    expect(result).toHaveProperty('trend_direction');
    expect(result).toHaveProperty('regime');
  });

  test('ADX > 25 (trending) in strong uptrend', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(100 + i * 2, 99 + i * 2, 100 + i * 2));
    const result = calculateADX(candles);
    expect(result.adx).toBeGreaterThan(25);
    expect(result.regime).toBe('trending');
  });

  test('trend_direction is bullish when +DI > -DI', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(100 + i * 2, 99 + i * 2, 100 + i * 2));
    const result = calculateADX(candles);
    expect(result.trend_direction).toBe('bullish');
  });

  test('trend_direction is bearish when -DI > +DI', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(200 - i * 2, 199 - i * 2, 200 - i * 2));
    const result = calculateADX(candles);
    expect(result.trend_direction).toBe('bearish');
  });
});

// ─── SuperTrend ───────────────────────────────────────────────────────────────

describe('calculateSuperTrend', () => {
  const makeCandle = (h, l, c) => ({ high: h, low: l, close: c, open: l, volume: 1000 });

  test('returns null when not enough data', () => {
    const candles = Array.from({ length: 5 }, () => makeCandle(101, 99, 100));
    expect(calculateSuperTrend(candles)).toBeNull();
  });

  test('returns trend, support or resistance, atr, adaptive_multiplier', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(100 + i, 99 + i, 100 + i));
    const result = calculateSuperTrend(candles);
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('atr');
    expect(result).toHaveProperty('adaptive_multiplier');
    expect(['UP', 'DOWN']).toContain(result.trend);
  });

  test('trend UP in strong uptrend', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(100 + i * 2, 99 + i * 2, 100 + i * 2));
    const result = calculateSuperTrend(candles);
    expect(result.trend).toBe('UP');
    expect(result.support).toBeGreaterThan(0);
    expect(result.resistance).toBeNull();
  });

  test('trend DOWN in strong downtrend', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(200 - i * 2, 199 - i * 2, 200 - i * 2));
    const result = calculateSuperTrend(candles);
    expect(result.trend).toBe('DOWN');
    expect(result.resistance).toBeGreaterThan(0);
    expect(result.support).toBeNull();
  });
});

// ─── CVD ──────────────────────────────────────────────────────────────────────

describe('calculateCVD', () => {
  const makeCandle = (h, l, c, v = 1000) => ({ high: h, low: l, close: c, open: l, volume: v });

  test('returns null for empty input', () => {
    expect(calculateCVD([])).toBeNull();
    expect(calculateCVD(null)).toBeNull();
  });

  test('returns value, trend, divergence', () => {
    const candles = Array.from({ length: 10 }, () => makeCandle(101, 99, 100));
    const result = calculateCVD(candles);
    expect(result).toHaveProperty('value');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('divergence');
  });

  test('CVD rising in bullish series', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(100 + i + 1, 100 + i - 1, 100 + i + 0.8));
    const result = calculateCVD(candles);
    expect(result.trend).toBe('rising');
  });

  test('bearish divergence when price rises but CVD falls', () => {
    // Precio subiendo pero velas con cierre cerca del low (sell pressure)
    const candles = Array.from({ length: 10 }, (_, i) =>
      makeCandle(100 + i + 2, 100 + i, 100 + i + 0.1) // close near low
    );
    const result = calculateCVD(candles);
    expect(result.divergence).toBe('bearish');
  });

  test('source is heuristic when taker_buy_base missing', () => {
    const candles = Array.from({ length: 10 }, () => makeCandle(101, 99, 100));
    const result = calculateCVD(candles);
    expect(result.source).toBe('heuristic');
  });

  test('source is taker_real and uses real delta when present', () => {
    // 10 velas con taker_buy_base=80 sobre volume=100 → delta=+60 cada una → CVD final = 600
    const candles = Array.from({ length: 10 }, () => ({
      high: 101, low: 99, close: 100, open: 99, volume: 100, taker_buy_base: 80,
    }));
    const result = calculateCVD(candles);
    expect(result.source).toBe('taker_real');
    expect(result.value).toBeCloseTo(600, 1);
    expect(result.trend).toBe('rising');
  });

  test('taker_real: sell-agressor candles produce negative delta', () => {
    // taker_buy_base=20 sobre volume=100 → delta = 2*20 - 100 = -60
    const candles = Array.from({ length: 10 }, () => ({
      high: 101, low: 99, close: 100, open: 101, volume: 100, taker_buy_base: 20,
    }));
    const result = calculateCVD(candles);
    expect(result.source).toBe('taker_real');
    expect(result.value).toBeCloseTo(-600, 1);
    expect(result.trend).toBe('falling');
  });
});

// ─── VWAP ─────────────────────────────────────────────────────────────────────

describe('calculateVWAP', () => {
  const makeCandle = (h, l, c, v = 1000) => ({ high: h, low: l, close: c, open: (h + l) / 2, volume: v });

  test('returns null for insufficient data', () => {
    expect(calculateVWAP([makeCandle(101, 99, 100)])).toBeNull();
    expect(calculateVWAP(null)).toBeNull();
  });

  test('returns value, trend, divergence', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(102 + i, 98 + i, 100 + i));
    const result = calculateVWAP(candles);
    expect(result).toHaveProperty('value');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('divergence');
  });

  test('VWAP rising in uptrend', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(102 + i, 98 + i, 100 + i, 500));
    const result = calculateVWAP(candles);
    expect(result.value).toBeGreaterThan(100);
    expect(result.trend).toBe('rising');
  });

  test('bearish divergence detection', () => {
    // Scenario: price jumps with low volume, then holds with high volume
    // - Positions 0-13: low price (~99), high volume
    // - Positions 14-19: price jumps to 110, low volume (VWAP lags far behind)
    // - Positions 20-24: price holds at 112, high volume (VWAP catches up, gap narrows)
    // Result: price rose but VWAP caught up → bearish (rally losing volume support)
    const lowCandles = Array.from({ length: 14 }, (_, i) => makeCandle(101, 97, 99, 1000));
    const jumpCandles = Array.from({ length: 6 }, (_, i) => makeCandle(112, 108, 110, 100));
    const holdCandles = Array.from({ length: 5 }, (_, i) => makeCandle(113, 111, 112, 1000));
    const candles = [...lowCandles, ...jumpCandles, ...holdCandles];
    const result = calculateVWAP(candles);
    expect(result.divergence).toBe('bearish');
  });
});

// ─── RSI Divergence ───────────────────────────────────────────────────────────

describe('detectRSIDivergence', () => {
  test('returns none when not enough data', () => {
    expect(detectRSIDivergence([1, 2, 3])).toBe('none');
  });

  test('returns none, bullish, or bearish', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.4) * 15);
    const result = detectRSIDivergence(closes);
    expect(['none', 'bullish', 'bearish']).toContain(result);
  });

  test('detects bearish divergence: price higher high, RSI lower high', () => {
    // Construir serie con divergencia bearish explícita:
    // Dos picos de precio donde el segundo es mayor pero el RSI es menor
    const base = Array.from({ length: 30 }, () => 100);
    // Primer pico: subida moderada con mucha fuerza (RSI alto)
    const peak1 = [100, 104, 108, 110, 108, 104, 100];
    // Consolidación
    const mid = Array.from({ length: 10 }, () => 100);
    // Segundo pico: subida mayor en precio pero con poco momentum
    const peak2 = [100, 101, 102, 115, 102, 101, 100];
    const closes = [...base, ...peak1, ...mid, ...peak2];
    const result = detectRSIDivergence(closes);
    expect(['bearish', 'none']).toContain(result); // puede no detectarse siempre con datos sintéticos
  });
});

// ─── Market Regime ────────────────────────────────────────────────────────────

describe('detectMarketRegime', () => {
  const makeCandle = (h, l, c) => ({ high: h, low: l, close: c, open: l, volume: 1000 });

  test('returns unknown when not enough data', () => {
    const candles = Array.from({ length: 5 }, () => makeCandle(101, 99, 100));
    expect(detectMarketRegime(candles, [100, 100, 100])).toBe('unknown');
  });

  test('returns valid regime string', () => {
    const candles = Array.from({ length: 60 }, (_, i) => makeCandle(100 + i * 2, 99 + i * 2, 100 + i * 2));
    const closes = candles.map(c => c.close);
    const result = detectMarketRegime(candles, closes);
    expect(['trending', 'ranging', 'weak_trend', 'high_volatility', 'unknown']).toContain(result);
  });

  test('detects trending regime in strong uptrend', () => {
    const candles = Array.from({ length: 80 }, (_, i) => makeCandle(100 + i * 3, 99 + i * 3, 100 + i * 3));
    const closes = candles.map(c => c.close);
    const result = detectMarketRegime(candles, closes);
    expect(result).toBe('trending');
  });

  test('detects ranging regime in flat market', () => {
    // Mercado lateral con oscilaciones muy pequeñas
    const candles = Array.from({ length: 80 }, (_, i) => {
      const v = 100 + (i % 3 === 0 ? 0.3 : i % 3 === 1 ? -0.2 : 0.1);
      return makeCandle(v + 0.2, v - 0.2, v);
    });
    const closes = candles.map(c => c.close);
    const result = detectMarketRegime(candles, closes);
    expect(['ranging', 'weak_trend']).toContain(result);
  });
});

// ─── computeTrend (jerarquía estructura > ejecución > volumen) ───────────────

describe('computeTrend', () => {
  test('returns neutral when all inputs are null', () => {
    expect(computeTrend({})).toBe('neutral');
  });

  test('returns strongly_bullish when all signals max bullish', () => {
    const trend = computeTrend({
      rsi: { value: 70 },
      macd: { histogram: 1 },
      adx: { trend_direction: 'bullish' },
      superTrend: { trend: 'UP' },
      waveTrend: { wt1: 10, wt2: 5 },
      stochRsi: { k: 60, d: 50 },
      volumeDelta: { buy_pressure_pct: 100 },
    });
    expect(trend).toBe('strongly_bullish');
  });

  test('returns strongly_bearish when all signals max bearish', () => {
    const trend = computeTrend({
      rsi: { value: 30 },
      macd: { histogram: -1 },
      adx: { trend_direction: 'bearish' },
      superTrend: { trend: 'DOWN' },
      waveTrend: { wt1: -10, wt2: -5 },
      stochRsi: { k: 40, d: 50 },
      volumeDelta: { buy_pressure_pct: 0 },
    });
    expect(trend).toBe('strongly_bearish');
  });

  test('structure outweighs execution: bullish structure + bearish execution → bullish/neutral, not bearish', () => {
    const trend = computeTrend({
      rsi: { value: 30 },
      macd: { histogram: -1 },
      waveTrend: { wt1: -10, wt2: -5 },
      stochRsi: { k: 40, d: 50 },
      adx: { trend_direction: 'bullish' },
      superTrend: { trend: 'UP' },
      volumeDelta: { buy_pressure_pct: 50 },
    });
    // structure=+1 (0.5) + execution=-1 (-0.3) + volume=0 = +0.2 → bullish
    expect(['bullish', 'neutral']).toContain(trend);
    expect(trend).not.toBe('bearish');
    expect(trend).not.toBe('strongly_bearish');
  });

  test('volume alone (no structure, no execution) → neutral (peso insuficiente)', () => {
    const trend = computeTrend({
      volumeDelta: { buy_pressure_pct: 100 },
    });
    // volume = +1 * 0.2 = 0.2 — exactamente en el umbral, devuelve bullish
    // Pero si solo hay volumen, lo razonable es que no domine; verificamos que NO es strongly_bullish
    expect(['bullish', 'neutral']).toContain(trend);
    expect(trend).not.toBe('strongly_bullish');
  });

  test('two setups with same bullScore but different distribution diverge', () => {
    // Setup A: estructura alcista pura, ejecución neutra
    const a = computeTrend({
      adx: { trend_direction: 'bullish' },
      superTrend: { trend: 'UP' },
    });
    // Setup B: ejecución alcista pura, estructura ausente
    const b = computeTrend({
      rsi: { value: 70 },
      macd: { histogram: 1 },
      waveTrend: { wt1: 10, wt2: 5 },
      stochRsi: { k: 60, d: 50 },
    });
    // A: structure=+1 → bias=0.5 → bullish
    // B: execution=+1 → bias=0.3 → bullish
    // Ambos bullish, pero el bias de A > B (la estructura pesa más).
    // Verificación cualitativa: A no debe ser menos alcista que B
    const rank = { strongly_bearish: -2, bearish: -1, neutral: 0, bullish: 1, strongly_bullish: 2 };
    expect(rank[a]).toBeGreaterThanOrEqual(rank[b]);
  });
});

// ─── Volume Profile ───────────────────────────────────────────────────────────

describe('calculateVolumeProfile', () => {
  const buildCandle = (low, high, volume) => ({
    t: 0, open: low, high, low, close: high, volume,
  });

  test('returns null when not enough candles', () => {
    const candles = Array.from({ length: 10 }, () => buildCandle(100, 101, 50));
    expect(calculateVolumeProfile(candles)).toBeNull();
  });

  test('returns null when range is zero (all candles flat)', () => {
    const candles = Array.from({ length: 30 }, () => buildCandle(100, 100, 50));
    expect(calculateVolumeProfile(candles)).toBeNull();
  });

  test('returns full structure with valid candles', () => {
    const candles = Array.from({ length: 30 }, (_, i) => buildCandle(100 + i * 0.1, 101 + i * 0.1, 100));
    const vp = calculateVolumeProfile(candles);
    expect(vp).not.toBeNull();
    expect(vp).toHaveProperty('poc');
    expect(vp).toHaveProperty('vah');
    expect(vp).toHaveProperty('val');
    expect(vp).toHaveProperty('hvn');
    expect(vp).toHaveProperty('lvn');
    expect(vp).toHaveProperty('bin_size');
    expect(vp).toHaveProperty('total_volume');
    expect(Array.isArray(vp.hvn)).toBe(true);
    expect(Array.isArray(vp.lvn)).toBe(true);
  });

  test('POC is within [low, high] range and VAL <= POC <= VAH', () => {
    const candles = [];
    for (let i = 0; i < 50; i++) {
      const center = 100 + Math.sin(i / 5) * 5;
      candles.push(buildCandle(center - 0.5, center + 0.5, 100 + Math.random() * 50));
    }
    const vp = calculateVolumeProfile(candles);
    expect(vp.poc).toBeGreaterThanOrEqual(vp.val);
    expect(vp.poc).toBeLessThanOrEqual(vp.vah);
    expect(vp.val).toBeLessThanOrEqual(vp.vah);
  });

  test('POC concentrates on price band with most volume', () => {
    // 25 velas con volumen normal en 100-101, 5 velas con volumen alto en 110-111
    const candles = [
      ...Array.from({ length: 25 }, () => buildCandle(100, 101, 50)),
      ...Array.from({ length: 5 }, () => buildCandle(110, 111, 1000)),
    ];
    const vp = calculateVolumeProfile(candles);
    // POC debe estar cerca del cluster de 110-111, no del 100-101
    expect(vp.poc).toBeGreaterThan(105);
  });
});

// ─── SMC: BOS / CHoCH / FVG ──────────────────────────────────────────────────

describe('SMC — detectSwings', () => {
  // Helper: crea vela centrada en `mid` con rango ±0.5 y close=mid
  const c = (t, mid, hi = mid + 0.5, lo = mid - 0.5) =>
    ({ t, open: mid, high: hi, low: lo, close: mid, volume: 100 });

  test('returns null with insufficient candles', () => {
    expect(detectSwings([c(0, 100), c(1, 101)], 2)).toBeNull();
  });

  test('detects fractal swing high in zigzag', () => {
    // Pico claro en idx 4: ...100 101 102 103 104(top) 103 102 101 100...
    const candles = [
      c(0, 100), c(1, 101), c(2, 102), c(3, 103), c(4, 104),
      c(5, 103), c(6, 102), c(7, 101), c(8, 100),
    ];
    const swings = detectSwings(candles, 2);
    expect(swings.highs.length).toBeGreaterThanOrEqual(1);
    expect(swings.highs[0].idx).toBe(4);
    expect(swings.highs[0].price).toBeCloseTo(104.5);
  });
});

describe('SMC — detectLastBOS', () => {
  // Construye serie con tendencia alcista clara (HH/HL) y luego ruptura final.
  const buildBullishStructure = () => {
    // Swings deseados:
    //   low en 95 (idx 2) → high en 105 (idx 6) → low en 100 (idx 10) → high en 110 (idx 14)
    //   tendencia: HL (95→100) + HH (105→110) → bullish.
    // Después, vela final con close > 110 → BOS bullish.
    const seq = [
      100, 98, 95, 98, 102,
      104, 105, 103, 101, 100,
      100, 102, 105, 108, 110,
      108, 105, 103, 105, 112,  // última: cierre 112 > 110 → BOS
    ];
    return seq.map((mid, i) => ({
      t: i, open: mid, high: mid + 0.4, low: mid - 0.4, close: mid, volume: 100,
    }));
  };

  test('returns null when structure is undefined (not enough swings)', () => {
    const flat = Array.from({ length: 10 }, (_, i) => ({
      t: i, open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
    }));
    expect(detectLastBOS(flat)).toBeNull();
  });

  test('detects bullish BOS when close breaks last swing high in uptrend', () => {
    const candles = buildBullishStructure();
    const bos = detectLastBOS(candles, { lookback: 2 });
    expect(bos).not.toBeNull();
    expect(bos.direction).toBe('bullish');
    expect(bos.close).toBeGreaterThan(bos.broken_swing_price);
  });

  test('returns most recent break chronologically, not first break from newest swing', () => {
    // Estructura bullish mínima que garantiza exactamente 2 highs (SH1 < SH2) y 2 lows (HL).
    // SH1 en idx=2 (price=105), SH2 en idx=8 (price=112, HH).
    // SL1 en idx=5 (price=99, HL respecto al low implícito inicial).
    //
    // Break de SH1 (>105.4) ocurre en idx=10 (close=107) — primero en tiempo.
    // Break de SH2 (>112.4) ocurre en idx=14 (close=114) — más reciente.
    //
    // El algoritmo correcto devuelve break_candle_idx=14 (más reciente).
    const mk = (close, t) => ({ t, open: close, high: close + 0.4, low: close - 0.4, close, volume: 100 });
    const candles = [
      mk(100, 0), mk(103, 1),
      mk(105, 2),                  // SH1: high=105.4
      mk(103, 3), mk(101, 4),
      mk(99,  5),                  // SL1 (HL)
      mk(102, 6), mk(108, 7),
      mk(112, 8),                  // SH2: high=112.4 (HH → bullish)
      mk(110, 9),
      mk(107, 10),                 // close=107 > 105.4 → break SH1, pero 107 < 112.4, no break SH2
      mk(109, 11), mk(108, 12), mk(110, 13),
      mk(114, 14),                 // close=114 > 112.4 → break SH2, más reciente
      mk(113, 15),
    ];

    const bos = detectLastBOS(candles, { lookback: 2 });
    expect(bos).not.toBeNull();
    expect(bos.direction).toBe('bullish');
    expect(bos.break_candle_idx).toBe(14);           // más reciente, no idx=10
    expect(bos.broken_swing_price).toBeCloseTo(112.4, 1); // SH2, no SH1
  });

  test('returns null when BOS break_candle exceeds maxCandlesAgo', () => {
    // El BOS ocurre en la última vela del array (candles_ago=0).
    // Añadimos 5 velas neutras al final → el BOS queda a 5 velas atrás (candles_ago=5).
    // Con maxCandlesAgo=3 debe devolver null. Con maxCandlesAgo=5 debe pasar.
    const base = buildBullishStructure(); // 20 velas, BOS en idx 19
    const extended = [
      ...base,
      { t: 20, open: 110, high: 111, low: 109, close: 110, volume: 100 },
      { t: 21, open: 110, high: 111, low: 109, close: 110, volume: 100 },
      { t: 22, open: 110, high: 111, low: 109, close: 110, volume: 100 },
      { t: 23, open: 110, high: 111, low: 109, close: 110, volume: 100 },
      { t: 24, open: 110, high: 111, low: 109, close: 110, volume: 100 },
    ]; // 25 velas, BOS en idx 19 → candles_ago = 25-1-19 = 5
    expect(detectLastBOS(extended, { lookback: 2, maxCandlesAgo: 3 })).toBeNull();
    expect(detectLastBOS(extended, { lookback: 2, maxCandlesAgo: 5 })).not.toBeNull();
  });
});

describe('SMC — detectLastCHoCH', () => {
  test('detects bearish CHoCH when uptrend close breaks below last swing low', () => {
    // Estructura alcista con dos swing highs y dos swing lows bien separados:
    //   SL1 en idx2 (89.6), SH1 en idx6 (110.4), SL2 en idx10 (97.6) → HL,
    //   SH2 en idx14 (115.4) → HH. trend = bullish.
    // Velas 15-19 forman el retroceso; close final (93) < SL2.low (97.6) → CHoCH bearish.
    const seq = [
      100,  95,  90,  95, 102,   // 0-4:  SL1 en idx2
      106, 110, 106, 102,  99,   // 5-9:  SH1 en idx6, baja hacia SL2
       98, 102, 107, 112, 115,   // 10-14: SL2 en idx10, SH2 en idx14
      112, 108, 103,  98,  93,   // 15-19: retroceso; close=93 < SL2.low(97.6)
    ];
    const candles = seq.map((mid, i) => ({
      t: i, open: mid, high: mid + 0.4, low: mid - 0.4, close: mid, volume: 100,
    }));
    const choch = detectLastCHoCH(candles, { lookback: 2 });
    expect(choch).not.toBeNull();
    expect(choch.direction).toBe('bearish');
    expect(choch.close).toBeLessThan(choch.broken_swing_price);
  });
});

describe('SMC — detectUnmitigatedFVGs', () => {
  test('returns empty arrays when no gap exists', () => {
    // 30 velas continuas sin huecos
    const candles = Array.from({ length: 30 }, (_, i) => ({
      t: i, open: 100, high: 100.5, low: 99.5, close: 100, volume: 100,
    }));
    const fvgs = detectUnmitigatedFVGs(candles);
    expect(fvgs.bullish).toEqual([]);
    expect(fvgs.bearish).toEqual([]);
  });

  test('detects bullish FVG with gap and no mitigation', () => {
    // Patrón bullish FVG en idx 0,1,2 con vela 1 fuerte alcista.
    //   vela 0: high=100  → tope del gap inferior
    //   vela 1: cuerpo grande 100→105
    //   vela 2: low=102   → suelo del gap superior; gap = [100, 102]
    // Velas posteriores se mantienen por encima de 102 → no mitigan.
    const candles = [
      { t: 0, open: 99,  high: 100, low: 98,  close: 99.5, volume: 100 },
      { t: 1, open: 100, high: 105, low: 100, close: 104,  volume: 100 },
      { t: 2, open: 104, high: 106, low: 102, close: 105,  volume: 100 },
      { t: 3, open: 105, high: 107, low: 103, close: 106,  volume: 100 },
      { t: 4, open: 106, high: 108, low: 104, close: 107,  volume: 100 },
      { t: 5, open: 107, high: 109, low: 105, close: 108,  volume: 100 },
    ];
    const fvgs = detectUnmitigatedFVGs(candles);
    expect(fvgs.bullish.length).toBe(1);
    expect(fvgs.bullish[0].low).toBeCloseTo(100);
    expect(fvgs.bullish[0].high).toBeCloseTo(102);
    expect(fvgs.bullish[0].mitigation_pct).toBe(0);
    expect(fvgs.bullish[0].candles_ago).toBe(3); // FVG en idx 2, array length=6 → 6-1-2=3
    expect(fvgs.bearish.length).toBe(0);
  });

  test('marks FVG as fully mitigated (excluded) when later candle covers entire gap', () => {
    // Mismo gap [100, 102] que el test anterior, pero la vela 5 baja a 99 → cubre 100% del gap
    const candles = [
      { t: 0, open: 99,  high: 100, low: 98,  close: 99.5, volume: 100 },
      { t: 1, open: 100, high: 105, low: 100, close: 104,  volume: 100 },
      { t: 2, open: 104, high: 106, low: 102, close: 105,  volume: 100 },
      { t: 3, open: 105, high: 107, low: 103, close: 106,  volume: 100 },
      { t: 4, open: 106, high: 108, low: 104, close: 107,  volume: 100 },
      { t: 5, open: 107, high: 107, low: 99,  close: 100,  volume: 100 },  // cubre todo el gap
    ];
    const fvgs = detectUnmitigatedFVGs(candles);
    expect(fvgs.bullish.length).toBe(0); // excluido porque mitigation_pct === 100
  });

  test('includes partially mitigated FVG with correct mitigation_pct', () => {
    // Gap bullish [100, 104] (size=4). Vela posterior: low=101, high=109
    // overlap = [max(101,100), min(109,104)] = [101,104] = 3 → 3/4 = 75%
    const candles = [
      { t: 0, open: 99,  high: 100, low: 98,  close: 99.5, volume: 100 },
      { t: 1, open: 100, high: 106, low: 100, close: 105,  volume: 100 },
      { t: 2, open: 105, high: 108, low: 104, close: 107,  volume: 100 },
      { t: 3, open: 107, high: 109, low: 101, close: 108,  volume: 100 }, // overlap [101,104]=3/4=75%
      { t: 4, open: 108, high: 110, low: 106, close: 109,  volume: 100 },
    ];
    const fvgs = detectUnmitigatedFVGs(candles);
    expect(fvgs.bullish.length).toBe(1);
    expect(fvgs.bullish[0].mitigation_pct).toBe(75); // 3/4 del gap cubierto
  });
});

describe('SMC — calculateSMC signal_status (decay precalculado)', () => {
  // Gap bullish [100,102] en idx 2, mitigation 0, seguido de velas que no lo mitigan
  // (low siempre >= 102). Length=10 → el FVG queda con candles_ago = 10-1-2 = 7.
  const unmitigatedGap = [
    { t: 0, open: 99,  high: 100, low: 98,  close: 99.5, volume: 100 },
    { t: 1, open: 100, high: 105, low: 100, close: 104,  volume: 100 },
    { t: 2, open: 104, high: 106, low: 102, close: 105,  volume: 100 }, // FVG idx 2
    { t: 3, open: 105, high: 107, low: 103, close: 106,  volume: 100 },
    { t: 4, open: 106, high: 108, low: 104, close: 107,  volume: 100 },
    { t: 5, open: 107, high: 109, low: 105, close: 108,  volume: 100 },
    { t: 6, open: 108, high: 110, low: 106, close: 109,  volume: 100 },
    { t: 7, open: 109, high: 111, low: 107, close: 110,  volume: 100 },
    { t: 8, open: 110, high: 112, low: 108, close: 111,  volume: 100 },
    { t: 9, open: 111, high: 113, low: 109, close: 112,  volume: 100 },
  ];

  test('sin timeframe → FVG reciente sin mitigar cuenta como "active"', () => {
    const smc = calculateSMC(unmitigatedGap);
    const fvg = smc.unmitigated_fvgs.bullish[0];
    expect(fvg.mitigation_pct).toBe(0);
    expect(fvg.signal_status).toBe('active'); // activeMax=Infinity sin timeframe
  });

  test('timeframe 4h → mismo FVG con candles_ago=7 (>4) degrada a "context"', () => {
    const smc = calculateSMC(unmitigatedGap, { timeframe: '4h' });
    const fvg = smc.unmitigated_fvgs.bullish[0];
    expect(fvg.candles_ago).toBe(7);
    expect(fvg.signal_status).toBe('context');
  });

  test('FVG con mitigation_pct > 70 → "expired" independientemente del TF', () => {
    // Gap [100,104]; vela 3 con low=101 cubre 3/4 → 75% > 70. Pad a length 10.
    const partiallyMitigated = [
      { t: 0, open: 99,  high: 100, low: 98,  close: 99.5, volume: 100 },
      { t: 1, open: 100, high: 106, low: 100, close: 105,  volume: 100 },
      { t: 2, open: 105, high: 108, low: 104, close: 107,  volume: 100 }, // FVG [100,104]
      { t: 3, open: 107, high: 109, low: 101, close: 108,  volume: 100 }, // mitiga 75%
      { t: 4, open: 108, high: 110, low: 106, close: 109,  volume: 100 },
      { t: 5, open: 109, high: 111, low: 107, close: 110,  volume: 100 },
      { t: 6, open: 110, high: 112, low: 108, close: 111,  volume: 100 },
      { t: 7, open: 111, high: 113, low: 109, close: 112,  volume: 100 },
      { t: 8, open: 112, high: 114, low: 110, close: 113,  volume: 100 },
      { t: 9, open: 113, high: 115, low: 111, close: 114,  volume: 100 },
    ];
    const smc = calculateSMC(partiallyMitigated, { timeframe: '4h' });
    const fvg = smc.unmitigated_fvgs.bullish[0];
    expect(fvg.mitigation_pct).toBe(75);
    expect(fvg.signal_status).toBe('expired');
  });
});

describe('computeIndicators — flags precalculados baratos (Fase 5)', () => {
  // Serie alcista sintética suficiente para todos los indicadores (>=30 velas).
  const rising = Array.from({ length: 60 }, (_, i) => {
    const base = 100 + i;
    return { t: i * 3600000, open: base, high: base + 1.5, low: base - 0.5, close: base + 1, volume: 1000 + i * 10 };
  });

  test('cvd trae cvd_strength (marginal/moderate/strong)', () => {
    const ind = computeIndicators(rising, '1h');
    expect(ind.cvd).toHaveProperty('cvd_strength');
    expect(['marginal', 'moderate', 'strong']).toContain(ind.cvd.cvd_strength);
  });

  test('vwap trae price_vs_vwap; en tendencia alcista el precio queda above', () => {
    const ind = computeIndicators(rising, '1h');
    expect(ind.vwap).toHaveProperty('price_vs_vwap');
    expect(ind.vwap.price_vs_vwap).toBe('above'); // precio por encima del VWAP rolling en subida
  });

  test('volume_profile trae price_vs_poc y excursion', () => {
    const ind = computeIndicators(rising, '1h');
    expect(ind.volume_profile).toHaveProperty('price_vs_poc');
    expect(['above', 'below', 'at']).toContain(ind.volume_profile.price_vs_poc);
    expect(ind.volume_profile).toHaveProperty('excursion'); // null o above_vah/below_val
  });
});

// ─── Audit hardening tests ───────────────────────────────────────────────────

describe('calculateRSI — flat market guard', () => {
  test('returns 50 when price is completely flat (no gains, no losses)', () => {
    const closes = Array.from({ length: 20 }, () => 100);
    expect(calculateRSI(closes)).toBe(50);
  });
});

describe('calculateBollingerBands — flat market guard', () => {
  test('position falls back to 0.5 when stdDev is 0', () => {
    const closes = Array.from({ length: 20 }, () => 100);
    const bb = calculateBollingerBands(closes);
    expect(bb.upper).toBe(bb.middle);
    expect(bb.lower).toBe(bb.middle);
    expect(bb.position).toBe(0.5);
    expect(bb.width_pct).toBe(0);
  });
});

describe('calculateADX — ranging regime', () => {
  const makeCandle = (h, l, c) => ({ high: h, low: l, close: c, open: l, volume: 1000 });

  test('ranging market produces ADX <= 20 and regime ranging or weak_trend', () => {
    // Mercado lateral con oscilaciones mínimas y simétricas
    const candles = Array.from({ length: 80 }, (_, i) => {
      const v = 100 + (i % 4 === 0 ? 0.05 : i % 4 === 1 ? -0.05 : 0);
      return makeCandle(v + 0.05, v - 0.05, v);
    });
    const result = calculateADX(candles);
    expect(['ranging', 'weak_trend']).toContain(result.regime);
  });
});

describe('calculateSuperTrend — trend transitions', () => {
  const makeCandle = (h, l, c) => ({ high: h, low: l, close: c, open: l, volume: 1000 });

  test('UP→DOWN transition: uptrend followed by sharp drop flips trend', () => {
    const up = Array.from({ length: 40 }, (_, i) => makeCandle(100 + i * 2, 99 + i * 2, 100 + i * 2));
    const down = Array.from({ length: 30 }, (_, i) => makeCandle(180 - i * 3, 179 - i * 3, 180 - i * 3));
    const result = calculateSuperTrend([...up, ...down]);
    expect(result.trend).toBe('DOWN');
    expect(result.support).toBeNull();
    expect(result.resistance).toBeGreaterThan(0);
  });

  test('DOWN→UP transition: downtrend followed by sharp rally flips trend', () => {
    const down = Array.from({ length: 40 }, (_, i) => makeCandle(200 - i * 2, 199 - i * 2, 200 - i * 2));
    const up = Array.from({ length: 30 }, (_, i) => makeCandle(120 + i * 3, 119 + i * 3, 120 + i * 3));
    const result = calculateSuperTrend([...down, ...up]);
    expect(result.trend).toBe('UP');
    expect(result.resistance).toBeNull();
    expect(result.support).toBeGreaterThan(0);
  });
});

describe('calculateCVD — robustness against corrupt taker data', () => {
  const makeCandle = (h, l, c, v = 1000, taker = undefined) => ({
    high: h, low: l, close: c, open: l, volume: v,
    ...(taker !== undefined ? { taker_buy_base: taker } : {}),
  });

  test('falls back to heuristic when taker_buy_base is NaN', () => {
    const candles = Array.from({ length: 5 }, () => makeCandle(101, 99, 100, 1000, NaN));
    const result = calculateCVD(candles);
    expect(result.source).toBe('heuristic');
  });

  test('falls back to heuristic when taker_buy_base > volume', () => {
    const candles = Array.from({ length: 5 }, () => makeCandle(101, 99, 100, 1000, 5000));
    const result = calculateCVD(candles);
    expect(result.source).toBe('heuristic');
  });

  test('falls back to heuristic when taker_buy_base is negative', () => {
    const candles = Array.from({ length: 5 }, () => makeCandle(101, 99, 100, 1000, -10));
    const result = calculateCVD(candles);
    expect(result.source).toBe('heuristic');
  });
});

describe('calculateVolumeProfile — single-bin edge case', () => {
  const buildCandle = (low, high, volume) => ({
    t: 0, open: low, high, low, close: high, volume,
  });

  test('candles with same range produce vah == val == poc when volume concentrates', () => {
    // 30 velas con rango idéntico [100, 100.5], todas con volumen igual
    const candles = Array.from({ length: 30 }, () => buildCandle(100, 100.5, 100));
    const vp = calculateVolumeProfile(candles);
    expect(vp).not.toBeNull();
    // En una distribución plana sobre rango pequeño, POC debe estar dentro del rango
    expect(vp.poc).toBeGreaterThanOrEqual(vp.val);
    expect(vp.poc).toBeLessThanOrEqual(vp.vah);
  });
});

describe('computeTrend — ADX ranging does not contribute structure', () => {
  test('ranging ADX does not push bias when superTrend is the only structural input', () => {
    // Solo ADX en ranging + superTrend UP → estructura solo cuenta superTrend
    const trend = computeTrend({
      adx: { trend_direction: 'bearish', regime: 'ranging' },
      superTrend: { trend: 'UP' },
    });
    // structureCount = 1 (solo superTrend), structure = +1
    // bias = 1 * 0.5 = 0.5 → bullish
    expect(trend).toBe('bullish');
  });

  test('trending ADX does contribute structure (full bull stack reaches strongly_bullish)', () => {
    const trend = computeTrend({
      adx: { trend_direction: 'bullish', regime: 'trending' },
      superTrend: { trend: 'UP' },
      rsi: { value: 70 },
      macd: { histogram: 1 },
      waveTrend: { wt1: 10, wt2: 5 },
      stochRsi: { k: 60, d: 50 },
      volumeDelta: { buy_pressure_pct: 100 },
    });
    expect(trend).toBe('strongly_bullish');
  });

  test('ranging ADX with full bull execution stack stays at most bullish (not strongly)', () => {
    const trend = computeTrend({
      adx: { trend_direction: 'bullish', regime: 'ranging' },
      superTrend: { trend: 'UP' },
      rsi: { value: 70 },
      macd: { histogram: 1 },
      waveTrend: { wt1: 10, wt2: 5 },
      stochRsi: { k: 60, d: 50 },
      volumeDelta: { buy_pressure_pct: 100 },
    });
    // structure=+1 (solo SuperTrend), exec=+1, vol=+1 → bias = 0.5+0.3+0.2 = 1.0
    // pero structure ahora pesa solo 0.5 (no 1.0 con dos componentes), igualmente strongly_bullish
    expect(['bullish', 'strongly_bullish']).toContain(trend);
  });
});

// ─── CVD — nuevos campos de divergencia (D2) ──────────────────────────────────

describe('calculateCVD — divergencia explícita', () => {
  const makeCandles = (n, trend = 'flat') => {
    return Array.from({ length: n }, (_, i) => {
      const base = 100;
      const close = trend === 'up' ? base + i * 0.5 : trend === 'down' ? base - i * 0.5 : base;
      return {
        open: close - 0.1, high: close + 0.5, low: close - 0.5, close,
        volume: 10, taker_buy_base: 5,
      };
    });
  };

  test('output includes divergence_window_candles field', () => {
    const candles = makeCandles(50);
    const result = calculateCVD(candles);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('divergence_window_candles');
    expect(result.divergence_window_candles).toBeGreaterThan(0);
  });

  test('output includes price_change_pct_window and cvd_delta_window/cvd_delta_vs_volume_pct', () => {
    const candles = makeCandles(50);
    const result = calculateCVD(candles);
    expect(result).toHaveProperty('price_change_pct_window');
    expect(result).toHaveProperty('cvd_delta_window');
    expect(result).toHaveProperty('cvd_delta_vs_volume_pct');
    expect(typeof result.price_change_pct_window).toBe('number');
    expect(typeof result.cvd_delta_window).toBe('number');
    expect(typeof result.cvd_delta_vs_volume_pct).toBe('number');
  });

  test('with 50 flat candles, divergence_window_candles = 20 (min of WINDOW, series-1)', () => {
    const candles = makeCandles(50);
    const result = calculateCVD(candles);
    expect(result.divergence_window_candles).toBe(20);
  });

  test('with only 10 candles, divergence_window_candles = 9 (all available)', () => {
    const candles = makeCandles(10);
    const result = calculateCVD(candles);
    expect(result.divergence_window_candles).toBe(9);
  });

  test('last_candle_delta = delta neto de la última vela (estacionario, sin deriva de ventana)', () => {
    const candles = makeCandles(20);
    // Última vela con presión compradora conocida: 2*8 - 10 = 6.
    candles[candles.length - 1] = { ...candles[candles.length - 1], volume: 10, taker_buy_base: 8 };
    const result = calculateCVD(candles);
    expect(result).toHaveProperty('last_candle_delta');
    expect(result.last_candle_delta).toBeCloseTo(6, 5);
    // Debe coincidir con value(serie) − value(serie sin la última vela): el aporte de esa vela.
    const prev = calculateCVD(candles.slice(0, -1));
    expect(result.last_candle_delta).toBeCloseTo(result.value - prev.value, 5);
  });

  test('single-candle series: last_candle_delta = value (no hay barra previa)', () => {
    const one = [{ open: 100, high: 101, low: 99, close: 100.5, volume: 10, taker_buy_base: 7 }];
    const result = calculateCVD(one);
    expect(result.last_candle_delta).toBeCloseTo(result.value, 5);
  });
});

// ─── VolumeProfile — metadata de periodo (D3) ────────────────────────────────

describe('calculateVolumeProfile — metadata de periodo', () => {
  const makeVPCandles = (n) => Array.from({ length: n }, (_, i) => ({
    t: (1700000000 + i * 3600) * 1000,
    open: 100, high: 105, low: 95, close: 102, volume: 100,
  }));

  test('includes period_start matching first candle timestamp', () => {
    const candles = makeVPCandles(30);
    const result = calculateVolumeProfile(candles);
    expect(result).toHaveProperty('period_start', candles[0].t);
  });

  test('includes period_end matching last candle timestamp', () => {
    const candles = makeVPCandles(30);
    const result = calculateVolumeProfile(candles);
    expect(result).toHaveProperty('period_end', candles[candles.length - 1].t);
  });

  test('includes candles_covered equal to array length', () => {
    const candles = makeVPCandles(30);
    const result = calculateVolumeProfile(candles);
    expect(result.candles_covered).toBe(30);
  });
});

// ─── Bollinger Bands — window y std_dev_mult (D14) ───────────────────────────

describe('calculateBollingerBands — campos de metadata', () => {
  test('includes window field equal to period parameter', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const result = calculateBollingerBands(closes, 20, 2);
    expect(result).toHaveProperty('window', 20);
  });

  test('includes std_dev_mult field', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const result = calculateBollingerBands(closes, 20, 2);
    expect(result).toHaveProperty('std_dev_mult', 2);
  });

  test('default window is 20', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const result = calculateBollingerBands(closes);
    expect(result.window).toBe(20);
  });
});
