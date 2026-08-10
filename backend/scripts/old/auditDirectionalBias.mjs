#!/usr/bin/env node
/**
 * auditDirectionalBias.mjs — FASE 0: ¿existe una señal direccional determinista?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LA PREGUNTA, Y EL CRITERIO ESCRITO ANTES DE EJECUTAR
 *
 * ¿Un dictamen direccional continuo (`bias`), calculado por el backend sobre datos
 * históricos, acierta más que (a) elegir dirección al AZAR y (b) seguir la DERIVA reciente?
 *
 * Si no bate a la deriva, el `bias` es una forma cara de escribir momentum y el rediseño
 * hacia un producto direccional no se hace. Espec. completa y criterios de decisión:
 * `doc/FASE_0_BIAS_ESPECIFICACION.md`.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * CUATRO BRAZOS, UN SOLO ENSAYO POR ANCLA, EL MISMO CONJUNTO DE ANCLAS
 *
 *   A · AZAR     dirección por HASH del instante (ver `hashDir`: la paridad del índice NO
 *                vale — se aliasa con el espaciado de la cadena disjunta)
 *   B · BIAS     dirección = signo(bias)
 *   C · DERIVA   dirección = signo(cambio de precio 24h)   ← el rival de verdad
 *   D · ORÁCULO  la mejor dirección posible                ← techo del juego
 *
 * ⚠️ POR QUÉ UN SOLO ENSAYO POR ANCLA. El ancla publicada del 26,5 % sale de
 * `auditPathWinRate.mjs:232`, que hace `wilsonInterval(up.win + down.win, dU + dD)`: mete
 * CADA ancla dos veces (como `Comprar` y como `Vender`) en un solo denominador, y además
 * no corrige el solape temporal. Aquí cada ancla aporta UN ensayo con UNA dirección, que es
 * un Bernoulli propio, y los IC salen de `disjointRate` sobre ventanas futuras que no se
 * tocan. El punto del azar se reporta ADEMÁS como mezcla exacta (sin ruido de muestreo)
 * para comprobar que ambas versiones coinciden.
 *
 * ⚠️ NUNCA CONTRA LA BASE GLOBAL. Cuando el bias habla está SELECCIONANDO anclas, así que
 * los cuatro brazos se calculan sobre EL MISMO subconjunto. Comparar un subconjunto contra
 * el 26,5 % global es el error que A8 corrigió al exigir comparar contra el COMPLEMENTO.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LOS DOS ATR — no son intercambiables (B1, tercera vez que muerde)
 *
 *   · BANDA de la rúbrica  → ATR de 180 velas (el de DECISIÓN, `indicatorService`)
 *   · BARRERAS del win-rate → ATR de 19 velas (`ATR_PERIOD+5`, el que reconstruye el
 *     outcome job y con el que se midió el 26,5 %)
 *
 * Mezclarlos invalidaría una de las dos constantes en silencio. Van nombrados aparte.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ ENTRA EN EL BIAS, Y QUÉ NO PUEDE ENTRAR
 *
 *   derivatives  ✅ `computeDerivativesScore` — rúbrica medida (⚠️ IN-SAMPLE, ver abajo)
 *   volume       ⚠️ `expectedVolumeScore` — proxy conservador (se abstiene ante divergencia)
 *   execution    ✅ reproducible EXACTO: v8_0 lo dejó como 5 votos con umbrales explícitos
 *   structure    ❌ NO EXISTE como función determinista (en el prompt es prosa)
 *
 * ⚠️ `computeTrend` NO se usa como proxy de estructura: contiene SuperTrend + RSI + MACD +
 * WaveTrend + StochRSI (4 de los 5 votos de Execution) y volumeDelta, así que sería TRIPLE
 * conteo. El propio prompt lo prohíbe ("NO lo re-puntúes aquí").
 *
 * ⚠️ EL SUMANDO DE DERIVADOS ES IN-SAMPLE Y NO PUEDE DEJAR DE SERLO. La rúbrica se calibró
 * el 2026-07-29 sobre estos mismos 90 días, y Coinalyze no sirve más: no hay contra-periodo
 * posible. Por eso se mide TAMBIÉN `bias_klines` (volumen + ejecución), que sí admite
 * `OFFSET_DAYS`. Si sólo gana el completo y sólo en su ventana de ajuste, ésa es la firma
 * del sobreajuste y el veredicto es NO-GO.
 *
 * SOLO LECTURA: no toca BBDD, ni producción, ni la ruta de decisión. Importa las funciones
 * REALES del backend — no reimplementa ninguna regla salvo la rúbrica de Execution, que
 * vive en el prompt y no tiene función propia (marcada como tal).
 *
 * Uso (desde backend/):
 *   node scripts/auditDirectionalBias.mjs
 *   COINS=SOL node scripts/auditDirectionalBias.mjs
 *   OFFSET_DAYS=270 node scripts/auditDirectionalBias.mjs   # contra-periodo (sólo klines)
 *   NO_LIQ_GUARD=1 node scripts/auditDirectionalBias.mjs     # 90d, cascada abstenida
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  calculateATR, calculateCVD, calculateRSI, calculateMACD,
  calculateStochRSI, calculateWaveTrend, calculateSuperTrend,
} from '../src/utils/indicators.js';
import { computeDerivativesScore } from '../src/utils/derivativesScore.js';
import { expectedVolumeScore } from '../src/utils/expectedScores.js';
import { computeFirstPassage } from '../src/utils/pathMetrics.js';
import { classifyOpportunity, classifyPathOutcome, opportunityParamsFor } from '../src/utils/stats.js';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 90);
const OFFSET_DAYS = Number(process.env.OFFSET_DAYS ?? 0);
const NO_LIQ_GUARD = process.env.NO_LIQ_GUARD === '1';
const PRIMARY_TF = '4h';
const WIN_4H = 180;              // TF_LIMIT['4h'] — coingeckoService.js
const ATR_PERIOD = 14;
const ATR_OUTCOME_SLICE = ATR_PERIOD + 5;   // 19 velas — outcomeService.js
const LIQ_WINDOW_H = 30 * 24;
const HORIZON_H = 24;            // el que discrimina (7d satura al 67-69 %)
const H4_SEC = 4 * 3600;
const HOUR_MS = 3600 * 1000;
const STRIDE = 6;                // arranques de cadena que recorre `disjointRate`

const here = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = readFileSync(path.join(here, '../../.env'), 'utf8')
  .match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();

const USE_DERIVATIVES = OFFSET_DAYS === 0;
if (USE_DERIVATIVES && !API_KEY) {
  console.error('Falta COINALYZE_API_KEY en .env (o usa OFFSET_DAYS>0 para el modo klines).');
  process.exit(1);
}

const pct = (x, n) => (n ? (x / n * 100) : null);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

// ─── Fetch ───────────────────────────────────────────────────────────────────

async function klinesRange(coin, interval, startMs, endMs) {
  const out = [];
  let start = startMs;
  for (let guard = 0; guard < 30; guard++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=${interval}&startTime=${start}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${coin}/${interval}: HTTP ${res.status}`);
    const batch = (await res.json()).map((r) => ({
      t: Math.floor(r[0] / 1000), tMs: r[0],
      open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
      taker_buy_base: +r[9],           // sin él el CVD cae al heurístico y CAMBIA DE SIGNO
    }));
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 1000) break;
    start = batch.at(-1).tMs + 1;
  }
  return out;
}

async function coinalyze(coin, endpoint, interval, endSec) {
  const from = endSec - DAYS * 86400;
  const url = `https://api.coinalyze.net/v1/${endpoint}?symbols=${coin}USDT_PERP.A`
    + `&interval=${interval}&from=${from}&to=${endSec}&api_key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.log(`  (${endpoint}: HTTP ${r.status})`); return []; }
  return (await r.json())?.[0]?.history ?? [];
}

// ─── Rúbricas deterministas ──────────────────────────────────────────────────

/** severity / severity_negative — igual que coinalyzeService.js:85-91. */
function fundingSeverity(ratePct) {
  if (!Number.isFinite(ratePct)) return null;
  return {
    severity: ratePct >= 0
      ? (ratePct > 0.5 ? 'extreme' : ratePct > 0.2 ? 'high' : ratePct > 0.05 ? 'elevated' : 'normal')
      : 'normal',
    severity_negative: ratePct < 0
      ? (ratePct < -0.5 ? 'extreme_short_overload' : ratePct < -0.2 ? 'high_short_overload'
        : ratePct < -0.05 ? 'elevated_short_overload' : null)
      : null,
  };
}

