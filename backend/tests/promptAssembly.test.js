/**
 * promptAssembly.test.js — ensamblado condicional del SYSTEM_PROMPT y poda del dataset.
 *
 * Revisión crítica 2026-07-26:
 *  - H4: ~61 de las 733 líneas del prompt son reglas sobre on-chain, ETF flows y DVOL. Para
 *    SOL esos tres bloques llegan SIEMPRE vacíos, así que son instrucciones inaplicables
 *    pagadas en cada análisis. Se filtran según el dato presente en vez de borrarse, para
 *    no perder la capacidad sobre BTC/ETH.
 *  - M2: buy_pressure_pct/sell_pressure_pct se acumulan sobre toda la ventana del TF y están
 *    clavados en ~50. Se retiran del dataset del LLM (siguen en payload y en BD).
 */

import { describe, test, expect } from '@jest/globals';
import {
  buildSystemPrompt, buildPrompt, buildLlmRequest, PROMPT_VERSION,
} from '../src/services/anthropicService.js';

const NOT_SUPPORTED = { available: false, unavailable_reason: 'not_supported_for_asset' };

const solCtx = {
  coin: 'SOL',
  onchain: NOT_SUPPORTED,
  etf_flows: NOT_SUPPORTED,
  volatility: { btc_dvol: { value: 37 }, eth_dvol: { value: 52 }, sol_dvol: null },
};

const btcCtx = {
  coin: 'BTC',
  onchain: { mvrv: 2.1, mvrv_signal: 'fair' },
  etf_flows: { trend_7d: 'accumulating' },
  volatility: { btc_dvol: { value: 37, regime: 'complacent' }, eth_dvol: { value: 52 }, sol_dvol: null },
};

describe('H4 · bloques condicionales del SYSTEM_PROMPT', () => {
  test('SOL: caen on-chain, ETF y DVOL', () => {
    const { system, blocks } = buildSystemPrompt(solCtx);
    expect(blocks).toEqual([]);
    expect(system).not.toContain('E. On-Chain Score');
    expect(system).not.toContain('F2. ETF Flows');
    expect(system).not.toContain('F3. Volatility Index');
  });

  test('BTC: los tres bloques se conservan', () => {
    const { system, blocks } = buildSystemPrompt(btcCtx);
    expect(blocks).toEqual(expect.arrayContaining(['onchain', 'etf_flows', 'dvol']));
    expect(system).toContain('E. On-Chain Score');
    expect(system).toContain('F2. ETF Flows');
    expect(system).toContain('F3. Volatility Index');
  });

  test('el prompt de SOL es sensiblemente más corto', () => {
    const sol = buildSystemPrompt(solCtx).system.length;
    const btc = buildSystemPrompt(btcCtx).system.length;
    expect(sol).toBeLessThan(btc);
    // La poda debe ser material, no cosmética: al menos 2.000 caracteres.
    expect(btc - sol).toBeGreaterThan(2000);
  });

  test('ningún marcador de bloque llega nunca al modelo', () => {
    for (const ctx of [solCtx, btcCtx, {}, null]) {
      expect(buildSystemPrompt(ctx).system).not.toMatch(/<<<\/?BLOCK:/);
    }
  });

  test('las secciones NO opcionales sobreviven en ambos casos', () => {
    for (const ctx of [solCtx, btcCtx]) {
      const { system } = buildSystemPrompt(ctx);
      expect(system).toContain('A. Derivatives Score');
      expect(system).toContain('B. Volume Flow Score');
      expect(system).toContain('F4. SMC');
      expect(system).toContain('OUTPUT FORMAT');
      expect(system).toContain('DECISION ENGINE');
    }
  });

  // Degradación: si la API on-chain falla en un análisis de BTC, el bloque debe caer — no
  // tiene sentido darle reglas sobre datos que no tiene delante.
  test('BTC con on-chain caído pierde solo ese bloque', () => {
    const { system, blocks } = buildSystemPrompt({
      ...btcCtx, onchain: { available: false, unavailable_reason: 'fetch_failed' },
    });
    expect(blocks).not.toContain('onchain');
    expect(blocks).toEqual(expect.arrayContaining(['etf_flows', 'dvol']));
    expect(system).not.toContain('E. On-Chain Score');
    expect(system).toContain('F2. ETF Flows');
  });

  test('DVOL solo cuenta para la moneda analizada, no por recibir el de BTC', () => {
    // SOL recibe btc_dvol/eth_dvol como contexto de mercado, pero no tiene DVOL propio.
    expect(buildSystemPrompt(solCtx).blocks).not.toContain('dvol');
    expect(buildSystemPrompt({ ...btcCtx, coin: 'ETH' }).blocks).toContain('dvol');
  });

  test('contexto vacío o nulo no rompe el ensamblado', () => {
    expect(() => buildSystemPrompt(null)).not.toThrow();
    expect(buildSystemPrompt(null).system.length).toBeGreaterThan(1000);
  });
});

describe('M2 · poda del dataset que ve el LLM', () => {
  const ctxConVolumen = {
    coin: 'SOL',
    technical: {
      '4h': {
        trend: 'bullish',
        volume_delta: {
          buy_pressure_pct: 50.6, sell_pressure_pct: 49.4,
          last_candle_type: 'bullish', anomaly: false, source: 'taker_real',
        },
      },
      '1D': { volume_delta: { buy_pressure_pct: 51.2, sell_pressure_pct: 48.8, anomaly: false } },
    },
  };

  test('buy/sell_pressure_pct no llegan al modelo, en ningún TF', () => {
    const out = buildPrompt(ctxConVolumen);
    expect(out).not.toContain('buy_pressure_pct');
    expect(out).not.toContain('sell_pressure_pct');
  });

  test('los campos estacionarios del bloque SÍ se conservan', () => {
    const out = buildPrompt(ctxConVolumen);
    expect(out).toContain('last_candle_type');
    expect(out).toContain('anomaly');
    expect(out).toContain('taker_real');
  });

  test('no muta el contexto original (sigue sirviendo al payload y a la BD)', () => {
    buildPrompt(ctxConVolumen);
    expect(ctxConVolumen.technical['4h'].volume_delta.buy_pressure_pct).toBe(50.6);
  });

  test('expected_scores sigue excluido (guardia C2)', () => {
    const out = buildPrompt({ ...ctxConVolumen, expected_scores: { volume: { score: -1 } } });
    expect(out).not.toContain('expected_scores');
  });

  test('technical ausente o volume_delta nulo no rompen', () => {
    expect(() => buildPrompt({ coin: 'SOL' })).not.toThrow();
    expect(() => buildPrompt({ technical: { '4h': { trend: 'bullish' } } })).not.toThrow();
    expect(() => buildPrompt({ technical: { '4h': null } })).not.toThrow();
  });
});

describe('buildLlmRequest integra ambos', () => {
  test('reporta los bloques incluidos y usa el system filtrado', () => {
    const req = buildLlmRequest(solCtx, 'claude-opus-4-8');
    expect(req.prompt_blocks).toEqual([]);
    expect(req.system).not.toContain('E. On-Chain Score');
    // Se compara con la constante, no con un literal: lo que se prueba es que el campo
    // viaja, no qué versión concreta hay hoy (un bump no debe romper este test).
    expect(req.prompt_version).toBe(PROMPT_VERSION);
  });

  test('BTC recibe el prompt completo', () => {
    const req = buildLlmRequest(btcCtx, 'claude-opus-4-8');
    expect(req.prompt_blocks).toHaveLength(3);
    expect(req.system.length).toBeGreaterThan(buildLlmRequest(solCtx, 'claude-opus-4-8').system.length);
  });
});
