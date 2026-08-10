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
    value_coins: 260000, // Coinalyze reporta en monedas base (auditoria #2, hallazgo 4)
    unit: 'base_coin',
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
  // Réplica del helper real (pura): deriva el USD del OI sin mutar el cacheado.
  withDerivedOiUsd: (derivatives, price) => {
    const oi = derivatives?.open_interest;
    if (!oi || oi.value_coins == null || !price) return derivatives;
    return { ...derivatives, open_interest: { ...oi, value_usd: Math.round(oi.value_coins * price), value_usd_basis: 'derived_coins_x_spot' } };
  },
  // Ídem para liquidaciones: Coinalyze también las reporta en monedas base (fix 2026-07-29).
  withDerivedLiqUsd: (derivatives, price) => {
    const liq = derivatives?.liquidations;
    if (!liq || liq.total_coins == null || !price) return derivatives;
    return {
      ...derivatives,
      liquidations: {
        ...liq,
        longs_usd:  Math.round(liq.longs_coins * price),
        shorts_usd: Math.round(liq.shorts_coins * price),
        total_usd:  Math.round(liq.total_coins * price),
        usd_basis: 'derived_coins_x_spot',
      },
    };
  },
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

// anthropicService stub — mock returns el formato narrador {narrative, executive_summary,
// ai_metadata} (pivot a ayudante de riesgo, §REORIENTACIÓN: el LLM ya no decide/puntúa nada).
jest.unstable_mockModule('../src/services/anthropicService.js', () => ({
  analyzeMarket: jest.fn(async () => ({
    narrative: {
      structure_read:          'Estructura 1D bajista, 4h en rango.',
      divergences_anomalies:   'CVD 1D divergente con precio.',
      key_levels_and_liquidity: 'Resistencia en 96000, soporte en 94000.',
      volatility_and_regime:   'Régimen normal, sin squeeze activo.',
      cycle_and_macro_read:    'Contexto macro mixto, sin sesgo claro.',
      scenarios:               'Un cierre 4h por encima de 96000 invalidaría la lectura bajista.',
    },
    executive_summary: 'Señales contradictorias entre derivados y estructura; sin lectura direccional clara.',
    ai_metadata: {
      model:          'stub',
      prompt_version: 'v10_0_narrator',
      input_tokens:   0,
      output_tokens:  0,
    },
  })),
  buildPrompt: jest.fn(() => 'stub prompt'),
  buildLlmRequest: jest.fn((ctx) => ({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    prompt_version: 'v10_0_narrator',
    system: 'stub system prompt',
    messages: [{ role: 'user', content: 'stub prompt' }],
  })),
  PROMPT_VERSION: 'v10_0_narrator',
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
      'timeframe_analysis', 'risk_geometry', 'derivatives_score', 'derivatives',
      'onchain', 'etf_flows', 'macro', 'volatility', 'order_book', 'volume_history',
    ];
    for (const key of requiredKeys) {
      expect(p).toHaveProperty(key);
    }
    // `gating`/`expected_scores` se retiraron con el pivot a ayudante de riesgo
    // (§REORIENTACIÓN): sin puerta direccional que gatear, no hay nada que precalcular.
    expect(p).not.toHaveProperty('gating');
    expect(p).not.toHaveProperty('expected_scores');
  });

  test('payload.risk_geometry exposes symmetric long/short geometry', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    const g = res.body.payload.risk_geometry;
    expect(g).toHaveProperty('long');
    expect(g).toHaveProperty('short');
    expect(g.long.direction).toBe('long');
    expect(g.short.direction).toBe('short');
    // Simétrico por construcción: mismos múltiplos de ATR en ambas direcciones.
    expect(g.long.rr).toBe(g.short.rr);
    expect(g.long.breakeven_win_rate_pct).toBe(g.short.breakeven_win_rate_pct);
    expect(g.validity_candles).toBe(6);
    expect(g.tf_execution).toBe('4h');
  });

  test('response includes llm_request with system prompt + user message', async () => {
    const res = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    expect(res.status).toBe(200);
    expect(res.body.llm_request).toBeDefined();
    expect(res.body.llm_request.system).toEqual(expect.any(String));
    expect(res.body.llm_request.prompt_version).toBe('v10_0_narrator');
    expect(Array.isArray(res.body.llm_request.messages)).toBe(true);
    expect(res.body.llm_request.messages[0].role).toBe('user');
  });

  test('payload.coin and primary_tf match query params', async () => {
    const res = await request.get('/api/analyze/payload?coin=ETH&primary_tf=1h');
    expect(res.status).toBe(200);
    expect(res.body.payload.coin).toBe('ETH');
    expect(res.body.payload.primary_tf).toBe('1h');
  });

  test('payload.btc_context: source=self for BTC, btc_klines for alts (C3)', async () => {
    const btc = await request.get('/api/analyze/payload?coin=BTC&primary_tf=4h');
    expect(btc.body.payload.btc_context).toBeDefined();
    expect(btc.body.payload.btc_context.source).toBe('self');

    const eth = await request.get('/api/analyze/payload?coin=ETH&primary_tf=4h');
    // El contexto de BTC para el alt existe y NO es 'self' (se calcula desde klines de BTC).
    expect(eth.body.payload.btc_context).toBeDefined();
    expect(eth.body.payload.btc_context.source).toBe('btc_klines');
    expect(eth.body.payload.btc_context).toHaveProperty('trend_1d');
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
  test('returns 200 with narrative + risk_geometry shape (stub LLM, pivot a ayudante de riesgo)', async () => {
    const res = await request
      .post('/api/analyze')
      .send({ coin: 'BTC', primary_tf: '4h' });

    expect(res.status).toBe(200);
    expectMeta(res.body);
    expect(res.body.coin).toBe('BTC');
    expect(res.body.primary_tf).toBe('4h');

    // El LLM ya no decide ni puntúa nada (§REORIENTACIÓN): no hay `structured`.
    expect(res.body.structured).toBeUndefined();

    // narrative block
    expect(res.body.narrative).toBeDefined();
    expect(typeof res.body.narrative.structure_read).toBe('string');
    expect(typeof res.body.narrative.scenarios).toBe('string');
    expect(typeof res.body.executive_summary).toBe('string');

    // ai_metadata
    expect(res.body.ai_metadata).toBeDefined();
    expect(res.body.ai_metadata.prompt_version).toBe('v10_0_narrator');

    // geometría de riesgo SIMÉTRICA — calculada por el backend, no declarada por el LLM.
    const g = res.body.risk_geometry;
    expect(g).toBeDefined();
    expect(g.long.direction).toBe('long');
    expect(g.short.direction).toBe('short');
    expect(g.long.rr).toBe(g.short.rr);
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
    expect(entry).toHaveProperty('executive_summary');
    // Columnas retiradas con el pivot (§REORIENTACIÓN): siguen existiendo para las filas
    // viejas, pero una fila nueva las deja en NULL — "los escritores dejan de producir".
    expect(entry.action).toBeNull();

    // `risk_geometry`: a diferencia del viejo `conditional_plan`, no depende del job de
    // outcome — se calcula con el ATR de decisión (síncrono) y llega completa desde el
    // primer render. Cada fila del historial la trae, no solo el último análisis.
    expect(entry).toHaveProperty('risk_geometry');
    expect(entry.risk_geometry).not.toBeNull();
    expect(entry.risk_geometry).toHaveProperty('long');
    expect(entry.risk_geometry).toHaveProperty('short');
    expect(entry.risk_geometry.long).toHaveProperty('rr');
    expect(entry.risk_geometry.long).toHaveProperty('target_reachability_pct');

    // Deuda §6: analysis_fvg_snapshot existe y el POST la deja consultable sin romper la
    // transacción. NOTA: MOCK_CANDLES es una rampa lineal con rangos solapados, donde
    // low[i] > high[i-2] es imposible → nunca genera FVGs. Por eso aquí solo se verifica
    // que la tabla está cableada; el binding del INSERT se prueba en fvgSnapshot.test.js
    // contra una BD real con filas de verdad.
    const { getDb } = await import('../src/config/db.js');
    const fvgRows = getDb()
      .prepare('SELECT * FROM analysis_fvg_snapshot WHERE analysis_id = ?')
      .all(entry.id);
    expect(Array.isArray(fvgRows)).toBe(true);
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
    // Fase 4 (C5/H6): integridad estadística.
    expect(res.body.stats).toHaveProperty('directional_n');
    expect(res.body.stats).toHaveProperty('sample_insufficient');
    expect(res.body.stats).toHaveProperty('win_rate_ci_low');
    expect(res.body.stats).toHaveProperty('win_rate_ci_high');
    expect(res.body.stats).toHaveProperty('setup_fill_rate');
    expect(res.body.stats).toHaveProperty('min_directional_sample');
    expect(Array.isArray(res.body.stats.by_primary_tf)).toBe(true);
    expect(Array.isArray(res.body.stats.by_model)).toBe(true);
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
