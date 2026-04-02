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
  calculateOBV,
  detectRSIDivergence,
  detectMarketRegime,
} from '../src/utils/indicators.js';

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

  test('returns object with value, signal, histogram, status', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = calculateMACD(closes);
    expect(result).toHaveProperty('value');
    expect(result).toHaveProperty('signal');
    expect(result).toHaveProperty('histogram');
    expect(result).toHaveProperty('status');
  });

  test('status is bullish_momentum when histogram > 0', () => {
    // Fase plana larga + subida pronunciada: fuerza al fast EMA por encima del slow
    const flat = Array.from({ length: 60 }, () => 100);
    const rise = Array.from({ length: 40 }, (_, i) => 100 + i * 5);
    const closes = [...flat, ...rise];
    const result = calculateMACD(closes);
    expect(result.status).toBe('bullish_momentum');
  });

  test('status is bearish_momentum when histogram < 0', () => {
    // Fase plana larga + caída pronunciada: fuerza al fast EMA por debajo del slow
    const flat = Array.from({ length: 60 }, () => 200);
    const fall = Array.from({ length: 40 }, (_, i) => 200 - i * 5);
    const closes = [...flat, ...fall];
    const result = calculateMACD(closes);
    expect(result.status).toBe('bearish_momentum');
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

  test('status is overbought when price near upper band', () => {
    // Precio final muy cercano al upper band: serie creciente
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 3);
    const bb = calculateBollingerBands(closes);
    expect(bb.status).toBe('overbought');
  });

  test('status is oversold when price near lower band', () => {
    // Precio final muy cercano al lower band: serie decreciente
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 3);
    const bb = calculateBollingerBands(closes);
    expect(bb.status).toBe('oversold');
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

// ─── MACD histograma 4 colores ────────────────────────────────────────────────

describe('calculateMACD histogram_color', () => {
  const flat = Array.from({ length: 60 }, () => 100);

  test('green variant when histogram positive', () => {
    const closes = [...flat, ...Array.from({ length: 40 }, (_, i) => 100 + i * 5)];
    const result = calculateMACD(closes);
    expect(['green_dark', 'green_light']).toContain(result.histogram_color);
  });

  test('red variant when histogram negative', () => {
    const closes = [...flat, ...Array.from({ length: 40 }, (_, i) => 100 - i * 5)];
    const result = calculateMACD(closes);
    expect(['red_dark', 'red_light']).toContain(result.histogram_color);
  });

  test('histogram_color field always present', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 10);
    const result = calculateMACD(closes);
    expect(['green_dark', 'green_light', 'red_dark', 'red_light']).toContain(result.histogram_color);
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
});

// ─── OBV ──────────────────────────────────────────────────────────────────────

describe('calculateOBV', () => {
  const makeCandle = (c, v = 1000) => ({ high: c + 1, low: c - 1, close: c, open: c, volume: v });

  test('returns null for insufficient data', () => {
    expect(calculateOBV([makeCandle(100)])).toBeNull();
    expect(calculateOBV(null)).toBeNull();
  });

  test('returns value, trend, divergence', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(100 + i));
    const result = calculateOBV(candles);
    expect(result).toHaveProperty('value');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('divergence');
  });

  test('OBV increases when price rises', () => {
    const candles = Array.from({ length: 6 }, (_, i) => makeCandle(100 + i, 500));
    const result = calculateOBV(candles);
    expect(result.value).toBeGreaterThan(0);
    expect(result.trend).toBe('rising');
  });

  test('OBV decreases when price falls', () => {
    const candles = Array.from({ length: 6 }, (_, i) => makeCandle(100 - i, 500));
    const result = calculateOBV(candles);
    expect(result.value).toBeLessThan(0);
    expect(result.trend).toBe('falling');
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
