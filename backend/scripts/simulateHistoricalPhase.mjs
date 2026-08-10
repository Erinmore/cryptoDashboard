#!/usr/bin/env node
/**
 * simulateHistoricalPhase.mjs — lanza un análisis REAL (llamada a Anthropic) como si se
 * hiciera en una fecha pasada, para comprobar si la narrativa del pivot (v10_0_narrator) lee
 * bien fases de mercado conocidas (bajista/plana/alcista) en vez de esperar a que el mercado
 * real pase por las tres.
 *
 * QUÉ SE RECONSTRUYE CON DATOS REALES (sin inventar nada):
 *   - Candles de los 4 TFs (Binance klines históricos, incluyen taker_buy_base → CVD real).
 *   - Indicadores técnicos, SMC, Volume Profile, S/R — vía `computeTechnicalByTf` (misma
 *     función que usa producción, sin reimplementar nada).
 *   - Derivados (funding/OI/L-S ratio/liquidaciones) — vía los endpoints `-history` de
 *     Coinalyze acotados a `to=asof`. Los clasificadores (severity, trend, signal) están
 *     REPLICADOS aquí a mano desde `src/services/coinalyzeService.js` porque ese módulo no
 *     acepta un instante distinto de "ahora" — es una segunda copia deliberada y temporal
 *     para un script de un solo uso, no una fuente de verdad permanente. Si algún día esto se
 *     vuelve una herramienta recurrente, `coinalyzeService.js` debería aceptar un `asOfSec`
 *     opcional en vez de mantener dos copias del mismo umbral.
 *   - Fear & Greed — serie completa de alternative.me (histórico real, no hay "ahora" que
 *     reconstruir: la API ya sirve el pasado).
 *   - Contexto de BTC (trend_1d/1w) — klines históricos de BTC + `computeIndicators`, igual
 *     que `buildBtcContext` pero con `fetchHistoricalKlines` en vez de `fetchOHLC` (que solo
 *     sirve "ahora").
 *   - Geometría de riesgo (`risk_geometry`) y Derivatives Score — funciones puras reales
 *     (`computeRiskGeometry`, `computeDerivativesScore`), sin tocar.
 *
 * QUÉ SE DEGRADA A null (sin dato histórico limpio disponible):
 *   order_book (foto en vivo, sin histórico) · liquidation_clusters (depende del order book)
 *   · onchain/etf_flows/macro/volatility (tienen endpoint histórico pero ningún servicio del
 *   proyecto los usa hoy — añadirlos es trabajo aparte) · global_market/coin_market
 *   (CoinGecko "ahora"). El sistema ya sabe degradar con gracia cuando falta un bloque
 *   (mismo camino que un fallo real de API en producción), así que esto no rompe nada, solo
 *   empobrece el dataset frente al caso real.
 *
 * NO PERSISTE EN BBDD (ni de dev ni de producción) — mezclar un timestamp de "ahora" con
 * datos "de entonces" contaminaría el historial real. El resultado se imprime y se guarda en
 * un fichero JSON aparte.
 *
 * SÍ hace una llamada real a Anthropic (coste real, igual que cualquier análisis).
 *
 * Uso:
 *   COIN=SOL ASOF=2026-06-06T00:00:00Z LABEL=bajista MODEL=claude-sonnet-5 \
 *     node scripts/simulateHistoricalPhase.mjs
 */

import axios from 'axios';
import { writeFileSync } from 'fs';
import { fetchHistoricalKlines } from '../src/services/coingeckoService.js';
import { computeIndicators } from '../src/services/indicatorService.js';
import {
  computeTechnicalByTf, assembleAnalyzeContext,
} from '../src/controllers/analysisController.js';
import { analyzeMarket } from '../src/services/anthropicService.js';
import { TF_DURATION_MS, COINALYZE_SYMBOLS } from '../src/config/constants.js';
import env from '../src/config/env.js';