/** Ventana de liquidaciones de 30d terminada en `endIdx` — igual que auditGateConjunction. */
function liquidationsAt(liqHist, endIdx) {
  const startIdx = endIdx - LIQ_WINDOW_H;
  if (startIdx < 0) return null;
  const hist = liqHist.slice(startIdx, endIdx);
  const last24h = hist.slice(-24);
  if (last24h.length < 24) return null;
  const longs = last24h.reduce((a, h) => a + (h.l ?? 0), 0);
  const shorts = last24h.reduce((a, h) => a + (h.s ?? 0), 0);
  const total = longs + shorts;
  const rolling = [];
  for (let i = 24; i <= hist.length; i++) {
    const s = hist.slice(i - 24, i).reduce((a, h) => a + (h.l ?? 0) + (h.s ?? 0), 0);
    if (s > 0) rolling.push(s);
  }
  const sorted = rolling.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  return {
    skew: total > 0 ? parseFloat(((shorts - longs) / total).toFixed(4)) : null,
    magnitude_vs_median_30d: median > 0 ? parseFloat((total / median).toFixed(2)) : null,
    median_window_points: rolling.length,
  };
}

/**
 * EXECUTION SCORE — única regla REIMPLEMENTADA aquí, porque vive en el prompt (§D) y no
 * tiene función propia en el backend. Conteo de votos con umbrales explícitos (v8_0).
 *
 * ⚠️ SUS CONSTANTES NUNCA SE HAN MEDIDO contra outcomes (RSI 55/45, la tabla suma→score).
 * Escritas a mano en v8_0 — misma clase que la regla del proyecto prohíbe. Por eso el bias
 * se reporta también SIN este sumando (`bias_noexec`): si sólo funciona con Execution
 * dentro, el hallazgo no es "hay señal" sino "hay que medir Execution".
 *
 * SIMPLIFICACIÓN DECLARADA: el matiz del prompt sobre RSI en extremo ("si está en extremo,
 * el voto lo da el régimen") es prosa ambigua; la regla base >55/<45 ya trata >70 como
 * continuación alcista, que es lo que ese matiz pide. Se implementa la regla base.
 */
