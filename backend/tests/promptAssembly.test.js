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

describe('buildPrompt — poda por falta de dueño (v8_0)', () => {
  const ctx = () => ({
    coin: 'SOL',
    technical: {
      '4h': {
        trend: 'bullish',
        regime: 'trending',
        trend_basis: 'ema_cross_swing',
        adx: { adx: 24.08, plus_di: 30.67, minus_di: 12.96, regime: 'weak_trend' },
        distance_to_nearest_support_pct: 1.2,
        distance_to_nearest_resistance_pct: 2.4,
        bollinger_bands: { width_pct: 5.68, volatility_state: 'squeeze', position: 0.9 },
        volume_delta: { buy_pressure_pct: 50.6, sell_pressure_pct: 49.4, anomaly: false },
      },
    },
    timeframe_analysis: {
      primary_tf: '4h', conflict: null, reasoning: 'No major conflict.',
      hierarchy_recommendation: 'default',
      hierarchy_tiers: { default: ['1D', '4h'] },
      guidance: 'For conflicting signals: wait for alignment',
    },
  });

  const dataset = (c) => JSON.parse(buildPrompt(c).match(/\{[\s\S]*\}/)[0]);

  test('retira los campos sin consumidor en el prompt', () => {
    const d = dataset(ctx())['technical']['4h'];
    // adx: su lectura ya viaja destilada en `regime` y `trend`; darlo crudo invita a
    // re-derivar estructura con otra regla (doble conteo).
    expect(d.adx).toBeUndefined();
    expect(d.trend_basis).toBeUndefined();          // constante: metadato, no señal
    expect(d.distance_to_nearest_support_pct).toBeUndefined();     // lo resuelve el gating
    expect(d.distance_to_nearest_resistance_pct).toBeUndefined();
    expect(d.volume_delta.buy_pressure_pct).toBeUndefined();       // M2, ya existente
  });

  test('conserva lo que SÍ tiene regla', () => {
    const d = dataset(ctx())['technical']['4h'];
    expect(d.regime).toBe('trending');
    expect(d.trend).toBe('bullish');
    expect(d.bollinger_bands.volatility_state).toBe('squeeze');    // consumido por B4
    expect(d.volume_delta.anomaly).toBe(false);
  });

  test('las instrucciones dentro de los datos se retiran; los hechos se quedan', () => {
    const ta = dataset(ctx()).timeframe_analysis;
    // `guidance` era texto imperativo (y en inglés) dentro del dataset: el comportamiento
    // se cambia en el system, no en dos sitios que pueden divergir.
    expect(ta.guidance).toBeUndefined();
    expect(ta.hierarchy_tiers).toBeUndefined();
    expect(ta.hierarchy_recommendation).toBeUndefined();
    expect(ta.conflict).toBeNull();          // hecho observado: se conserva
    expect(ta.reasoning).toBe('No major conflict.');
  });

  test('no revienta si faltan los bloques opcionales', () => {
    expect(() => buildPrompt({ coin: 'SOL' })).not.toThrow();
    expect(() => buildPrompt({ technical: { '4h': null } })).not.toThrow();
  });
});

describe('buildSystemPrompt — las reglas nuevas consumen flags precalculados (v8_0)', () => {
  const sys = () => {
    const r = buildSystemPrompt({ coin: 'SOL', technical: {} });
    return typeof r === 'string' ? r : r.system;
  };

  test('B4 lee volatility_state, no width_pct crudo', () => {
    const s = sys();
    expect(s).toContain('volatility_state');
    // El umbral vive en el backend (terciles de su propia serie). Si el prompt fijara un
    // corte absoluto de anchura sería una constante disfrazada: width_pct vale ~2.7 en 1h
    // y ~33 en 1W para el mismo activo.
    expect(s).not.toMatch(/width_pct\s*[<>]/);
  });

  test('la rúbrica de Execution es contable, no impresionista', () => {
    const s = sys();
    expect(s).toContain('CONTEO DE VOTOS');
    expect(s).toContain('momentum_state');   // usa el flag ya calculado del MACD
    expect(s).toContain('momentum_alignment');
  });

  test('el posicionamiento usa la medida normalizada contra el propio activo', () => {
    expect(sys()).toContain('volume_vs_30d_median');
  });
});

