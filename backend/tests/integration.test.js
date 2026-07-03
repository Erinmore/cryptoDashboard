/**
 * Fase 15 — Integration tests for CRYPTEX API endpoints.
 *
 * Strategy: mock all external HTTP calls (Binance, CoinGecko, Coinalyze,
 * alternative.me, etc.) so tests are fast, deterministic, and offline-safe.
 * The app is imported once per suite and torn down after all tests.
 *
 * Coverage:
 *   GET  /health
 *   GET  /api/data            — happy path, validation errors, degraded mode
 *   GET  /api/analyze/payload — shape, validation
 *   GET  /api/history/:coin   — empty store, pagination, validation
 *   POST /api/analyze         — stub LLM (analyzeMarket still disabled)
 *   404 / error handler
 */

import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import { existsSync, rmSync } from 'fs';

// Aislar la BBDD del test: usar un fichero temporal en vez de ./data/cryptex.db
// (app.js llama initDb() al importarse, así que hay que fijar DB_PATH ANTES de ese
// import dinámico más abajo). Sin esto, los tests escribían en la BBDD real.
const TEST_DB = path.join(os.tmpdir(), `cryptex-itest-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = TEST_DB + suffix;
    if (existsSync(f)) { try { rmSync(f); } catch { /* best-effort */ } }
  }
});

// ─── Mock all external services BEFORE importing the app ──────────────────────
// Jest hoists jest.mock() calls; with ESM we use jest.unstable_mockModule instead.

const MOCK_CANDLES = Array.from({ length: 100 }, (_, i) => ({
  t: 1700000000000 + i * 3600000,
  open:   95000 + i * 10,
  high:   95500 + i * 10,
  low:    94500 + i * 10,
  close:  95200 + i * 10,
  volume: 500 + i,
  taker_buy_base:  250 + i * 0.5,
  taker_buy_quote: 23750000 + i * 1000,
  quote_volume:    47500000 + i * 2000,
}));

const MOCK_PRICE = { price: 95000, change_24h_pct: 2.5 };
const MOCK_FEAR_GREED = { value: 65, classification: 'Greed', trend: 'stable', trend_7d_change: 5 };
const MOCK_GLOBAL_MARKET = {
  total_market_cap_usd: 3e12,
  market_cap_change_24h_pct: 1.2,
  btc_dominance: 52.5,
  altcoin_market_cap_usd: 1.4e12,
};
const MOCK_COIN_MARKET = {
  market_cap_usd: 1.8e12,
  volume_24h_usd: 35e9,
  ath_usd: 109000,
  ath_change_pct: -12.5,
  atl_usd: 67.81,
  atl_change_pct: 140000,
};
const MOCK_DERIVATIVES = {
  funding_rate: {
    rate_pct: 0.01,
    annualized_pct: 10.95,
    severity: 'normal',
    trend: 'stable',
    signal: 'neutral',
    predicted_rate_pct: 0.012,
  },
  open_interest: {
    value_usd: 25e9,
    change_24h_pct: 1.5,
    signal: 'neutral',
  },
  long_short_ratio: { long_pct: 52, short_pct: 48, signal: 'neutral' },
  liquidations: { longs_usd: 10e6, shorts_usd: 8e6, total_usd: 18e6, signal: 'neutral' },
};
const MOCK_ORDER_BOOK = {
  buyWall:           { price: 94000, size: 50, side: 'buy' },
  sellWall:          { price: 96000, size: 45, side: 'sell' },
  spread:            10,
  spread_pct:        0.000105,
  imbalance_ratio:   1.05,
  imbalance_top5_ratio: 1.1,
  imbalance_signal:  'balanced',
};
const MOCK_BINANCE_TICKER = { last: 95000, volume: 1000, quoteVolume: 95e6 };

jest.unstable_mockModule('../src/services/coingeckoService.js', () => ({
  fetchOHLC:             jest.fn(async () => MOCK_CANDLES),
  fetchCurrentPrice:     jest.fn(async () => MOCK_PRICE),
  fetchGlobalMarketData: jest.fn(async () => MOCK_GLOBAL_MARKET),
  fetchCoinMarketData:   jest.fn(async () => MOCK_COIN_MARKET),
  fetchHistoricalKlines: jest.fn(async () => []),
  fetchHistoricalClose:  jest.fn(async () => 95000),
}));

jest.unstable_mockModule('../src/services/fearGreedService.js', () => ({
  fetchFearGreed: jest.fn(async () => MOCK_FEAR_GREED),
}));

jest.unstable_mockModule('../src/services/coinalyzeService.js', () => ({
  fetchDerivativesData: jest.fn(async () => MOCK_DERIVATIVES),
}));

jest.unstable_mockModule('../src/services/binanceOrderBookService.js', () => ({
  fetchOrderBookWalls: jest.fn(async () => MOCK_ORDER_BOOK),
  fetchBinanceTicker:  jest.fn(async () => MOCK_BINANCE_TICKER),
}));

jest.unstable_mockModule('../src/services/liquidationClustersService.js', () => ({
  fetchLiquidationClusters: jest.fn(async () => null),
}));

jest.unstable_mockModule('../src/services/onchainService.js', () => ({
  fetchOnchainMetrics: jest.fn(async () => null),
}));

jest.unstable_mockModule('../src/services/etfFlowsService.js', () => ({
  fetchEtfFlows: jest.fn(async () => null),
}));

jest.unstable_mockModule('../src/services/macroService.js', () => ({
  fetchMacroData: jest.fn(async () => ({
    dxy:  { value: 104.5, change_24h_pct: -0.3, trend_5d: 'falling' },
    spx:  { value: 5200,  change_24h_pct:  0.8, trend_5d: 'rising'  },
    gold: { value: 2400,  change_24h_pct:  0.5, trend_5d: 'rising'  },
  })),
}));

jest.unstable_mockModule('../src/services/deribitService.js', () => ({
  fetchVolatilityData: jest.fn(async () => ({
    btc_dvol:  { value: 55, regime: 'normal', change_24h_pct: 2.1, source: 'deribit' },
    eth_dvol:  { value: 70, regime: 'elevated', change_24h_pct: -1.5, source: 'deribit' },
    sol_dvol:  null,
  })),
}));

// anthropicService stub — mock returns new {structured, narrative, ai_metadata} format
jest.unstable_mockModule('../src/services/anthropicService.js', () => ({
  analyzeMarket: jest.fn(async () => ({
    structured: {
      action:               'Esperar',
      confidence:           'Media',
      risk_score:           6,
      conviction:           0.4,
      primary_driver:       'derivatives',
      has_executable_setup: false,
      gating_active:        false,
      gating_reason:        null,
      contradictions_found: true,
      scores: { derivatives: 0, structure: -1, volume: 0, onchain: 0, total: -0.2 },
      setup:            null,
      executive_summary: 'Señales contradictorias entre derivados y estructura. Sin setup ejecutable en este momento.',
    },
    narrative: {
      smart_money_read:      'Liquidez profesional en modo observación.',
      divergences_anomalies: 'CVD 1D divergente con precio.',
      tactical_setup:        'Sin setup ejecutable.',
      risk_analysis:         'Risk score 6/10 por conflicto de timeframes.',
      recommendation_detail: 'Esperar confirmación estructural antes de entrar.',
      invalidation:          'Cierre por debajo del soporte en 4h invalida el sesgo alcista.',
    },
    ai_metadata: {
      model:          'stub',
      prompt_version: 'v5_3_tf_naming_unified',
      input_tokens:   0,
      output_tokens:  0,
    },
  })),
  buildPrompt: jest.fn(() => 'stub prompt'),
  buildLlmRequest: jest.fn((ctx) => ({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    prompt_version: 'v5_3_tf_naming_unified',
    system: 'stub system prompt',
    messages: [{ role: 'user', content: 'stub prompt' }],
  })),
  PROMPT_VERSION: 'v5_3_tf_naming_unified',
}));

// ─── Import app AND mocked modules AFTER mocks are in place ──────────────────
// Import createApp (not index.js) to avoid calling app.listen() during tests.
const { createApp } = await import('../src/app.js');
const { default: supertest } = await import('supertest');

const app = createApp();

// Hold references to mocked fns for degraded-mode tests
const { fetchOrderBookWalls: mockFetchOrderBookWalls } =
  await import('../src/services/binanceOrderBookService.js');
const { fetchFearGreed: mockFetchFearGreed } =
  await import('../src/services/fearGreedService.js');
const { analyzeMarket: mockAnalyzeMarket } =
  await import('../src/services/anthropicService.js');

const request = supertest(app);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expectMeta(body) {
  expect(body.meta).toBeDefined();
  expect(typeof body.meta.request_id).toBe('string');
  expect(typeof body.meta.timestamp).toBe('string');
}

// ─── GET /health ─────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200 with operational status', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('operational');
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.services).toBeDefined();
  });
});

// ─── GET /api/data ────────────────────────────────────────────────────────────

describe('GET /api/data', () => {
  test('returns 200 with correct top-level shape for BTC/4h', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=4h');
    expect(res.status).toBe(200);
    expectMeta(res.body);

    expect(res.body.coin).toBe('BTC');
    expect(res.body.primary_tf).toBe('4h');
    expect(typeof res.body.price_current).toBe('number');
    expect(typeof res.body.price_change_24h_pct).toBe('number');
  });

  test('returns candles array for the primary TF', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=4h');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.candles)).toBe(true);
    expect(res.body.candles.length).toBeGreaterThan(0);

    const c = res.body.candles[0];
    expect(c).toHaveProperty('t');
    expect(c).toHaveProperty('open');
    expect(c).toHaveProperty('high');
    expect(c).toHaveProperty('low');
    expect(c).toHaveProperty('close');
    expect(c).toHaveProperty('volume');
  });

  test('technical object contains all four timeframes', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=4h');
    expect(res.status).toBe(200);
    const { technical } = res.body;
    expect(technical).toBeDefined();
    for (const tf of ['1h', '4h', '1D', '1W']) {
      expect(technical[tf]).toBeDefined();
    }
  });

  test('technical[tf] contains key indicators', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=4h');
    const t = res.body.technical['4h'];
    expect(t).toHaveProperty('rsi');
    expect(t).toHaveProperty('macd');
    expect(t).toHaveProperty('bollinger_bands');
    expect(t).toHaveProperty('adx');
    expect(t).toHaveProperty('super_trend');
    expect(t).toHaveProperty('trend');
    expect(t).toHaveProperty('volume_profile');
    expect(t).toHaveProperty('smc');
  });

  test('fear_greed is populated', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=4h');
    expect(res.body.fear_greed).not.toBeNull();
    expect(typeof res.body.fear_greed.value).toBe('number');
  });

  test('derivatives is populated', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=4h');
    const d = res.body.derivatives;
    expect(d).not.toBeNull();
    expect(d.funding_rate).toBeDefined();
    expect(d.open_interest).toBeDefined();
    expect(d.long_short_ratio).toBeDefined();
    expect(d.liquidations).toBeDefined();
  });

  test('history object is present (in-memory histories)', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=4h');
    expect(res.body.history).toBeDefined();
    // Keys may be empty arrays on cold start — just check object exists
    expect(typeof res.body.history).toBe('object');
  });

  test('defaults coin=BTC tf=4h when params omitted', async () => {
    const res = await request.get('/api/data');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('BTC');
    expect(res.body.primary_tf).toBe('4h');
  });

  test('works for ETH', async () => {
    const res = await request.get('/api/data?coin=ETH&tf=1h');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('ETH');
  });

  test('works for SOL', async () => {
    const res = await request.get('/api/data?coin=SOL&tf=1D');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('SOL');
  });

  test('returns 400 for invalid coin', async () => {
    const res = await request.get('/api/data?coin=DOGE&tf=4h');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coin/i);
  });

  test('returns 400 for invalid timeframe', async () => {
    const res = await request.get('/api/data?coin=BTC&tf=5m');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tf/i);
  });

  test('coin param is case-insensitive', async () => {
    const res = await request.get('/api/data?coin=btc&tf=4h');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('BTC');
  });

  test('degraded mode: endpoint stays 200 when order book service returns null', async () => {
    // Temporarily override mock to return null (simulates service outage)
    mockFetchOrderBookWalls.mockResolvedValueOnce(null);

    const res = await request.get('/api/data?coin=ETH&tf=1W'); // different coin/tf avoids cache
    expect(res.status).toBe(200);
  });

  test('degraded mode: endpoint stays 200 when fear_greed service returns null', async () => {
    mockFetchFearGreed.mockResolvedValueOnce(null);

    const res = await request.get('/api/data?coin=SOL&tf=1W'); // different coin/tf avoids cache
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/analyze/payload ─────────────────────────────────────────────────

describe('GET /api/analyze/payload', () => {
  test('returns 200 with meta + payload for BTC/4h', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    expect(res.status).toBe(200);
    expectMeta(res.body);
    expect(res.body.payload).toBeDefined();
  });

  test('payload contains all expected top-level blocks', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const p = res.body.payload;

    const requiredKeys = [
      'coin', 'primary_tf', 'price_current', 'price_change_24h_pct',
      'global_market', 'coin_market', 'sentiment', 'technical',
      'timeframe_analysis', 'derivatives', 'onchain', 'etf_flows',
      'macro', 'volatility', 'order_book', 'volume_history',
    ];
    for (const key of requiredKeys) {
      expect(p).toHaveProperty(key);
    }
  });

  test('response includes llm_request with system prompt + user message', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    expect(res.status).toBe(200);
    expect(res.body.llm_request).toBeDefined();
    expect(res.body.llm_request.system).toEqual(expect.any(String));
    expect(res.body.llm_request.prompt_version).toBe('v5_3_tf_naming_unified');
    expect(Array.isArray(res.body.llm_request.messages)).toBe(true);
    expect(res.body.llm_request.messages[0].role).toBe('user');
  });

  test('payload.coin and primary_tf match query params', async () => {
    const res = await request.get('/api/analyze/payload?coin=ETH&primary_tf=1h');
    expect(res.status).toBe(200);
    expect(res.body.payload.coin).toBe('ETH');
    expect(res.body.payload.primary_tf).toBe('1h');
  });

  test('payload.technical has all four TFs with smc and volume_profile', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const tech = res.body.payload.technical;
    for (const tf of ['1h', '4h', '1D', '1W']) {
      expect(tech[tf]).toBeDefined();
      expect(tech[tf]).toHaveProperty('smc');
      expect(tech[tf]).toHaveProperty('volume_profile');
    }
  });

  test('payload.order_book has imbalance fields', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const ob = res.body.payload.order_book;
    expect(ob).not.toBeNull();
    expect(ob).toHaveProperty('imbalance_ratio');
    expect(ob).toHaveProperty('imbalance_top5_ratio');
    expect(ob).toHaveProperty('imbalance_signal');
    expect(ob).toHaveProperty('spread_usd');
    expect(ob).toHaveProperty('spread_pct');
  });

  test('payload.sentiment.fear_greed is populated', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    expect(res.body.payload.sentiment.fear_greed).not.toBeNull();
    expect(typeof res.body.payload.sentiment.fear_greed.value).toBe('number');
  });

  test('payload.macro is populated (dxy, spx, gold)', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const macro = res.body.payload.macro;
    expect(macro).not.toBeNull();
    expect(macro).toHaveProperty('dxy');
    expect(macro).toHaveProperty('spx');
    expect(macro).toHaveProperty('gold');
  });

  test('payload.volatility has btc_dvol and eth_dvol', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const vol = res.body.payload.volatility;
    expect(vol).not.toBeNull();
    expect(vol).toHaveProperty('btc_dvol');
    expect(vol).toHaveProperty('eth_dvol');
    expect(vol.btc_dvol).toHaveProperty('value');
    expect(vol.btc_dvol).toHaveProperty('regime');
  });

  test('payload.onchain reports unavailable_reason for ETH (not BTC)', async () => {
    const res = await request.get('/api/analyze/payload?coin=ETH&primary_tf=4h');
    expect(res.body.payload.onchain).toEqual({
      available: false,
      unavailable_reason: 'not_supported_for_asset',
    });
  });

  test('payload.etf_flows reports unavailable_reason for SOL (no spot ETF)', async () => {
    const res = await request.get('/api/analyze/payload?coin=SOL&primary_tf=4h');
    expect(res.body.payload.etf_flows).toEqual({
      available: false,
      unavailable_reason: 'not_supported_for_asset',
    });
  });

  test('payload.timeframe_analysis has conflict field', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const tfa = res.body.payload.timeframe_analysis;
    expect(tfa).not.toBeNull();
    expect(tfa).toHaveProperty('conflict');
    expect(tfa).toHaveProperty('primary_tf');
  });

  test('payload.derivatives.funding_rate has severity field', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const fr = res.body.payload.derivatives.funding_rate;
    expect(fr).not.toBeNull();
    expect(fr).toHaveProperty('severity');
    expect(['normal', 'elevated', 'high', 'extreme']).toContain(fr.severity);
  });

  test('payload.technical[tf] has distance_to_nearest_support/resistance fields', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const t4h = res.body.payload.technical['4h'];
    expect(t4h).toHaveProperty('distance_to_nearest_support_pct');
    expect(t4h).toHaveProperty('distance_to_nearest_resistance_pct');
  });

  test('accepts tf alias param in addition to primary_tf', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&tf=1D');
    expect(res.status).toBe(200);
    expect(res.body.payload.primary_tf).toBe('1D');
  });

  test('returns 400 for invalid coin', async () => {
    const res = await request.get('/api/analyze/payload?coin=XRP&primary_tf=4h');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coin/i);
  });

  test('returns 400 for invalid timeframe', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=3d');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/primary_tf/i);
  });
});

// ─── GET /api/history/:coin ───────────────────────────────────────────────────

describe('GET /api/history/:coin', () => {
  test('returns 200 with empty analyses on cold start', async () => {
    const res = await request.get('/api/history/BTC');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('BTC');
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.analyses)).toBe(true);
  });

  test('returns correct pagination fields', async () => {
    const res = await request.get('/api/history/BTC?limit=5&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(0);
  });

  test('clamps limit to max 50', async () => {
    const res = await request.get('/api/history/BTC?limit=999');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
  });

  test('clamps limit to min 1', async () => {
    const res = await request.get('/api/history/BTC?limit=0');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
  });

  test('clamps offset to min 0', async () => {
    const res = await request.get('/api/history/BTC?offset=-5');
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(0);
  });

  test('works for ETH and SOL', async () => {
    const eth = await request.get('/api/history/ETH');
    expect(eth.status).toBe(200);
    expect(eth.body.coin).toBe('ETH');

    const sol = await request.get('/api/history/SOL');
    expect(sol.status).toBe(200);
    expect(sol.body.coin).toBe('SOL');
  });

  test('coin param is case-insensitive', async () => {
    const res = await request.get('/api/history/btc');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('BTC');
  });

  test('returns 400 for unknown coin', async () => {
    const res = await request.get('/api/history/DOGE');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coin/i);
  });
});

// ─── POST /api/analyze ────────────────────────────────────────────────────────

describe('POST /api/analyze', () => {
  test('returns 200 with structured + narrative shape (stub LLM)', async () => {
    const res = await request
      .post('/api/analyze')
      .send({ coin: 'BTC', primary_tf: '4h' });

    expect(res.status).toBe(200);
    expectMeta(res.body);
    expect(res.body.coin).toBe('BTC');
    expect(res.body.primary_tf).toBe('4h');

    // structured block
    expect(res.body.structured).toBeDefined();
    expect(res.body.structured.action).toBe('Esperar');
    expect(res.body.structured.confidence).toBe('Media');
    expect(typeof res.body.structured.risk_score).toBe('number');
    expect(typeof res.body.structured.conviction).toBe('number');
    expect(res.body.structured.scores).toBeDefined();
    expect(typeof res.body.structured.scores.derivatives).toBe('number');

    // narrative block
    expect(res.body.narrative).toBeDefined();
    expect(typeof res.body.narrative.smart_money_read).toBe('string');
    expect(typeof res.body.narrative.recommendation_detail).toBe('string');

    // ai_metadata
    expect(res.body.ai_metadata).toBeDefined();
    expect(res.body.ai_metadata.prompt_version).toBe('v5_3_tf_naming_unified');
  });

  test('fail-safe: Comprar sin puerta se degrada a Esperar (§6.4 Fase 2)', async () => {
    // El LLM devuelve un Comprar que no cumple la puerta (derivatives/volume < +1).
    mockAnalyzeMarket.mockResolvedValueOnce({
      structured: {
        action: 'Comprar',
        confidence: 'Alta',
        risk_score: 4,
        conviction: 0.7,
        primary_driver: 'structure',
        has_executable_setup: true,
        gating_active: false,
        gating_reason: null,
        contradictions_found: false,
        scores: { derivatives: 0, structure: 2, volume: 0, onchain: 0, total: 0.8 },
        setup: { entry_price: 100, stop_price: 95, tp1_price: 110, tp2_price: 120, validity_candles: 8, tf_execution: '4h' },
        executive_summary: 'Ruptura alcista con estructura fuerte.',
      },
      narrative: {
        smart_money_read: 'x', divergences_anomalies: 'x', tactical_setup: 'x',
        risk_analysis: 'x', recommendation_detail: 'x', invalidation: 'x',
      },
      ai_metadata: { model: 'stub', prompt_version: 'v5_3_tf_naming_unified', input_tokens: 0, output_tokens: 0 },
    });

    const res = await request.post('/api/analyze').send({ coin: 'BTC', primary_tf: '4h' });
    expect(res.status).toBe(200);
    expect(res.body.structured.action).toBe('Esperar');       // degradado
    expect(res.body.structured.fail_safe_applied).toBe(true);
    expect(res.body.structured.fail_safe_original_action).toBe('Comprar');
    expect(res.body.structured.has_executable_setup).toBe(false);
    expect(res.body.structured.setup).toBeNull();
  });

  test('defaults coin=BTC primary_tf=4h when body omitted', async () => {
    const res = await request.post('/api/analyze').send({});
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('BTC');
    expect(res.body.primary_tf).toBe('4h');
  });

  test('coin is uppercased automatically', async () => {
    const res = await request
      .post('/api/analyze')
      .send({ coin: 'eth', primary_tf: '1h' });
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('ETH');
  });

  test('returns 400 for invalid coin', async () => {
    const res = await request
      .post('/api/analyze')
      .send({ coin: 'LUNA', primary_tf: '4h' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coin/i);
  });

  test('returns 400 for invalid primary_tf', async () => {
    const res = await request
      .post('/api/analyze')
      .send({ coin: 'BTC', primary_tf: '15m' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/primary_tf/i);
  });

  test('analysis is persisted — history returns it after POST', async () => {
    // POST an analysis for SOL (unique coin to avoid cache conflicts)
    const postRes = await request
      .post('/api/analyze')
      .send({ coin: 'SOL', primary_tf: '4h' });
    expect(postRes.status).toBe(200);

    // History should now have at least 1 entry for SOL
    const histRes = await request.get('/api/history/SOL?limit=1');
    expect(histRes.status).toBe(200);
    expect(histRes.body.total).toBeGreaterThanOrEqual(1);

    const entry = histRes.body.analyses[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('action');
    expect(entry).toHaveProperty('confidence');
    expect(entry).toHaveProperty('executive_summary');
    expect(entry.action).toBe('Esperar');
  });
});

// ─── Outcome / backtesting ────────────────────────────────────────────────────

describe('POST /api/outcome/run', () => {
  test('devuelve processed (0 con análisis recientes <1h)', async () => {
    const res = await request.post('/api/outcome/run');
    expect(res.status).toBe(200);
    expect(typeof res.body.processed).toBe('number');
  });
});

describe('GET /api/outcome/stats', () => {
  test('agregadas (sin coin) → objeto stats', async () => {
    const res = await request.get('/api/outcome/stats');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('ALL');
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats).toHaveProperty('total_evaluated');
    expect(res.body.stats).toHaveProperty('win_rate_24h');
  });

  test('filtra por coin válida', async () => {
    const res = await request.get('/api/outcome/stats?coin=btc');
    expect(res.status).toBe(200);
    expect(res.body.coin).toBe('BTC');
  });

  test('coin inválida → 400', async () => {
    const res = await request.get('/api/outcome/stats?coin=LUNA');
    expect(res.status).toBe(400);
  });
});

// ─── 404 + error handler ─────────────────────────────────────────────────────

describe('404 and error handler', () => {
  test('unknown route returns 404', async () => {
    const res = await request.get('/api/unknown-route');
    expect(res.status).toBe(404);
  });

  test('404 body has error field', async () => {
    const res = await request.get('/this/does/not/exist');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});