function executionScore(w4h) {
  const closes = w4h.map((c) => c.close);
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const st = calculateSuperTrend(w4h);
  const stoch = calculateStochRSI(closes);
  const wt = calculateWaveTrend(w4h);
  if (!Number.isFinite(rsi) || !macd || !st || !stoch || !wt) return null;

  const votes = [
    rsi > 55 ? 1 : rsi < 45 ? -1 : 0,
    macd.momentum_state === 'bullish_accelerating' ? 1
      : macd.momentum_state === 'bearish_accelerating' ? -1 : 0,
    st.trend === 'UP' ? 1 : -1,
    stoch.signal === 'oversold_cross_up' ? 1
      : stoch.signal === 'overbought_cross_down' ? -1 : 0,
    wt.signal === 'oversold_cross_up' ? 1
      : wt.signal === 'overbought_cross_down' ? -1 : 0,
  ];
  const sum = votes.reduce((a, b) => a + b, 0);
  return sum >= 4 ? 2 : sum >= 2 ? 1 : sum >= -1 ? 0 : sum >= -3 ? -1 : -2;
}

// ─── Construcción de anclas ──────────────────────────────────────────────────

async function buildAnchors(coin) {
  const endMs = Date.now() - OFFSET_DAYS * 24 * HOUR_MS;
  const endSec = Math.floor(endMs / 1000);
  // Margen para el burn-in de la ventana de 180 velas 4h (=30 días) + el horizonte.
  const startMs = endMs - (DAYS + 35) * 24 * HOUR_MS;

  const [k4h, k1h, oiHist, liqHist, frHist] = await Promise.all([
    klinesRange(coin, '4h', startMs, endMs),
    klinesRange(coin, '1h', startMs, endMs),
    USE_DERIVATIVES ? coinalyze(coin, 'open-interest-history', '4hour', endSec) : [],
    USE_DERIVATIVES ? coinalyze(coin, 'liquidation-history', '1hour', endSec) : [],
    USE_DERIVATIVES ? coinalyze(coin, 'funding-rate-history', '4hour', endSec) : [],
  ]);
  if (k4h.length < WIN_4H + 10 || !k1h.length) return null;

  const oiByT = new Map(oiHist.map((h, i) => [h.t, i]));
  const frByT = new Map(frHist.map((h) => [h.t, h.c]));
  const liqEndIdxAt = (closeSec) => {
    let lo = 0, hi = liqHist.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (liqHist[m].t < closeSec) lo = m + 1; else hi = m; }
    return lo;
  };
  const h1Times = k1h.map((c) => c.tMs);
  const idxFrom = (tMs) => {
    let lo = 0, hi = h1Times.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (h1Times[m] < tMs) lo = m + 1; else hi = m; }
    return lo;
  };
  const lastH1 = k1h.at(-1).tMs;

  const rows = [];
  let skippedLiq = 0, skippedOi = 0;

  for (let i = WIN_4H - 1; i < k4h.length; i++) {
    const t = k4h[i].t;
    const closeMs = (t + H4_SEC) * 1000;              // el análisis ocurre AL CIERRE
    if (lastH1 < closeMs + HORIZON_H * HOUR_MS) continue;   // sin recorrido completo → fuera

    const w4h = k4h.slice(i - WIN_4H + 1, i + 1);
    const currentPrice = w4h.at(-1).close;
    if (!(currentPrice > 0)) continue;

    // ── ATR de DECISIÓN (180 velas) — alimenta la banda de la rúbrica ──
    const atrDecision = calculateATR(w4h);
    if (!Number.isFinite(atrDecision)) continue;
    const atrPct__decision_180 = parseFloat((atrDecision / currentPrice * 100).toFixed(2));

    // ── ATR de OUTCOME (19 velas) — alimenta las BARRERAS del win-rate ──
    const atrOut = calculateATR(k4h.slice(Math.max(0, i - ATR_OUTCOME_SLICE), i + 1), ATR_PERIOD);
    if (!Number.isFinite(atrOut) || atrOut <= 0) continue;
    const atrPct__outcome_19 = (atrOut / currentPrice) * 100;

    // ── Cambio de precio 24h: cierre a cierre, referencia i-5 (ver auditGateConjunction) ──
    const pxPrev = k4h[i - 5]?.close;
    if (!(pxPrev > 0)) continue;
    const priceChange24hPct = ((currentPrice - pxPrev) / pxPrev) * 100;

    // ── Sumandos ──
    const cvd4h = calculateCVD(w4h);
    const volume = expectedVolumeScore(cvd4h).score;
    const execution = executionScore(w4h);
    if (execution == null) continue;

    let derivatives = 0, cell = 'n/a';
    if (USE_DERIVATIVES) {
      const oiIdx = oiByT.get(t);
      if (oiIdx == null || oiIdx < 5) { skippedOi++; continue; }
      const oiOpen = oiHist[oiIdx - 5].o;
      const oiClose = oiHist[oiIdx].c;
      if (!(Math.abs(oiOpen) > 0)) { skippedOi++; continue; }
      const oiChange = parseFloat(((oiClose - oiOpen) / Math.abs(oiOpen) * 100).toFixed(2));

      let liq = liquidationsAt(liqHist, liqEndIdxAt(t + H4_SEC));
      if (!liq) {
        if (!NO_LIQ_GUARD) { skippedLiq++; continue; }
        liq = {};
      }
      const d = computeDerivativesScore({
        oiChange24hPct: oiChange, priceChange24hPct,
        atrPct: atrPct__decision_180, primaryTf: PRIMARY_TF,
        liquidations: liq, funding: fundingSeverity(frByT.get(t)),
      });
      derivatives = d.score;
      cell = d.components.oi_price_cell;
    }

    // ── Recorrido futuro, normalizado con el ATR de OUTCOME ──
    const from = idxFrom(closeMs);
    // ⚠️ `computeFirstPassage` compara `c.t` contra `tMs`, o sea que espera MILISEGUNDOS.
    // Las velas de este script llevan `t` en SEGUNDOS (lo exige el cruce con Coinalyze), así
    // que aquí se reproyecta. Sin esto `windowCandles` filtra TODO y no sale ni un ancla.
    const path = k1h.slice(from, from + 7 * 24 + 2).map((c) => ({ ...c, t: c.tMs }));
    if (!path.length) continue;
    const fp = computeFirstPassage(path, currentPrice, atrPct__outcome_19, closeMs, 7 * 24 * HOUR_MS);
    if (!fp) continue;

    rows.push({
      t: t + H4_SEC,                       // en SEGUNDOS: lo que consume `disjointRate`
      row: { path_first_passage: fp },
      derivatives, volume, execution, cell,
      priceChange24hPct,
      atrPct__decision_180, atrPct__outcome_19,
    });
  }
  return { rows, skippedLiq, skippedOi, k4h: k4h.length };
}

