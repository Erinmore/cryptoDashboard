#!/usr/bin/env node
/**
 * auditCleanMoveDirection.mjs — M9 (reformulada): cuando el mercado SÍ ofrece un movimiento
 * limpio, ¿algo predice hacia DÓNDE?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ SE REFORMULA
 *
 * M9 se anotó como *"¿qué separa las anclas donde el ORÁCULO gana?"*. Así planteada tiene dos
 * problemas graves:
 *
 *  (1) **Es una expedición de pesca por construcción.** "Buscar qué feature separa" con una
 *      lista abierta encuentra algo SIEMPRE. Con 90 días y sin fuera de muestra, publicar el
 *      ganador de una búsqueda libre sería el error más caro que este proyecto puede cometer.
 *
 *  (2) **Media pregunta ya está contestada.** "¿Cuándo ofrece el mercado un movimiento
 *      limpio?" es una pregunta de RÉGIMEN, no de dirección — y `auditOpportunityRegimeCurve`
 *      ya midió que la tasa de oportunidad es **PLANA** por percentil de ATR% (41,7 / 33,5 /
 *      33,8 / 29,1 / 31,2 %, los cinco IC solapados y todos conteniendo el global).
 *
 * La mitad que SÍ importa para el producto y sigue abierta es la otra: **condicionado a que
 * haya habido un movimiento limpio, ¿qué predice su SIGNO?** Esa pregunta tiene un nulo
 * natural y falsable (la partición del propio periodo), y es exactamente lo que separaría un
 * producto direccional de uno condicional.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PRE-REGISTRO — escrito ANTES de ejecutar
 *
 * POBLACIÓN. Anclas de 4h donde `classifyOpportunity(...).offered === true` a 24 h con el par
 * calibrado 2×/1×. Por A1 (demostrado en `auditPathWinRate`) a lo sumo UNA dirección puede
 * ser limpia, así que la etiqueta es única y no ambigua.
 *
 * NULO. **NO es el 50 %.** La deriva del periodo hace que una dirección sea más frecuente, y
 * "adivinar siempre la mayoritaria" es una estrategia gratis. El listón es
 * `max(p_arriba, p_abajo)` — la **CLASE MAYORITARIA**, que se reporta siempre al lado.
 *
 * LAS SIETE FEATURES, CERRADAS AQUÍ Y AHORA (ninguna se añade después de ver resultados):
 *   F1 `st_4h`      SuperTrend 4h (UP→arriba)              — continuación
 *   F2 `rsi_side`   RSI 4h >50 → arriba                    — continuación
 *   F3 `sr_side`    más cerca del soporte → arriba         — reversión a la media
 *   F4 `bb_pos`     posición en Bollinger <0,5 → arriba    — reversión a la media
 *   F5 `smc_bos`    dirección del último BOS               — estructura
 *   F6 `mom_24h`    signo del cambio de 24 h               — momentum (≈ la clase mayoritaria)
 *   F7 `st_1d`      SuperTrend 1D                          — contexto de TF superior
 *
 * ⚠️ MULTIPLICIDAD DECLARADA: 7 features × 3 monedas, y además una feature muy por DEBAJO del
 * listón es tan informativa como una por encima (basta invertirla), lo que **duplica** las
 * comparaciones a 42. Con esa multiplicidad, un solo IC que no solape NO es un hallazgo.
 *
 * CRITERIO DE HALLAZGO (las tres condiciones, o no hay nada):
 *   (a) el IC de la feature no solapa con el listón de la clase mayoritaria,
 *   (b) **replica en signo en las TRES monedas**, y
 *   (c) **sobrevive al CONTRA-PERIODO** (`OFFSET_DAYS`). Todas las features salen de klines,
 *       así que aquí el fuera de muestra SÍ es posible — al contrario que en la fase 0, donde
 *       el sumando de derivados lo impedía.
 *
 * PREDICCIÓN FIRMADA ANTES DE EJECUTAR: no se espera que ninguna pase las tres. La fase 0 ya
 * midió que derivados+volumen+ejecución no baten al azar, y F1/F2/F6 son parientes de esos
 * mismos ejes. Las candidatas menos correlacionadas con lo ya probado son F3 y F4, las de
 * reversión a la media.
 *
 * SOLO LECTURA. Importa `classifyOpportunity` y los indicadores REALES del backend.
 *
 * Uso:
 *   node scripts/auditCleanMoveDirection.mjs
 *   OFFSET_DAYS=270 node scripts/auditCleanMoveDirection.mjs    # contra-periodo
 */

