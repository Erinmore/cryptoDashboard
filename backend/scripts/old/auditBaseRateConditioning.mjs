/**
 * auditBaseRateConditioning.mjs — ¿son las tasas base el listón CORRECTO para producción?
 *
 * LAS TRES FILAS QUE QUEDARON SIN EXPLICAR el 2026-08-01 comparten una dependencia
 * METODOLÓGICA, y ésta sí es verificable leyendo el código de cada tasa base (a diferencia
 * de la premisa del ATR, que se asumió y nunca se comprobó — el error caro del día):
 *
 *   · `offered_pct` 0 de 4 se compara contra `OPPORTUNITY_BASE_RATE` (34,8 %), medida sobre
 *     TODOS los cierres de vela 4h.
 *   · `trigger_rate` (lift −55) se compara contra `TRIGGER_BASE_RATE`, medida sobre 90 días
 *     COMPLETOS.
 *   · `no_signal` se lee como "dominante" SIN tasa base ninguna.
 *
 * Pero producción no muestrea al azar: dispara a las **08:05 y 20:05 UTC** (2 de los 6
 * cierres diarios de 4h) y lleva todo el periodo en el **cuartil más tranquilo** de
 * volatilidad. Hoy mismo se demostró lo que eso puede hacer: muestrear 1h a fase fija dio
 * 85,6 % de `squeeze` frente a 28,2 % con la fase derivando, sobre LOS MISMOS bloques.
 *
 * ANCLAS, fijadas ANTES de ejecutar — y son PREDICCIONES FIRMADAS, no "a ver qué sale":
 *
 *  A1 · SIN ESTACIONALIDAD HORARIA, las tasas medidas SOLO en los anclajes de 08/20 UTC
 *       deben coincidir con las de todos los anclajes dentro de su IC. Si no coinciden, el
 *       listón contra el que se juzga a producción está mal elegido — no mal calculado.
 *
 *  A2 · INVARIANCIA DE RÉGIMEN (la más fuerte). `classifyOpportunity` normaliza por ATR y
 *       `normalizedTriggerDistance` divide por `ATR%×√velas`: **si la normalización hace su
 *       trabajo, ambas tasas deben ser CONSTANTES entre cuartiles de ATR%**. Ésa es la única
 *       razón por la que se normaliza. Y ahora hay una predicción con signo: se midió que el
 *       ATR se queda CORTO un 18 % en el cuartil tranquilo, luego allí el listón de 2×ATR es
 *       demasiado BAJO → la oportunidad debería salir **MÁS ALTA**, no más baja. Si sale más
 *       baja, la normalización no compensa y `offered_pct` se está juzgando contra una cifra
 *       que no aplica al régimen del periodo.
 *
 *  A3 · CALIBRACIÓN DE `TRIGGER_BASE_RATE` POR ESTRATO. Para las 7 geometrías reales se
 *       compara la tasa de disparo OBSERVADA contra la que PREDICE la curva
 *       (`triggerBaseRateFor` sobre `normalizedTriggerDistance`, funciones reales) dentro de
 *       cada cuartil de ATR%. Si la curva está bien calibrada, observado − predicho ≈ 0 en
 *       TODOS los estratos. Si sobre-predice justo en el cuartil tranquilo, el lift −55 se
 *       explica sin ninguna anomalía del sistema.
 *
 *  A4 · `no_signal` — frecuencia histórica con `oiPriceCell` real. Cierra la fila entera:
 *       si históricamente ronda el 50 %, verlo en 5 de 7 análisis no es "dominante", es lo
 *       normal, y la fila deja de ser un hallazgo.
 *
 * SOLO LECTURA. No abre la BBDD ni toca producción. Requiere COINALYZE_API_KEY (parte A4).
 *
 * Uso: node scripts/auditBaseRateConditioning.mjs
 */

import { readFileSync } from 'node:fs';
import { calculateATRSeries, calculateATR } from '../src/utils/indicators.js';
import { computeFirstPassage } from '../src/utils/pathMetrics.js';
import { classifyOpportunity, normalizedTriggerDistance, triggerBaseRateFor, wilsonInterval } from '../src/utils/stats.js';
import { oiPriceCell } from '../src/utils/derivativesScore.js';
import { evaluateShadowTrade } from '../src/utils/shadowTrade.js';