// ─── Evaluación ──────────────────────────────────────────────────────────────

const OPTS = { horizonH: HORIZON_H, now: null };   // `now: null` = historia cerrada, SIN censura
const outcomeFor = (r, dir) => classifyPathOutcome(dir === 1 ? 'Comprar' : 'Vender', r.row, OPTS);

/** Dirección del oráculo: la que gana si alguna gana; si ninguna, da igual (será loss). */
function oracleDir(r) {
  return outcomeFor(r, 1) === 'win' ? 1 : outcomeFor(r, -1) === 'win' ? -1 : 1;
}

/**
 * Un brazo = una función ancla→dirección. Un solo ensayo por ancla; `flat`/`pending` quedan
 * fuera del denominador (mismo criterio para los cuatro, así que no sesga la comparación).
 */
function arm(rows, dirFn) {
  const sel = [];
  for (const r of rows) {
    const dir = dirFn(r);
    if (!dir) continue;
    const o = outcomeFor(r, dir);
    if (o !== 'win' && o !== 'loss') continue;
    sel.push({ t: r.t, win: o === 'win' });
  }
  return sel;
}

const rate = (sel) => disjointRate(sel, (x) => x.win, { horizonSec: HORIZON_H * 3600, stride: STRIDE });

/**
 * Dirección "al azar" por HASH del timestamp, no por paridad del índice.
 *
 * ⚠️ POR QUÉ NO LA PARIDAD (bug real, cazado por el control de la mezcla exacta). La cadena
 * disjunta toma 1 de cada 6 anclas (24h ÷ 4h), así que una alternancia por índice degenera
 * en dirección CONSTANTE dentro de la cadena: el brazo del azar daba 8,5 % contra el 24,1 %
 * de la mezcla exacta. Es el mismo BLOQUEO DE FASE que `auditVolatilityState` documentó al
 * muestrear 1h con paso de 168 velas (= 7 días exactos → 85,6 % `squeeze`).
 *
 * Un hash del instante no puede alinearse con el espaciado de la cadena, y es determinista:
 * dos ejecuciones dan el mismo resultado, sin ruido de RNG.
 */