import {
  calculateATR, calculateRSI, calculateSuperTrend,
  calculateBollingerBands, calculateSupportResistance,
} from '../src/utils/indicators.js';
import { calculateSMC } from '../src/utils/smc.js';
import { computeFirstPassage } from '../src/utils/pathMetrics.js';
import { classifyOpportunity } from '../src/utils/stats.js';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 180);
const OFFSET_DAYS = Number(process.env.OFFSET_DAYS ?? 0);
const WIN_4H = 180;
const WIN_1D = 90;
const HORIZON_H = 24;
const HOUR_MS = 3600 * 1000;
const H4_MS = 4 * HOUR_MS;
const STRIDE = 6;

const FEATURES = ['st_4h', 'rsi_side', 'sr_side', 'bb_pos', 'smc_bos', 'mom_24h', 'st_1d'];

async function klines(coin, interval, startMs, endMs) {
  const out = [];
  let start = startMs;
  for (let g = 0; g < 40; g++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=${interval}&startTime=${start}&endTime=${endMs}&limit=1000`);
    if (!r.ok) throw new Error(`Binance ${coin}/${interval}: HTTP ${r.status}`);
    const b = (await r.json()).map((x) => ({
      t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
    }));
    if (!b.length) break;
    out.push(...b);
    if (b.length < 1000) break;
    start = b.at(-1).t + 1;
  }
  return out;
}

/** Las 7 features en el instante del ancla. +1 = predice ARRIBA, −1 = ABAJO, 0 = se abstiene. */
function featuresAt(w4h, w1d, price) {
  const closes = w4h.map((c) => c.close);
  const f = {};

  const st = calculateSuperTrend(w4h);
  f.st_4h = st ? (st.trend === 'UP' ? 1 : -1) : 0;

  const rsi = calculateRSI(closes);
  f.rsi_side = Number.isFinite(rsi) ? (rsi > 50 ? 1 : rsi < 50 ? -1 : 0) : 0;

  // Más cerca del soporte ⇒ hipótesis de REBOTE (arriba). Es reversión a la media, no momentum.
  const sr = calculateSupportResistance(w4h);
  const sup = sr?.supports?.[0]?.price, res = sr?.resistances?.[0]?.price;
  f.sr_side = (Number.isFinite(sup) && Number.isFinite(res))
    ? (Math.abs(price - sup) < Math.abs(res - price) ? 1 : -1) : 0;

  const bb = calculateBollingerBands(closes);
  f.bb_pos = (bb && Number.isFinite(bb.position))
    ? (bb.position < 0.5 ? 1 : bb.position > 0.5 ? -1 : 0) : 0;

  const smc = calculateSMC(w4h);
  const bos = smc?.last_bos;
  f.smc_bos = bos?.direction === 'bullish' ? 1 : bos?.direction === 'bearish' ? -1 : 0;

  const prev = w4h.at(-6)?.close;
  f.mom_24h = (Number.isFinite(prev) && prev > 0)
    ? (price > prev ? 1 : price < prev ? -1 : 0) : 0;

  const st1d = w1d.length >= 40 ? calculateSuperTrend(w1d) : null;
  f.st_1d = st1d ? (st1d.trend === 'UP' ? 1 : -1) : 0;

  return f;
}

async function collect(coin) {
  const endMs = Date.now() - OFFSET_DAYS * 24 * HOUR_MS;
  const startMs = endMs - (DAYS + 40) * 24 * HOUR_MS;
  const [k4, k1, kd] = await Promise.all([
    klines(coin, '4h', startMs, endMs),
    klines(coin, '1h', startMs, endMs),
    klines(coin, '1d', startMs, endMs),
  ]);
  if (k4.length < WIN_4H + 10 || !k1.length) return [];
  const lastH1 = k1.at(-1).t;
  const h1t = k1.map((c) => c.t);
  const idxFrom = (tMs) => {
    let lo = 0, hi = h1t.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (h1t[m] < tMs) lo = m + 1; else hi = m; }
    return lo;
  };

  const rows = [];
  for (let i = WIN_4H - 1; i < k4.length; i++) {
    const price = k4[i].close;
    const tMs = k4[i].t + H4_MS;
    if (!(price > 0) || lastH1 < tMs + HORIZON_H * HOUR_MS) continue;
    const w4h = k4.slice(i - WIN_4H + 1, i + 1);
    const atr = calculateATR(k4.slice(Math.max(0, i - 19), i + 1), 14);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const atrPct = (atr / price) * 100;

    const path = k1.slice(idxFrom(tMs), idxFrom(tMs) + 7 * 24 + 2);
    if (!path.length) continue;
    const fp = computeFirstPassage(path, price, atrPct, tMs, 7 * 24 * HOUR_MS);
    if (!fp) continue;

    // SOLO las anclas donde el mercado ofreció un movimiento LIMPIO: ahí hay dirección que
    // predecir. En el resto no hay etiqueta que aprender.
    const op = classifyOpportunity({ path_first_passage: fp }, { horizonH: HORIZON_H, now: null });
    if (!op.offered || !op.direction) continue;

    const w1d = kd.filter((c) => c.t + 86400e3 <= tMs).slice(-WIN_1D);
    rows.push({
      t: Math.floor(tMs / 1000),
      truth: op.direction === 'up' ? 1 : -1,
      f: featuresAt(w4h, w1d, price),
    });
  }
  return rows;
}

// ─── Reporte ─────────────────────────────────────────────────────────────────

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '—');

console.log('═'.repeat(94));
console.log('M9 · Condicionado a que HUBO movimiento limpio, ¿algo predice su DIRECCIÓN?');
console.log(`${DAYS} d · offset ${OFFSET_DAYS} d · horizonte ${HORIZON_H}h · 7 features PRE-REGISTRADAS`);
console.log('NULO = clase MAYORITARIA (adivinar siempre la dirección más frecuente es gratis).');
console.log('Hallazgo exige LAS TRES: IC sin solapar + réplica en 3 monedas + contra-periodo.');
console.log('Predicción firmada: no se espera que ninguna pase. F3/F4 son las menos redundantes.');
console.log('═'.repeat(94));

const pooled = [];
const veredicto = {};
for (const F of FEATURES) veredicto[F] = [];

for (const coin of COINS) {
  let rows;
  try { rows = await collect(coin); } catch (e) { console.log(`\n${coin}: ${e.message}`); continue; }
  if (rows.length < 30) { console.log(`\n${coin}: solo ${rows?.length ?? 0} anclas con movimiento limpio`); continue; }
  pooled.push(...rows);

  const up = rows.filter((r) => r.truth === 1).length;
  const pUp = up / rows.length;
  const major = Math.max(pUp, 1 - pUp) * 100;
  const majorDir = pUp >= 0.5 ? 'arriba' : 'abajo';

  // El listón se mide con la MISMA maquinaria disjunta que las features, o no es comparable.
  const majBase = disjointRate(
    rows.map((r) => ({ t: r.t, hit: r.truth === (pUp >= 0.5 ? 1 : -1) })),
    (x) => x.hit, { horizonSec: HORIZON_H * 3600, stride: STRIDE },
  );

  console.log(`\n${'─'.repeat(94)}\n${coin} · ${rows.length} anclas con movimiento limpio`
    + `  (arriba ${f1(pUp * 100)}% / abajo ${f1((1 - pUp) * 100)}%)`);
  console.log(`  NULO (clase mayoritaria = "${majorDir}"): ${f1(major)}%`
    + `  ·  con anclas disjuntas: ${f1(majBase?.point)}% [${f1(majBase?.low)}–${f1(majBase?.high)}] n_ef=${majBase?.n_eff}`);

  for (const F of FEATURES) {
    const sel = rows.filter((r) => r.f[F] !== 0).map((r) => ({ t: r.t, hit: r.f[F] === r.truth }));
    if (sel.length < 20) { console.log(`    ${F.padEnd(9)} n<20`); continue; }
    const w = disjointRate(sel, (x) => x.hit, { horizonSec: HORIZON_H * 3600, stride: STRIDE });
    if (!w) { console.log(`    ${F.padEnd(9)} sin cadena`); continue; }
    const v = verdictCI(w, majBase);
    veredicto[F].push(w.point - (majBase?.point ?? 50));
    console.log(`    ${F.padEnd(9)} ${f1(w.point).padStart(5)}%  [${f1(w.low)}–${f1(w.high)}]`
      + `  n_ef=${String(w.n_eff).padStart(3)}  cobertura ${f1(sel.length / rows.length * 100)}%`
      + `   ${v.separated ? `⚑ SEPARA (${v.side})` : 'solapa'}`);
  }
}

console.log(`\n${'═'.repeat(94)}\nRÉPLICA EN SIGNO (Δ contra el nulo, por moneda) — el test que de verdad vale`);
for (const F of FEATURES) {
  const ds = veredicto[F];
  if (!ds.length) continue;
  const same = ds.every((d) => d > 0) || ds.every((d) => d < 0);
  console.log(`  ${F.padEnd(9)} ${ds.map((d) => (d > 0 ? '+' : '') + d.toFixed(1)).join(' · ').padEnd(28)}`
    + `  ${same && ds.length === COINS.length ? '⚑ replica en signo' : 'no replica'}`);
}
console.log('\n⚠️ 7 features × 3 monedas, y una feature muy por DEBAJO del nulo es tan informativa');
console.log('   como una por encima (basta invertirla) → 42 comparaciones. Un solo IC que no');
console.log('   solape NO es un hallazgo. Sin réplica Y contra-periodo, no se toca nada.');
