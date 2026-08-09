#!/usr/bin/env node
/**
 * auditVolumeProfileExcursionSignal.mjs — B5 (SESSION_STATE.md §10.1): ¿predice la EXCURSIÓN
 * de Volume Profile (`above_vah` / `below_val`) una REVERSIÓN hacia el área de valor a 24h?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT Y ESTA HIPÓTESIS (no `price_vs_poc`)
 *
 * Volume Profile nunca se había probado como predictor. Tiene DOS lecturas posibles:
 * `price_vs_poc` (momentum, análogo a `price_vs_vwap`, ya cubierto en B4 — repetirlo aquí no
 * añadiría nada nuevo) y `excursion` (`above_vah`/`below_val`: precio >2% fuera del área de
 * valor de 70% del volumen) — la hipótesis CLÁSICA y diferenciada de Volume Profile: el área
 * de valor es donde el mercado aceptó negociar, así que una excursión fuera de ella tiende a
 * REVERTIR hacia el POC (el nivel de mayor volumen = "precio justo"), no a continuar. Se usa
 * `calculateVolumeProfile` (función real) + la MISMA fórmula del flag `excursion` que
 * `indicatorService.js:189-191` (>2% sobre VAH / <2% bajo VAL), replicada aquí en 2 líneas
 * porque es un ternario inline sin exportar — no una reimplementación de la lógica del
 * histograma de volumen en sí.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · `above_vah` → el precio REVIERTE a la baja (fwdAtr < -0.5) más a menudo que la base
 *       incondicional de "baja" — hipótesis de REVERSIÓN al área de valor.
 *  P2 · `below_val` → el precio REVIERTE al alza más a menudo que la base de "sube".
 *  P3 · Debe replicar en las 3 monedas con el IC de Wilson estrictamente separado, n_ef>=30.
 *
 * CONTROL DE CÓDIGO: AGREGADO por tolerancia (no exacto por ancla), mismo motivo que B4 y
 * `auditLevelRejectionVsBreakout.mjs` — POC/VAH/VAL surgen de un histograma con bins de ancho
 * fijo sobre `[rangeLow, rangeHigh]`; aunque el histograma se invierte limpiamente bajo la
 * reflexión LOCAL `p'=2A-p` (el rango se invierte, `binSize` no cambia), el redondeo de bin
 * (`Math.floor`) puede desplazar el índice del POC en ±1 bin cerca de un empate — igual que el
 * boundary de MACD, pero en el eje de PRECIO en vez de en el valor del indicador. Se compara
 * la tasa agregada `above_vah-real → revierte` contra `below_val-de-reflejado → revierte`.
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción, `calculateVolumeProfile` con sus
 * defaults `bins=50, targetPct=0.70`). Horizonte 6 velas (24h). Anclajes DISJUNTOS vía
 * `lib/disjointAnchors.mjs`. Recorrido normalizado por ATR%×√6.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditVolumeProfileExcursionSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditVolumeProfileExcursionSignal.mjs
 */

import { calculateATRSeries } from '../src/utils/indicators.js';
import { calculateVolumeProfile } from '../src/utils/volumeProfile.js';
import { fetchKlines, mirrorCandles } from './lib/binanceKlines.mjs';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 1000);
const WIN = 180;                  // ventana de producción (4h)
const LOOKBACK = 6;                // 24h en velas de 4h
const SQRT_WINDOW = Math.sqrt(LOOKBACK);
const HORIZON_SEC = LOOKBACK * 4 * 3600;
const STRIDE = 6;
const FWD_BAND = 0.5;
const MIN_N = 30;

// Misma fórmula que indicatorService.js:189-191 — replicada porque es un ternario inline
// sin exportar, no una reimplementación del histograma (calculateVolumeProfile sí se importa).
function excursionAt(price, vah, val) {
  if (vah != null && price > vah * 1.02) return 'above_vah';
  if (val != null && price < val * 0.98) return 'below_val';
  return null;
}

function excursionOf(candles, i) {
  const start = Math.max(0, i - WIN + 1);
  const vp = calculateVolumeProfile(candles.slice(start, i + 1));
  if (!vp) return null;
  return excursionAt(candles[i].close, vp.vah, vp.val);
}