const envRaw = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const API_KEY = envRaw.match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const DAYS = Number(process.env.DAYS ?? 90);
const HOUR_MS = 3600 * 1000;
const H4_MS = 4 * HOUR_MS;
const PROD_HOURS = [8, 20];        // cierre de la vela 4h que produccion analiza (cron A)
const ATR_PERIOD = 14;
const LOOKBACK_4H = 6;
const SQRT_W = Math.sqrt(LOOKBACK_4H);

// Las 7 geometrías reales de producción (idénticas a auditShadowBaseline.mjs).
const REALES = [
  [74.01, 'long', 75.60, 73.10, 79.37, 12], [73.31, 'short', 72.20, 73.55, 69.50, 6],
  [74.81, 'long', 76.70, 74.30, 79.50, 12], [73.59, 'long', 74.65, 72.80, 76.57, 6],
  [73.04, 'short', 72.25, 73.55, 69.50, 6], [73.02, 'short', 72.20, 73.55, 68.32, 6],
  [72.91, 'short', 72.20, 74.55, 68.32, 6],
];
const FORMAS = REALES.map(([p, dir, e, s, t, v]) => ({ dir, e: e / p - 1, s: s / p - 1, t: t / p - 1, v }));

async function klines(symbol, interval, limit = 1000, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
  }));
}
async function deep(symbol, interval, want) {
  const out = []; let endTime;
  for (let i = 0; i < 8 && out.length < want; i++) {
    const b = await klines(symbol, interval, 1000, endTime);
    if (!b.length) break;
    out.unshift(...b); endTime = b[0].t - 1;
    if (b.length < 1000) break;
  }
  return out;
}
async function coinalyze(coin, endpoint, interval) {
  const to = Math.floor(Date.now() / 1000), from = to - DAYS * 86400;
  const r = await fetch(`https://api.coinalyze.net/v1/${endpoint}?symbols=${coin}USDT_PERP.A`
    + `&interval=${interval}&from=${from}&to=${to}&api_key=${API_KEY}`);
  if (!r.ok) return [];
  return (await r.json())?.[0]?.history ?? [];
}

const pct = (k, n) => (n ? (k / n) * 100 : null);
const fmt = (x, d = 1) => (x == null ? '  —  ' : x.toFixed(d));
const isProdHour = (ms) => PROD_HOURS.includes(new Date(ms).getUTCHours());
const quartile = (v, cuts) => (v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : 3);
const cutsOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return [0.25, 0.5, 0.75].map((p) => s[Math.floor((s.length - 1) * p)]);
};
const Q = ['Q1 (más tranquilo)', 'Q2', 'Q3', 'Q4 (más agitado)'];

function report(title, strata) {
  console.log(`\n  ${title}`);
  for (const [label, k, n] of strata) {
    if (!n) { console.log(`    ${label.padEnd(24)}  sin datos`); continue; }
    const ci = wilsonInterval(k, n);
    console.log(`    ${label.padEnd(24)} n=${String(n).padStart(5)}  ${fmt(pct(k, n)).padStart(6)}%`
      + `  IC[${ci.low}-${ci.high}]`);
  }
}

// ─── A4 · frecuencia de `no_signal` ──────────────────────────────────────────

console.log('¿SON LAS TASAS BASE EL LISTÓN CORRECTO PARA PRODUCCIÓN?');
console.log(`${DAYS} d · ${COINS.join('+')} · producción muestrea a las ${PROD_HOURS.join('/')} UTC`);
console.log('ANCLAS: A1 08/20 UTC ≈ todos · A2 tasas ATR-normalizadas CONSTANTES entre cuartiles');
console.log('        A3 observado − predicho ≈ 0 en cada estrato · A4 base histórica de `no_signal`\n');
console.log('═'.repeat(88));
console.log('A4 · FRECUENCIA HISTÓRICA DE LAS CELDAS DEL CUADRO OI×PRECIO (`oiPriceCell` real)');