function hashDir(t) {
  let x = (t / 3600) | 0;
  x = Math.imul(x ^ (x >>> 16), 2246822507);
  x = Math.imul(x ^ (x >>> 13), 3266489909);
  return ((x ^ (x >>> 16)) & 1) ? 1 : -1;
}

const BIAS = {
  bias_full:   (r) => r.derivatives + r.volume + r.execution,
  bias_klines: (r) => r.volume + r.execution,
  bias_noexec: (r) => r.derivatives + r.volume,
};

// ─── Reporte ─────────────────────────────────────────────────────────────────

console.log('═'.repeat(88));
console.log('FASE 0 — ¿bate un bias determinista al AZAR y a la DERIVA?');
console.log(`TF ${PRIMARY_TF} · ${DAYS} d · offset ${OFFSET_DAYS} d · horizonte ${HORIZON_H}h`
  + ` · barreras ${opportunityParamsFor(HORIZON_H).targetK}×/${opportunityParamsFor(HORIZON_H).adverseK}×`
  + `${NO_LIQ_GUARD ? ' · NO_LIQ_GUARD' : ''}`);
console.log(USE_DERIVATIVES
  ? '⚠️  El sumando de derivados es IN-SAMPLE (rúbrica calibrada sobre estos mismos 90 d).'
  : '▶  MODO KLINES (contra-periodo): sin derivados. Sólo volumen + ejecución.');