function build(candles) {
  const atrByIdx = new Map((calculateATRSeries(candles, 14) ?? []).map((e) => [e.idx, e.atr]));
  const rows = [];
  const mirrorRows = [];

  for (let i = WIN; i + LOOKBACK < candles.length; i++) {
    const atr = atrByIdx.get(i);
    const price = candles[i].close;
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;

    const exc = excursionOf(candles, i);
    if (exc == null) continue; // solo interesan las anclas EN excursión

    const pxFwd = candles[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, exc, fwdAtr });

    // ── control de código (agregado): reflejo LOCAL del tramo ──────────────────────────
    const lo = i - WIN + 1;
    if (lo >= 0) {
      const localSlice = candles.slice(lo, i + 1 + LOOKBACK);
      const mLocal = mirrorCandles(localSlice, localSlice[0].close);
      const mIdx = i - lo;
      const mAtrEntry = (calculateATRSeries(mLocal, 14) ?? []).find((e) => e.idx === mIdx);
      const mPrice = mLocal[mIdx].close;
      if (mAtrEntry && mPrice > 0) {
        const mAtrPct = (mAtrEntry.atr / mPrice) * 100;
        if (mAtrPct > 0) {
          const mExc = excursionOf(mLocal, mIdx);
          if (mExc != null) {
            const mPxFwd = mLocal[mIdx + LOOKBACK].close;
            const mFwdAtr = (((mPxFwd - mPrice) / mPrice) * 100) / (mAtrPct * SQRT_WINDOW);
            mirrorRows.push({ t, exc: mExc, fwdAtr: mFwdAtr });
          }
        }
      }
    }
  }
  return { rows, mirrorRows };
}

function line(label, sel, hit, base) {
  const r = disjointRate(sel, hit, { horizonSec: HORIZON_SEC, stride: STRIDE });
  if (!r) { console.log(`    ${label.padEnd(30)} sin anclas`); return null; }
  const lift = r.point - base.point;
  const v = verdictCI(r, base);
  const significant = r.n_eff >= MIN_N && v.separated && v.side === 'above';
  const flag = r.n_eff < MIN_N ? '⚠ n<30'
    : (significant ? '✅ IC por encima de la base' : v.separated ? '⚠️ IC por debajo' : '✗ IC cruza la base');
  console.log(`    ${label.padEnd(30)} n_ef=${String(r.n_eff).padStart(4)}  tasa=${r.point.toFixed(1)}%`
    + `  lift=${lift >= 0 ? '+' : ''}${lift.toFixed(1)}pt  IC[${r.low.toFixed(1)}-${r.high.toFixed(1)}]  ${flag}`);
  return { r, lift, n_eff: r.n_eff, significant };
}

console.log('═'.repeat(96));
console.log('B5 · ¿PREDICE LA EXCURSIÓN DE VOLUME PROFILE UNA REVERSIÓN A 24H? — señal AISLADA');
console.log(`${DAYS} d objetivo · TF 4h · VP bins=50/target=70% sobre ventana ${WIN} · horizonte ${LOOKBACK} velas (24h)`);
console.log('P1: above_vah → revierte a la baja más que la base · P2: below_val → revierte al alza más');
console.log('P3: replica en 3 monedas, IC separado, n_ef>=30 · CONTROL: reflejo local AGREGADO (tolerancia)');
console.log('═'.repeat(96));

const results = [];
let mirrorTotalAll = 0, mirrorOkAll = 0;