const COIN  = (process.env.COIN ?? 'SOL').toUpperCase();
const ASOF  = process.env.ASOF ?? new Date().toISOString();
const LABEL = process.env.LABEL ?? 'sin_etiqueta';
const MODEL = process.env.MODEL ?? 'claude-sonnet-5';
const PRIMARY_TF = process.env.TF ?? '4h';

const asofMs  = new Date(ASOF).getTime();
const asofSec = Math.floor(asofMs / 1000);
if (!Number.isFinite(asofMs)) { console.error('ASOF inválido:', ASOF); process.exit(1); }

const TF_INTERVAL = { '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };
const TF_LIMIT     = { '1h': 168,  '4h': 180,  '1D': 90,   '1W': 52  };

// ─── Candles históricos, los 4 TFs, cerrados a `asofMs` (sin la vela a medio formar) ──────
async function fetchHistoricalCandlesAllTf(coin, atMs) {
  const out = {};
  for (const tf of Object.keys(TF_INTERVAL)) {
    const durMs = TF_DURATION_MS[tf];
    const limit = TF_LIMIT[tf];
    const startTime = atMs - (limit + 5) * durMs;
    const raw = await fetchHistoricalKlines(coin, TF_INTERVAL[tf], startTime, atMs, limit + 5);
    const closed = raw.filter((c) => c.t + durMs <= atMs);
    out[tf] = closed.slice(-limit);
  }
  return out;
}

function computePriceAndChange(candles1h, atMs) {
  if (!candles1h?.length) return null;
  const last = candles1h.at(-1);
  const target = last.t - 24 * 3600 * 1000;
  let ref = candles1h[0];
  for (const c of candles1h) if (c.t <= target) ref = c;
  const change_24h_pct = ref.close ? ((last.close - ref.close) / ref.close) * 100 : null;
  return {
    price: last.close,
    change_24h_pct: change_24h_pct != null ? parseFloat(change_24h_pct.toFixed(2)) : null,
    fetched_at: new Date(last.t).toISOString(),
  };
}

async function buildHistoricalBtcContext(coin, technical, atMs) {
  if (coin === 'BTC') {
    return { trend_1d: technical?.['1D']?.trend ?? null, trend_1w: technical?.['1W']?.trend ?? null, source: 'self' };
  }
  try {
    const btcCandles = await fetchHistoricalCandlesAllTf('BTC', atMs);
    const trend1d = btcCandles['1D']?.length ? computeIndicators(btcCandles['1D'], '1D')?.trend ?? null : null;
    const trend1w = btcCandles['1W']?.length ? computeIndicators(btcCandles['1W'], '1W')?.trend ?? null : null;
    if (trend1d == null && trend1w == null) return null;
    return { trend_1d: trend1d, trend_1w: trend1w, source: 'btc_klines_historical' };
  } catch (err) {
    console.warn('buildHistoricalBtcContext falló:', err.message);
    return null;
  }
}

// ─── Derivados históricos (Coinalyze) — clasificadores REPLICADOS de coinalyzeService.js ──
const coinalyzeClient = axios.create({
  baseURL: 'https://api.coinalyze.net/v1',
  timeout: 10000,
  params: { api_key: env.coinalyzeApiKey },
});

async function fetchHistoricalFunding(coin, atSec) {
  const symbol = COINALYZE_SYMBOLS[coin];
  if (!symbol || !env.hasDerivativesData) return null;
  try {
    const from = atSec - 48 * 3600;
    const { data } = await coinalyzeClient.get('/funding-rate-history', {
      params: { symbols: symbol, interval: '6hour', from, to: atSec },
    });
    const hist = data?.[0]?.history ?? [];
    if (!hist.length) return null;
    const latest = hist.at(-1);
    const ratePct = latest.c;
    const diff = hist.at(-1).c - hist[0].o;
    const trend = hist.length >= 2 ? (diff > 0.02 ? 'rising' : diff < -0.02 ? 'falling' : 'stable') : null;
    return {
      rate_pct: parseFloat(ratePct.toFixed(6)),
      annualized_pct: parseFloat((ratePct * 3 * 365).toFixed(2)),
      trend,
      severity: ratePct >= 0
        ? (ratePct > 0.5 ? 'extreme' : ratePct > 0.2 ? 'high' : ratePct > 0.05 ? 'elevated' : 'normal')
        : 'normal',
      severity_negative: ratePct < 0
        ? (ratePct < -0.5 ? 'extreme_short_overload' : ratePct < -0.2 ? 'high_short_overload' : ratePct < -0.05 ? 'elevated_short_overload' : null)
        : null,
      signal: ratePct > 0.1 ? 'longs_overloaded' : ratePct < -0.05 ? 'shorts_overloaded' : 'balanced',
      predicted_rate_pct: null, // no aplica a un instante pasado
      data_timestamp_utc: new Date(latest.t * 1000).toISOString(),
    };
  } catch (err) {
    console.warn('fetchHistoricalFunding falló:', err.message);
    return null;
  }
}

async function fetchHistoricalOI(coin, atSec) {
  const symbol = COINALYZE_SYMBOLS[coin];
  if (!symbol || !env.hasDerivativesData) return null;
  try {
    const from = atSec - 7 * 24 * 3600;
    const { data } = await coinalyzeClient.get('/open-interest-history', {
      params: { symbols: symbol, interval: '4hour', from, to: atSec },
    });
    const hist = data?.[0]?.history ?? [];
    if (!hist.length) return null;
    const current = hist.at(-1).c;
    const last24h = hist.slice(-6);
    let change_24h_pct = null, signal = 'stable';
    if (last24h.length >= 2) {
      const oldest = last24h[0].o;
      if (oldest) {
        change_24h_pct = parseFloat(((current - oldest) / Math.abs(oldest) * 100).toFixed(2));
        signal = change_24h_pct > 5 ? 'increasing_fast'
          : change_24h_pct > 1   ? 'increasing'
          : change_24h_pct < -5  ? 'decreasing_fast'
          : change_24h_pct < -1  ? 'decreasing'
          : 'stable';
      }
    }
    return {
      value_coins: current, unit: 'base_coin', change_24h_pct, signal,
      data_timestamp_utc: new Date(hist.at(-1).t * 1000).toISOString(),
    };
  } catch (err) {
    console.warn('fetchHistoricalOI falló:', err.message);
    return null;
  }
}

async function fetchHistoricalLSR(coin, atSec) {
  const symbol = COINALYZE_SYMBOLS[coin];
  if (!symbol || !env.hasDerivativesData) return null;
  try {
    const from = atSec - 7 * 24 * 3600;
    const { data } = await coinalyzeClient.get('/long-short-ratio-history', {
      params: { symbols: symbol, interval: '1hour', from, to: atSec },
    });
    const hist = data?.[0]?.history ?? [];
    if (!hist.length) return null;
    const latest = hist.at(-1);
    const longPct = parseFloat((latest.l ?? 50).toFixed(1));
    const shortPct = parseFloat((latest.s ?? 50).toFixed(1));
    // Simplificado: corte absoluto 60/40 (sin el bucket por percentil de 7d de producción,
    // que exige `bucketByPercentile` — el prompt ya avisa que este campo es color menor).
    const signal = longPct > 60 ? 'longs_dominant_contrarian_bear'
      : longPct < 40 ? 'shorts_dominant_contrarian_bull'
      : 'balanced';
    return {
      long_pct: longPct, short_pct: shortPct, signal, source: 'coinalyze',
      data_timestamp_utc: new Date(latest.t * 1000).toISOString(),
    };
  } catch (err) {
    console.warn('fetchHistoricalLSR falló:', err.message);
    return null;
  }
}

async function fetchHistoricalLiquidations(coin, atSec) {
  const symbol = COINALYZE_SYMBOLS[coin];
  if (!symbol || !env.hasDerivativesData) return null;
  try {
    const from = atSec - 30 * 24 * 3600;
    const { data } = await coinalyzeClient.get('/liquidation-history', {
      params: { symbols: symbol, interval: '1hour', from, to: atSec },
    });
    const hist = data?.[0]?.history ?? [];
    if (!hist.length) return null;
    const last24h = hist.slice(-24);
    const longs_coins  = parseFloat(last24h.reduce((a, h) => a + (h.l ?? 0), 0).toFixed(4));
    const shorts_coins = parseFloat(last24h.reduce((a, h) => a + (h.s ?? 0), 0).toFixed(4));
    const total = longs_coins + shorts_coins;
    const rolling24h = [];
    for (let i = 24; i <= hist.length; i++) {
      const w = hist.slice(i - 24, i);
      const s = w.reduce((a, h) => a + (h.l ?? 0) + (h.s ?? 0), 0);
      if (s > 0) rolling24h.push(s);
    }
    const sorted = rolling24h.slice().sort((a, b) => a - b);
    const median30d = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      longs_coins, shorts_coins, total_coins: total, unit: 'base_coin',
      skew: total > 0 ? parseFloat(((shorts_coins - longs_coins) / total).toFixed(4)) : null,
      median_24h_total_30d: median30d,
      magnitude_vs_median_30d: median30d > 0 ? parseFloat((total / median30d).toFixed(2)) : null,
      median_window_points: rolling24h.length,
      data_timestamp_utc: new Date(last24h.at(-1).t * 1000).toISOString(),
    };
  } catch (err) {
    console.warn('fetchHistoricalLiquidations falló:', err.message);
    return null;
  }
}