const cellRows = [];
if (API_KEY) {
  for (const coin of COINS) {
    const [k4, oi] = await Promise.all([klines(coin, '4h', 1000), coinalyze(coin, 'open-interest-history', '4hour')]);
    if (!oi.length) continue;
    const atrByIdx = new Map((calculateATRSeries(k4, ATR_PERIOD) ?? []).map((e) => [e.idx, e.atr]));
    const idxByT = new Map(k4.map((c, i) => [Math.floor(c.t / 1000), i]));
    const closeByT = new Map(k4.map((c) => [Math.floor(c.t / 1000), c.close]));
    for (let i = LOOKBACK_4H; i < oi.length; i++) {
      const t = oi[i].t, oiPrev = oi[i - LOOKBACK_4H].c, oiNow = oi[i].c;
      const pxNow = closeByT.get(t), pxPrev = closeByT.get(oi[i - LOOKBACK_4H].t);
      const idx = idxByT.get(t); const atr = atrByIdx.get(idx);
      if (!(oiPrev > 0) || !Number.isFinite(pxNow) || !Number.isFinite(pxPrev) || !Number.isFinite(atr)) continue;
      const atrPct = (atr / pxNow) * 100;
      if (!(atrPct > 0)) continue;
      const { cell } = oiPriceCell({
        oiChange24hPct: ((oiNow - oiPrev) / oiPrev) * 100,
        priceChange24hPct: ((pxNow - pxPrev) / pxPrev) * 100,
        atrPct, primaryTf: '4h',
      });
      cellRows.push({ coin, cell, atrPct, prod: isProdHour(t * 1000) });
    }
  }
  const cells = ['no_signal', 'new_money_long', 'failed_rally', 'new_money_short', 'deleveraging'];
  const n = cellRows.length;
  console.log(`  n=${n} anclas`);
  for (const c of cells) {
    const k = cellRows.filter((r) => r.cell === c).length;
    const prodRows = cellRows.filter((r) => r.prod);
    const kp = prodRows.filter((r) => r.cell === c).length;
    console.log(`    ${c.padEnd(18)} todas ${fmt(pct(k, n)).padStart(6)}%`
      + `   solo 08/20 UTC ${fmt(pct(kp, prodRows.length)).padStart(6)}% (n=${prodRows.length})`);
  }
  const cuts = cutsOf(cellRows.map((r) => r.atrPct));
  const q1 = cellRows.filter((r) => quartile(r.atrPct, cuts) === 0);
  console.log(`    → no_signal en el cuartil MÁS TRANQUILO: `
    + `${fmt(pct(q1.filter((r) => r.cell === 'no_signal').length, q1.length))}% (n=${q1.length})`);
} else {
  console.log('  (sin COINALYZE_API_KEY — se omite)');
}

// ─── A1/A2 · oportunidad ─────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(88)}`);
console.log('A1+A2 · TASA BASE DE OPORTUNIDAD (24h, 2×/1× ATR) — `classifyOpportunity` real');
console.log(`  Referencia publicada: OPPORTUNITY_BASE_RATE['24h'] = 34,8 % (medida sobre TODOS los anclajes)`);

const oppRows = [];
for (const coin of COINS) {
  const k4 = await deep(coin, '4h', Math.ceil((DAYS * 24) / 4) + 60);
  const k1 = await deep(coin, '1h', DAYS * 24 + 400);
  const times = k1.map((c) => c.t);
  const idxFrom = (t) => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; } return lo; };
  const last = k1.at(-1)?.t ?? 0;
  for (let i = ATR_PERIOD + 1; i < k4.length; i++) {
    const atr = calculateATR(k4.slice(Math.max(0, i - ATR_PERIOD - 5), i + 1), ATR_PERIOD);
    const c = k4[i];
    if (!Number.isFinite(atr) || !(c.close > 0)) continue;
    const atrPct = (atr / c.close) * 100;
    const tMs = c.t + H4_MS;
    if (last < tMs + 24 * HOUR_MS) continue;
    const from = idxFrom(tMs);
    const path = k1.slice(from, from + 7 * 24 + 2);
    const fp = computeFirstPassage(path, c.close, atrPct, tMs, 7 * 24 * HOUR_MS);
    if (!fp) continue;
    // `now: null` = historia cerrada (ver la nota equivalente en auditOpportunityRegimeCurve).
    const op = classifyOpportunity({ path_first_passage: fp }, { horizonH: 24, now: null });
    if (!op.evaluable) continue;
    oppRows.push({ coin, offered: op.offered, atrPct, prod: isProdHour(tMs) });
  }
}
{
  const n = oppRows.length, k = oppRows.filter((r) => r.offered).length;
  const prod = oppRows.filter((r) => r.prod);
  report('A1 · ¿importa la HORA de disparo?', [
    ['todos los anclajes', k, n],
    ['solo 08/20 UTC', prod.filter((r) => r.offered).length, prod.length],
  ]);
  const cuts = cutsOf(oppRows.map((r) => r.atrPct));
  report('A2 · ¿es CONSTANTE entre cuartiles de ATR%? (debe serlo: la métrica está ATR-normalizada)',
    Q.map((label, qi) => {
      const g = oppRows.filter((r) => quartile(r.atrPct, cuts) === qi);
      return [label, g.filter((r) => r.offered).length, g.length];
    }));
}