for (const coin of COINS) {
  let raw;
  try { raw = await fetchKlines(coin, DAYS); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (raw.length < WIN + LOOKBACK + 20) { console.log(`${coin}: histórico insuficiente`); continue; }
  const spanDays = ((raw.at(-1).t - raw[0].t) / 86400e3).toFixed(0);
  const { rows, mirrorRows } = build(raw);

  // Base: sobre TODAS las anclas con VP válido (no solo las de excursión) — necesita su
  // propio recorrido (build() solo guarda filas EN excursión), así que se recalcula aparte.
  const atrByIdx = new Map((calculateATRSeries(raw, 14) ?? []).map((e) => [e.idx, e.atr]));
  const allRows = [];
  for (let i = WIN; i + LOOKBACK < raw.length; i++) {
    const atr = atrByIdx.get(i);
    const price = raw[i].close;
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;
    const pxFwd = raw[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    allRows.push({ t: Math.floor(raw[i].t / 1000), fwdAtr });
  }

  const upHit = (r) => r.fwdAtr > FWD_BAND;
  const dnHit = (r) => r.fwdAtr < -FWD_BAND;
  const baseUp = disjointRate(allRows, upHit, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const baseDn = disjointRate(allRows, dnHit, { horizonSec: HORIZON_SEC, stride: STRIDE });

  console.log(`\n${'─'.repeat(96)}\n${coin} — ${raw.length} velas de 4h (${spanDays} días) · n anclas totales=${allRows.length}`);
  console.log(`  BASE incondicional  sube=${baseUp?.point?.toFixed(1) ?? '—'}%  baja=${baseDn?.point?.toFixed(1) ?? '—'}%  (n_ef=${baseUp?.n_eff ?? 0}/${baseDn?.n_eff ?? 0})`);

  const aboveVah = rows.filter((r) => r.exc === 'above_vah');
  const belowVal = rows.filter((r) => r.exc === 'below_val');
  console.log(`  en excursión: above_vah=${aboveVah.length}  below_val=${belowVal.length}  (${((rows.length / allRows.length) * 100).toFixed(1)}% de las anclas)`);
  console.log('  above_vah → ¿revierte a la baja?:');
  const rAbove = line('above_vah → baja', aboveVah, dnHit, baseDn);
  console.log('  below_val → ¿revierte al alza?:');
  const rBelow = line('below_val → sube', belowVal, upHit, baseUp);

  // ── control de código: AGREGADO, tolerancia ───────────────────────────────────────────
  const aboveOrig = rows.filter((r) => r.exc === 'above_vah');
  const belowMirror = mirrorRows.filter((r) => r.exc === 'below_val');
  const rate = (arr, hit) => (arr.length ? arr.filter(hit).length / arr.length : null);
  const rOrig = rate(aboveOrig, dnHit);
  const rMir = rate(belowMirror, upHit);
  if (rOrig != null && rMir != null) {
    mirrorTotalAll++;
    const close = Math.abs(rOrig - rMir) < 0.05;
    if (close) mirrorOkAll++;
    console.log(`  CONTROL DE CÓDIGO (reflejo local, agregado): above_vah-real ${(rOrig * 100).toFixed(1)}% vs `
      + `below_val-de-reflejado ${(rMir * 100).toFixed(1)}%  ${close ? '✅' : '⚠️ revisar'}`);
  }

  results.push({ coin, rAbove, rBelow });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿replica la excursión de Volume Profile como señal de REVERSIÓN en 24h?');
let aboveOk = 0, belowOk = 0;
for (const { coin, rAbove, rBelow } of results) {
  const okAbove = !!rAbove?.significant;
  const okBelow = !!rBelow?.significant;
  if (okAbove) aboveOk++;
  if (okBelow) belowOk++;
  console.log(`  ${coin.padEnd(4)} above_vah→baja: ${rAbove ? `${rAbove.lift >= 0 ? '+' : ''}${rAbove.lift.toFixed(1)}pt (n_ef=${rAbove.n_eff})` : '—'} ${okAbove ? '✅' : '✗'}`
    + `   below_val→sube: ${rBelow ? `${rBelow.lift >= 0 ? '+' : ''}${rBelow.lift.toFixed(1)}pt (n_ef=${rBelow.n_eff})` : '—'} ${okBelow ? '✅' : '✗'}`);
}
console.log(`\n${aboveOk} de ${results.length} monedas: above_vah→baja separa por encima de la base.`);
console.log(`${belowOk} de ${results.length} monedas: below_val→sube separa por encima de la base.`);
console.log(`Control de reflexión (agregado, tolerancia 5pp): ${mirrorOkAll}/${mirrorTotalAll} monedas dentro de margen.`);
console.log('\nLECTURA: si las 3 monedas replican en AMBAS direcciones con el IC separado, la excursión');
console.log('de Volume Profile predice reversión al área de valor. Si no replica, se archiva junto a');
console.log('B1-B4 — la teoría de "el precio vuelve al valor justo" no tiene potencia medible.');