// ─── Fear & Greed histórico real (alternative.me sí sirve el pasado directamente) ─────────
async function fetchHistoricalFearGreedSeries(atMs) {
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/?limit=150', { timeout: 10000 });
    const atSec = Math.floor(atMs / 1000);
    const relevant = (data?.data ?? [])
      .filter((e) => parseInt(e.timestamp, 10) <= atSec)
      .sort((a, b) => parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10));
    return relevant.slice(-30).map((e) => ({
      date: new Date(parseInt(e.timestamp, 10) * 1000).toISOString().split('T')[0],
      value: parseInt(e.value, 10),
      classification: e.value_classification,
    }));
  } catch (err) {
    console.warn('fetchHistoricalFearGreedSeries falló:', err.message);
    return [];
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(96));
  console.log(`SIMULACIÓN HISTÓRICA — ${COIN} · fase "${LABEL}" · como si fuera ${new Date(asofMs).toISOString()} · modelo ${MODEL}`);
  console.log('═'.repeat(96));

  console.log('→ candles (4 TFs, Binance histórico)...');
  const candles = await fetchHistoricalCandlesAllTf(COIN, asofMs);
  for (const tf of Object.keys(candles)) console.log(`   ${tf}: ${candles[tf].length} velas, última cierra ${new Date(candles[tf].at(-1)?.t + TF_DURATION_MS[tf]).toISOString()}`);

  const price = computePriceAndChange(candles['1h'], asofMs);
  console.log(`→ precio reconstruido: $${price?.price} (${price?.change_24h_pct}% 24h)`);

  console.log('→ derivados históricos (Coinalyze)...');
  const [funding_rate, open_interest, long_short_ratio, liquidations] = await Promise.all([
    fetchHistoricalFunding(COIN, asofSec),
    fetchHistoricalOI(COIN, asofSec),
    fetchHistoricalLSR(COIN, asofSec),
    fetchHistoricalLiquidations(COIN, asofSec),
  ]);
  console.log(`   funding=${funding_rate?.rate_pct ?? 'null'}% severity=${funding_rate?.severity ?? '—'}`);
  console.log(`   OI change24h=${open_interest?.change_24h_pct ?? 'null'}% signal=${open_interest?.signal ?? '—'}`);
  console.log(`   L/S long%=${long_short_ratio?.long_pct ?? 'null'}`);
  console.log(`   liq skew=${liquidations?.skew ?? 'null'} magnitud×mediana=${liquidations?.magnitude_vs_median_30d ?? 'null'}`);

  console.log('→ Fear & Greed histórico (alternative.me)...');
  const fgSeries = await fetchHistoricalFearGreedSeries(asofMs);
  const fgLatest = fgSeries.at(-1) ?? null;
  const fg7dAgo = fgSeries.length >= 8 ? fgSeries.at(-8) : fgSeries[0];
  const fearGreed = fgLatest ? {
    value: fgLatest.value,
    classification: fgLatest.classification,
    trend_1d: null, // se poda igual en producción (colisión con btc_context.trend_1d)
    trend_7d_change: fg7dAgo ? fgLatest.value - fg7dAgo.value : null,
  } : null;
  console.log(`   F&G=${fearGreed?.value ?? 'null'} (${fearGreed?.classification ?? '—'})`);

  console.log('→ indicadores técnicos + SMC + Volume Profile (computeTechnicalByTf, función real)...');
  const technical = computeTechnicalByTf(candles, price?.price ?? null);

  console.log('→ contexto BTC (trend_1d/1w histórico)...');
  const btcContext = await buildHistoricalBtcContext(COIN, technical, asofMs);
  console.log(`   btc_context: ${JSON.stringify(btcContext)}`);

  const sources = {
    candles, price, fearGreed,
    derivatives: { funding_rate, open_interest, long_short_ratio, liquidations },
    globalMarket: null, coinMarket: null, orderBook: null,
    liquidationClusters: null, onchain: null, etfFlows: null, macro: null, volatility: null,
  };
  const histories = {
    fear_greed: fgSeries, funding_rate: [], open_interest: [], long_short_ratio: [], liquidations: [],
  };

  console.log('→ ensamblando contexto (assembleAnalyzeContext, función real: risk_geometry + derivatives_score incluidos)...');
  const context = assembleAnalyzeContext({ coin: COIN, primaryTf: PRIMARY_TF, sources, technical, btcContext, histories });
  console.log(`   risk_geometry.long.rr=${context.risk_geometry?.long?.rr} target_reachability=${context.risk_geometry?.long?.target_reachability_pct}%`);
  console.log(`   derivatives_score.basis=${JSON.stringify(context.derivatives_score?.basis)}`);

  console.log(`→ llamando a Anthropic (${MODEL})... esto tarda ~40-60s y tiene coste real`);
  const { narrative, executive_summary, ai_metadata } = await analyzeMarket(context, MODEL);

  console.log('\n' + '─'.repeat(96));
  console.log(`RESULTADO — ${COIN} · ${LABEL} · ${new Date(asofMs).toISOString().split('T')[0]} (movimiento real de la ventana: ver contexto)`);
  console.log('─'.repeat(96));
  console.log('\nEXECUTIVE SUMMARY:\n' + executive_summary);
  for (const [section, text] of Object.entries(narrative)) {
    console.log(`\n[${section}]\n${text}`);
  }
  console.log('\n' + '─'.repeat(96));
  console.log(`risk_geometry: long rr=${context.risk_geometry?.long?.rr} short rr=${context.risk_geometry?.short?.rr} (deben coincidir — simetría)`);
  console.log(`ai_metadata: ${JSON.stringify(ai_metadata)}`);

  const outFile = `/tmp/cryptex-sim-${COIN}-${LABEL}-${asofSec}.json`;
  writeFileSync(outFile, JSON.stringify({
    coin: COIN, label: LABEL, asof: new Date(asofMs).toISOString(), model: MODEL,
    price, narrative, executive_summary, ai_metadata, risk_geometry: context.risk_geometry,
    derivatives_score: context.derivatives_score,
    degraded_blocks: ['order_book', 'liquidation_clusters', 'onchain', 'etf_flows', 'macro', 'volatility', 'global_market', 'coin_market'],
  }, null, 2));
  console.log(`\n✓ Guardado en ${outFile}`);
}

main().catch((err) => { console.error('FALLÓ:', err); process.exit(1); });