// ─── A3 · calibración de la curva de disparo ─────────────────────────────────

console.log(`\n${'═'.repeat(88)}`);
console.log('A3 · CALIBRACIÓN DE `TRIGGER_BASE_RATE` POR RÉGIMEN — 7 geometrías reales (SOL)');
console.log('  observado vs lo que PREDICE la curva (`triggerBaseRateFor` sobre `normalizedTriggerDistance`)');

const k4s = await deep('SOL', '4h', Math.ceil((DAYS * 24) / 4) + 60);
const k1s = await deep('SOL', '1h', DAYS * 24 + 400);
const lastT = k1s.at(-1)?.t ?? 0;
const trig = [];
for (let i = 18; i < k4s.length; i++) {
  const w = k4s.slice(i - 18, i + 1);
  const atr = calculateATR(w, ATR_PERIOD);
  const c = k4s[i];
  if (!Number.isFinite(atr) || !(c.close > 0)) continue;
  const atrPct = parseFloat(((atr / c.close) * 100).toFixed(2));
  const tMs = c.t + H4_MS;
  for (const f of FORMAS) {
    if (tMs + f.v * H4_MS > lastT) continue;
    const cs = {
      direction: f.dir, entry_price: c.close * (1 + f.e), stop_price: c.close * (1 + f.s),
      tp1_price: c.close * (1 + f.t), validity_candles: f.v, tf_execution: '4h',
    };
    const candles = k1s.filter((x) => x.t >= tMs && x.t <= tMs + 8 * 24 * HOUR_MS);
    const ev = evaluateShadowTrade({ conditionalSetup: cs, candles, tMs, primaryTf: '4h', now: Date.now() });
    if (!ev || ev.preserve) continue;
    const d = normalizedTriggerDistance({
      entryPrice: cs.entry_price, priceAtAnalysis: c.close, atrPct,
      validityCandles: f.v, tfExecution: '4h', primaryTf: '4h',
    });
    const pred = triggerBaseRateFor(d, f.dir === 'short' ? 'short' : 'long');
    if (pred == null) continue;
    trig.push({ filled: ev.filled, pred, atrPct, prod: isProdHour(tMs) });
  }
}
{
  const line = (label, g) => {
    if (!g.length) { console.log(`    ${label.padEnd(24)} sin datos`); return; }
    const obs = pct(g.filter((r) => r.filled).length, g.length);
    const pred = g.reduce((a, r) => a + r.pred, 0) / g.length;
    console.log(`    ${label.padEnd(24)} n=${String(g.length).padStart(5)}`
      + `  observado ${fmt(obs).padStart(6)}%  predicho ${fmt(pred).padStart(6)}%`
      + `  LIFT ${(obs - pred >= 0 ? '+' : '') + fmt(obs - pred)}`);
  };
  line('todos los anclajes', trig);
  line('solo 08/20 UTC', trig.filter((r) => r.prod));
  const cuts = cutsOf(trig.map((r) => r.atrPct));
  console.log('  Por cuartil de ATR% (ancla A3: el lift debe ser ≈0 en TODOS si la curva calibra):');
  Q.forEach((label, qi) => line(`  ${label}`, trig.filter((r) => quartile(r.atrPct, cuts) === qi)));
}