describe('v8_1 — sentimiento auto-normalizado, idioma y telemetría fuera del dataset', () => {
  const sys = () => {
    const r = buildSystemPrompt({ coin: 'SOL', technical: {} });
    return typeof r === 'string' ? r : r.system;
  };

  test('la regla de Fear & Greed ya no depende solo de cortes absolutos', () => {
    const s = sys();
    // Medido sobre 730 días: <15 dispara el 11,2 % y >85 el 1,0 % → el eje quedaba inerte
    // el 87,8 % del tiempo. La lectura relativa a su propio mes lo reactiva.
    expect(s).toContain('range_position_pct');
    expect(s).toContain('trend_30d');
  });

  test('el idioma de la salida está especificado, no implícito', () => {
    const s = sys();
    expect(s).toContain('IDIOMA');
    expect(s).toMatch(/ESPAÑOL/);
  });

  test('la telemetría de calibración y los campos de auditoría no llegan al LLM', () => {
    const ctx = {
      technical: {
        '4h': {
          bollinger_bands: { width_pct: 5.5, volatility_state: 'normal', width_pctile: 56.5, width_cuts: [4.5, 5.9] },
          cvd: { trend: 'rising', cvd_strength: 'moderate', cvd_strength_pctile: 61, cvd_strength_cuts: [1, 2] },
          super_trend: { trend: 'UP', support: 74.6, adaptive_multiplier: 2.687 },
        },
      },
      gating: {
        veto_short: true,
        contradictions: [{ code: 'htf_conflict_1w_1d' }],
        contradiction_count: 1,
        deduped_by_veto: ['cvd_1d_divergence', 'oi_flat_or_falling'],
        contradictions_signal_count: 4,
        contradiction_blocks_pre_veto: 3,
      },
    };
    const d = JSON.parse(buildPrompt(ctx).match(/\{[\s\S]*\}/)[0]);
    const t = d.technical['4h'];

    // La etiqueta se queda; el corte con el que se generó, no (si no, el modelo re-deriva
    // el umbral que el backend ya fijó).
    expect(t.bollinger_bands.volatility_state).toBe('normal');
    expect(t.bollinger_bands.width_pctile).toBeUndefined();
    expect(t.bollinger_bands.width_cuts).toBeUndefined();
    expect(t.cvd.cvd_strength).toBe('moderate');
    expect(t.cvd.cvd_strength_pctile).toBeUndefined();
    expect(t.super_trend.adaptive_multiplier).toBeUndefined();

    // deduped_by_veto lista contradicciones RETIRADAS a propósito: enseñárselas al modelo
    // invita al doble conteo que el dedupe existe para evitar.
    expect(d.gating.deduped_by_veto).toBeUndefined();
    expect(d.gating.contradictions_signal_count).toBeUndefined();
    expect(d.gating.contradiction_blocks_pre_veto).toBeUndefined();
    expect(d.gating.veto_short).toBe(true);          // la decisión sí viaja
    expect(d.gating.contradiction_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Poda v9_0 (auditoría previa al despliegue): campos que viajaban sin dueño.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildPrompt — poda por falta de dueño (v9_0)', () => {
  const ctx = () => ({
    coin: 'SOL', primary_tf: '4h',
    derivatives: {
      crowded_trade_flag: { active: true, side: 'long' },
      long_short_ratio: { long_pct: 72.6, signal: 'balanced', long_pct_percentile: 53.6, signal_cuts: [71.79, 73.13], signal_basis: 'percentile_7d' },
    },
    coin_market: { ath_change_pct: -74.2, ath_date: '2025-01-19', atl_usd: 0.5, atl_change_pct: 14482.38, atl_date: '2020-05-11' },
    derivatives_score: { score: 1, basis: ['x'], components: { oi_price_cell: 'new_money_long' }, rubric: { measured_at: '2026-07-29' } },
  });

  test('crowded_trade_flag no llega al modelo (huérfano: sin regla ni consumidor)', () => {
    expect(buildPrompt(ctx())).not.toContain('crowded_trade_flag');
  });

  test('los CORTES del LSR no llegan, pero sí la etiqueta y el valor', () => {
    const out = buildPrompt(ctx());
    expect(out).not.toContain('signal_cuts');
    expect(out).not.toContain('long_pct_percentile');
    expect(out).toContain('long_pct');
    expect(out).toContain('balanced');
  });

  test('atl_usd/atl_change_pct fuera; atl_date se conserva (sí tiene regla)', () => {
    const out = buildPrompt(ctx());
    expect(out).not.toContain('atl_change_pct');
    expect(out).not.toContain('atl_usd');
    expect(out).toContain('atl_date');
  });

  test('el score de derivados llega entero salvo su procedencia de calibración', () => {
    const out = buildPrompt(ctx());
    expect(out).toContain('derivatives_score');
    expect(out).toContain('new_money_long');   // components sí: explican el score
    expect(out).not.toContain('measured_at');  // rubric no: sirve para auditar, no para decidir
  });

  test('no muta el contexto original (el payload conserva todo para auditoría)', () => {
    const c = ctx();
    buildPrompt(c);
    expect(c.derivatives.crowded_trade_flag).toBeDefined();
    expect(c.derivatives.long_short_ratio.signal_cuts).toBeDefined();
    expect(c.derivatives_score.rubric).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auditoría previa al despliegue de v9_0: bloques cuyo SYSTEM se excluye pero cuyo
// DATO seguía viajando, y la colisión de `trend_1d`.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildPrompt — sin datos huérfanos de bloques excluidos (v9_0)', () => {
  const base = (coin) => ({
    coin, primary_tf: '4h',
    onchain: { available: false, unavailable_reason: 'not_supported_for_asset' },
    etf_flows: { available: false, unavailable_reason: 'not_supported_for_asset' },
    volatility: { btc_dvol: { value: 37.65, regime: 'complacent' }, eth_dvol: { value: 52.47 }, sol_dvol: null },
    sentiment: { fear_greed: { value: 29, classification: 'Fear', trend_1d: 'stable', trend_7d_change: -4 } },
    btc_context: { trend_1d: 'bearish', trend_1w: 'bearish' },
  });

  test('SOL: el DVOL de BTC/ETH no viaja si su sección no se monta', () => {
    const out = buildPrompt(base('SOL'));
    expect(out).not.toContain('btc_dvol');
    expect(out).not.toContain('37.65');
  });

  test('BTC: sí viaja, porque ahí la sección F3 SÍ se monta', () => {
    const out = buildPrompt(base('BTC'));
    expect(out).toContain('btc_dvol');
  });

  test('los bloques con available:false tampoco viajan', () => {
    const out = buildPrompt(base('SOL'));
    expect(out).not.toContain('not_supported_for_asset');
  });

  test('`fear_greed.trend_1d` se retira: colisiona con btc_context.trend_1d', () => {
    const out = buildPrompt(base('SOL'));
    // El vocabulario del sentimiento desaparece...
    expect(out).not.toContain('"trend_1d": "stable"');
    // ...pero el de BTC, que SÍ tiene regla, se conserva.
    expect(out).toContain('"trend_1d": "bearish"');
    // y el resto del bloque de F&G sigue intacto
    expect(out).toContain('trend_7d_change');
    expect(out).toContain('Fear');
  });

  test('no muta el contexto original', () => {
    const c = base('SOL');
    buildPrompt(c);
    expect(c.volatility.btc_dvol.value).toBe(37.65);
    expect(c.sentiment.fear_greed.trend_1d).toBe('stable');
  });
});

/**
 * `derivatives_score.components` SÍ viaja al modelo (el prompt lo documenta como desglose de
 * la celda), pero `atr_pct`/`band_pct` son el UMBRAL con el que se generó esa celda. Misma
 * regla que retiró `cvd_strength_cuts` y `width_cuts` en v8_1: el modelo lee la etiqueta, no
 * el corte — si ve la banda puede re-derivarla y discutir un umbral que el backend ya fijó.
 */
describe('poda de la telemetría de calibración del Derivatives Score', () => {
  const ctx = () => ({
    coin: 'SOL',
    derivatives_score: {
      score: 0,
      basis: ['sin señal de derivados'],
      data_insufficient: false,
      components: {
        oi_price_cell: 'no_signal', oi_price_score: 0,
        oi_change_24h_pct: 3.51, price_change_24h_pct_candles: -0.788,
        cascade_score: 0, cascade_reason: 'sin cascada', funding_score: 0,
        atr_pct: 1.18, band_pct: 1.445,
      },
      rubric: { measured_at: '2026-07-29', measured_scope: '90d' },
    },
  });

  test('atr_pct y band_pct no llegan al modelo', () => {
    const out = buildPrompt(ctx());
    expect(out).not.toContain('band_pct');
    expect(out).not.toContain('atr_pct');
    expect(out).not.toContain('1.445');
  });

  test('el resto del desglose SÍ se conserva (el modelo lo necesita para la sección A)', () => {
    const out = buildPrompt(ctx());
    expect(out).toContain('oi_price_cell');
    expect(out).toContain('no_signal');
    expect(out).toContain('price_change_24h_pct_candles');
    expect(out).toContain('cascade_reason');
  });

  test('rubric sigue podado (procedencia de la calibración, no decisión)', () => {
    expect(buildPrompt(ctx())).not.toContain('measured_scope');
  });

  test('NO muta el contexto: payload y BBDD siguen viendo la telemetría', () => {
    const c = ctx();
    buildPrompt(c);
    expect(c.derivatives_score.components.band_pct).toBe(1.445);
    expect(c.derivatives_score.components.atr_pct).toBe(1.18);
    expect(c.derivatives_score.rubric.measured_at).toBe('2026-07-29');
  });

  test('un derivatives_score sin components no rompe la poda', () => {
    expect(() => buildPrompt({ coin: 'SOL', derivatives_score: { score: 0 } })).not.toThrow();
    expect(() => buildPrompt({ coin: 'SOL', derivatives_score: null })).not.toThrow();
  });
});