console.log('CRITERIO, escrito antes de ejecutar: GO exige que el IC del bias NO SOLAPE con el');
console.log('del azar Y que su punto SUPERE al de la deriva, replicando en las 3 monedas.');
console.log('═'.repeat(88));

const pooled = [];
for (const coin of COINS) {
  let data;
  try { data = await buildAnchors(coin); } catch (e) { console.log(`\n${coin}: ${e.message}`); continue; }
  if (!data || !data.rows.length) { console.log(`\n${coin}: sin anclas utilizables`); continue; }
  const { rows } = data;
  pooled.push(...rows);

  console.log(`\n${'─'.repeat(88)}\n${coin} · ${rows.length} anclas evaluables`
    + ` (descartadas: ${data.skippedLiq} por mediana de liq. incompleta, ${data.skippedOi} por OI)`);

  // ── K1 · ¿HABLA el bias? Rama muerta se comprueba ANTES de mirar ningún win-rate ──
  const b = rows.map(BIAS.bias_full);
  const hist = {};
  for (const v of b) hist[Math.abs(v)] = (hist[Math.abs(v)] ?? 0) + 1;
  const speaks = b.filter((v) => Math.abs(v) >= 1).length;
  console.log(`  K1 ¿habla?  |bias|>=1 en ${f1(pct(speaks, b.length))}%`
    + `  · reparto |bias|: ${Object.entries(hist).sort().map(([k, v]) => `${k}:${f1(pct(v, b.length))}%`).join(' ')}`
    + (speaks / b.length < 0.05 ? '   ⚠️ RAMA MUERTA' : ''));

  // ── K2 · balance direccional (un bias inclinado gana por deriva, no por señal) ──
  const up = b.filter((v) => v >= 1).length, dn = b.filter((v) => v <= -1).length;
  console.log(`  K2 balance  alcista ${f1(pct(up, b.length))}% · bajista ${f1(pct(dn, b.length))}%`
    + (up + dn > 0 && Math.min(up, dn) / (up + dn) < 0.25 ? '   ⚠️ MUY DESEQUILIBRADO' : ''));

  // ── K3 · identidad A1: wins(C) + wins(V) == anclas con oportunidad ofrecida ──
  let wC = 0, wV = 0, off = 0;
  for (const r of rows) {
    if (outcomeFor(r, 1) === 'win') wC++;
    if (outcomeFor(r, -1) === 'win') wV++;
    if (classifyOpportunity(r.row, OPTS).offered) off++;
  }
  console.log(`  K3 identidad wins(C)+wins(V)=${wC + wV} vs offered=${off}`
    + `  ${wC + wV === off ? '✅ EXACTO' : `❌ DESCUADRE ${wC + wV - off}`}`);

  // ── Los cuatro brazos, sobre el MISMO subconjunto (|bias_full| >= 1) ──
  const spoken = rows.filter((r) => Math.abs(BIAS.bias_full(r)) >= 1);
  if (spoken.length < 10) { console.log('  (bias habla en <10 anclas: sin brazos)'); continue; }

  // Azar: dirección por HASH del instante → Bernoulli propio, inmune al bloqueo de fase.
  const azar = arm(spoken, (r) => hashDir(r.t));
  const bias = arm(spoken, (r) => Math.sign(BIAS.bias_full(r)));
  const deriva = arm(spoken, (r) => Math.sign(r.priceChange24hPct) || 1);
  const oraculo = arm(spoken, oracleDir);

  // Mezcla exacta del azar (sin ruido de muestreo), como control del brazo A.
  let mixW = 0, mixN = 0;
  for (const r of spoken) {
    for (const d of [1, -1]) {
      const o = outcomeFor(r, d);
      if (o === 'win' || o === 'loss') { mixN++; if (o === 'win') mixW++; }
    }
  }

  console.log(`  K6 cobertura (mismas anclas): azar ${azar.length} · bias ${bias.length}`
    + ` · deriva ${deriva.length} · oráculo ${oraculo.length}`);
  const show = (label, sel) => {
    const w = rate(sel);
    if (!w) { console.log(`     ${label} sin cadena disjunta utilizable`); return null; }
    console.log(`     ${label} ${String(f1(w.point)).padStart(5)}%  [${f1(w.low)}–${f1(w.high)}]`
      + `  n_ef=${String(w.n_eff).padStart(3)}  arranques ${f1(w.spread?.[0])}–${f1(w.spread?.[1])}`);
    return w;
  };
  console.log(`  ── brazos sobre ${spoken.length} anclas donde el bias habla ──`);
  const wA = show('A azar   ', azar);
  const wB = show('B BIAS   ', bias);
  const wC2 = show('C deriva ', deriva);
  const wD = show('D oráculo', oraculo);
  console.log(`     (control: mezcla exacta del azar = ${f1(pct(mixW, mixN))}% sobre ${mixN} ensayos)`);

  if (wA && wB) {
    const v = verdictCI(wB, wA);
    const batesDeriva = wC2 && wB.point > wC2.point;
    console.log(`  VEREDICTO ${coin}: bias vs azar → ${v.separated ? `SEPARA (${v.side})` : 'SOLAPA'}`
      + ` · bias vs deriva → ${batesDeriva ? 'supera' : 'NO supera'}`
      + `${v.separated && batesDeriva ? '   ✅' : '   ❌'}`);
  }

  // ── Monotonía: |bias| alto debe acertar más que |bias| bajo ──
  const mono = [];
  for (const lvl of [1, 2, 3]) {
    const s = rows.filter((r) => Math.abs(BIAS.bias_full(r)) === lvl);
    if (s.length < 10) { mono.push(`|${lvl}|: n<10`); continue; }
    const w = rate(arm(s, (r) => Math.sign(BIAS.bias_full(r))));
    mono.push(`|${lvl}|: ${w ? `${f1(w.point)}% (n_ef ${w.n_eff})` : '—'}`);
  }
  console.log(`  MONOTONÍA  ${mono.join(' · ')}`);

  // ── Variantes (¿sobrevive sin derivados? ¿sin ejecución?) ──
  for (const [name, fn] of Object.entries(BIAS)) {
    if (name === 'bias_full') continue;
    const s = rows.filter((r) => Math.abs(fn(r)) >= 1);
    if (s.length < 10) { console.log(`  ${name.padEnd(12)} n<10`); continue; }
    const w = rate(arm(s, (r) => Math.sign(fn(r))));
    console.log(`  ${name.padEnd(12)} ${w ? `${f1(w.point)}% [${f1(w.low)}–${f1(w.high)}] n_ef=${w.n_eff}` : '—'}`
      + `  (habla el ${f1(pct(s.length, rows.length))}%)`);
  }
}

