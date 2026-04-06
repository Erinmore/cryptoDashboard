import { computeIndicators } from './src/services/indicatorService.js';

process.env.DEBUG_CVD_OBV = 'true';

// Crear candles de prueba (planas)
const flatCandles = Array.from({ length: 50 }, (_, i) => ({
  t: 1000 + i,
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 1000,
}));

// Crear candles alcistas
const bullishCandles = Array.from({ length: 50 }, (_, i) => ({
  t: 2000 + i,
  open: 100 + i * 0.1,
  high: 101 + i * 0.1,
  low: 99 + i * 0.1,
  close: 100.5 + i * 0.1,
  volume: 1000 + i * 10,
}));

// Crear candles bajistas
const bearishCandles = Array.from({ length: 50 }, (_, i) => ({
  t: 3000 + i,
  open: 100 - i * 0.1,
  high: 99 - i * 0.1,
  low: 101 - i * 0.1,
  close: 99.5 - i * 0.1,
  volume: 1000 + i * 10,
}));

console.log('=== TEST 1: FLAT CANDLES ===');
const flatResult = computeIndicators(flatCandles, '1h');
if (flatResult) {
  console.log('CVD:', flatResult.cvd);
  console.log('OBV:', flatResult.obv);
  console.log('Same value?', flatResult.cvd?.value === flatResult.obv?.value);
}

console.log('\n=== TEST 2: BULLISH CANDLES ===');
const bullResult = computeIndicators(bullishCandles, '1h');
if (bullResult) {
  console.log('CVD:', bullResult.cvd);
  console.log('OBV:', bullResult.obv);
  console.log('Same value?', bullResult.cvd?.value === bullResult.obv?.value);
}

console.log('\n=== TEST 3: BEARISH CANDLES ===');
const bearResult = computeIndicators(bearishCandles, '1h');
if (bearResult) {
  console.log('CVD:', bearResult.cvd);
  console.log('OBV:', bearResult.obv);
  console.log('Same value?', bearResult.cvd?.value === bearResult.obv?.value);
}