// ─── Agregado (K8: la réplica en signo manda sobre el IC conjunto) ───────────
if (pooled.length) {
  console.log(`\n${'═'.repeat(88)}\nAGREGADO ${COINS.join('+')} · ${pooled.length} anclas`);
  console.log('⚠️  El IC conjunto es OPTIMISTA: las 3 monedas comparten el factor mercado.');
  console.log('    La réplica en SIGNO por moneda es el test que vale, no este intervalo.');
  const spoken = pooled.filter((r) => Math.abs(BIAS.bias_full(r)) >= 1);
  for (const [label, sel] of [
    ['A azar   ', arm(spoken, (r) => hashDir(r.t))],
    ['B BIAS   ', arm(spoken, (r) => Math.sign(BIAS.bias_full(r)))],
    ['C deriva ', arm(spoken, (r) => Math.sign(r.priceChange24hPct) || 1)],
    ['D oráculo', arm(spoken, oracleDir)],
  ]) {
    const w = rate(sel);
    console.log(`  ${label} ${w ? `${f1(w.point)}% [${f1(w.low)}–${f1(w.high)}] n_ef=${w.n_eff}` : '—'}`);
  }
}
console.log('\nEspecificación y criterios: doc/FASE_0_BIAS_ESPECIFICACION.md');
