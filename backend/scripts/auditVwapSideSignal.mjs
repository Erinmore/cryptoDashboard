#!/usr/bin/env node
/**
 * auditVwapSideSignal.mjs — B4 (SESSION_STATE.md §10.1): ¿predice `price_vs_vwap`
 * (above/below el VWAP rolling de 20 velas) la dirección del precio a 24h, aislado?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT
 *
 * VWAP nunca se ha probado como predictor — solo como ajuste de convicción en el prompt:
 * "price_vs_vwap=above en 1D: confirma momentum alcista... refuerza bias alcista" /
 * "below: señal de debilidad, añade cautela" (`anthropicService.js`). Eso es una hipótesis de
 * CONTINUACIÓN (momentum), a diferencia de los cruces de osciladores de B1-B3, que son
 * hipótesis de REVERSIÓN. Se usa `priceSide` — la MISMA función que calcula
 * `technical[tf].vwap.price_vs_vwap` en producción (exportada de `indicatorService.js` para
 * este script; cambio puramente aditivo, sin tocar su lógica ni la ruta de decisión, mismo
 * patrón que `signWithDeadband`/`ADX_DI_DEADBAND` ya exportados para `auditComputeTrend.mjs`).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · `above` (precio > VWAP + 0.25×ATR%) → el precio SIGUE subiendo (fwdAtr > +0.5) más a
 *       menudo que la base incondicional — hipótesis de momentum, no de reversión.
 *  P2 · `below` → el precio SIGUE bajando más a menudo que la base.
 *  P3 · Debe replicar en las 3 monedas con el IC de Wilson estrictamente separado, n_ef>=30.
 *
 * CONTROL DE CÓDIGO: a diferencia de B1-B3 (MACD/WaveTrend/StochRSI, donde el valor crudo se
 * niega EXACTO bajo reflexión), `price_vs_vwap` es una banda sobre un COCIENTE
 * `(price-vwap)/vwap` — bajo `p'=2A-p` el numerador se niega pero el DENOMINADOR pasa a
 * `2A-vwap`, no a `-vwap`, así que la razón no se niega exactamente salvo que `A=vwap` (no es
 * el caso con un ancla de ventana fija). Por eso aquí, igual que en
 * `auditLevelRejectionVsBreakout.mjs` (otra señal de PROXIMIDAD/PORCENTAJE, mismo motivo), el
 * control es AGREGADO por tolerancia (no exacto por ancla): la tasa de "sigue bajando" tras
 * `below` en los datos reales debe aproximar la tasa de "sigue subiendo" tras `above` en el
 * reflejo local — csi difieren mucho, hay una asimetría real en el código, no en el mercado.
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción). VWAP rolling 20 (default de
 * `calculateVWAP`). Horizonte 6 velas (24h). Anclajes DISJUNTOS vía `lib/disjointAnchors.mjs`.
 * Recorrido normalizado por ATR%×√6.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditVwapSideSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditVwapSideSignal.mjs
 */

import { calculateATRSeries, calculateVWAP } from '../src/utils/indicators.js';
import { priceSide } from '../src/services/indicatorService.js';
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

function sideAt(candles, i, atrPct) {
  const start = Math.max(0, i - WIN + 1);
  const vw = calculateVWAP(candles.slice(start, i + 1));
  if (!vw) return null;
  return priceSide(candles[i].close, vw.value, atrPct);
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

    const side = sideAt(candles, i, atrPct);
    if (side == null) continue;

    const pxFwd = candles[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, side, fwdAtr });

    // ── control de código (agregado, ver cabecera): reflejo LOCAL del tramo ────────────
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
          const mSide = sideAt(mLocal, mIdx, mAtrPct);
          if (mSide != null) {
            const mPxFwd = mLocal[mIdx + LOOKBACK].close;
            const mFwdAtr = (((mPxFwd - mPrice) / mPrice) * 100) / (mAtrPct * SQRT_WINDOW);
            mirrorRows.push({ t, side: mSide, fwdAtr: mFwdAtr });
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
console.log('B4 · ¿PREDICE price_vs_vwap LA DIRECCIÓN A 24H? — años de klines, señal AISLADA');
console.log(`${DAYS} d objetivo · TF 4h · VWAP rolling 20 sobre ventana ${WIN} · horizonte ${LOOKBACK} velas (24h)`);
console.log('P1: above → sigue subiendo más que la base (momentum) · P2: below → sigue bajando más');
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

  const upHit = (r) => r.fwdAtr > FWD_BAND;
  const dnHit = (r) => r.fwdAtr < -FWD_BAND;
  const baseUp = disjointRate(rows, upHit, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const baseDn = disjointRate(rows, dnHit, { horizonSec: HORIZON_SEC, stride: STRIDE });

  console.log(`\n${'─'.repeat(96)}\n${coin} — ${raw.length} velas de 4h (${spanDays} días) · n anclas=${rows.length}`);
  console.log(`  BASE incondicional  sube=${baseUp?.point?.toFixed(1) ?? '—'}%  baja=${baseDn?.point?.toFixed(1) ?? '—'}%  (n_ef=${baseUp?.n_eff ?? 0}/${baseDn?.n_eff ?? 0})`);

  const above = rows.filter((r) => r.side === 'above');
  const below = rows.filter((r) => r.side === 'below');
  const at = rows.filter((r) => r.side === 'at');
  console.log(`  reparto: above=${above.length}  below=${below.length}  at=${at.length}`
    + ` (${((above.length / rows.length) * 100).toFixed(0)}%/${((below.length / rows.length) * 100).toFixed(0)}%/${((at.length / rows.length) * 100).toFixed(0)}%)`);
  console.log('  above → ¿sigue subiendo?:');
  const rAbove = line('above → sube', above, upHit, baseUp);
  console.log('  below → ¿sigue bajando?:');
  const rBelow = line('below → baja', below, dnHit, baseDn);

  // ── control de código: AGREGADO, tolerancia (ver cabecera) ───────────────────────────
  const belowOrig = rows.filter((r) => r.side === 'below');
  const aboveMirror = mirrorRows.filter((r) => r.side === 'above');
  const rate = (arr, hit) => (arr.length ? arr.filter(hit).length / arr.length : null);
  const rOrig = rate(belowOrig, dnHit);
  const rMir = rate(aboveMirror, upHit);
  if (rOrig != null && rMir != null) {
    mirrorTotalAll++;
    const close = Math.abs(rOrig - rMir) < 0.05; // 5pp, mismo margen que auditLevelRejectionVsBreakout
    if (close) mirrorOkAll++;
    console.log(`  CONTROL DE CÓDIGO (reflejo local, agregado): below-real ${(rOrig * 100).toFixed(1)}% vs `
      + `above-de-reflejado ${(rMir * 100).toFixed(1)}%  ${close ? '✅' : '⚠️ revisar'}`);
  }

  results.push({ coin, rAbove, rBelow });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿replica price_vs_vwap como señal direccional aislada en 24h?');
let aboveOk = 0, belowOk = 0;
for (const { coin, rAbove, rBelow } of results) {
  const okAbove = !!rAbove?.significant;
  const okBelow = !!rBelow?.significant;
  if (okAbove) aboveOk++;
  if (okBelow) belowOk++;
  console.log(`  ${coin.padEnd(4)} above: ${rAbove ? `${rAbove.lift >= 0 ? '+' : ''}${rAbove.lift.toFixed(1)}pt (n_ef=${rAbove.n_eff})` : '—'} ${okAbove ? '✅' : '✗'}`
    + `   below: ${rBelow ? `${rBelow.lift >= 0 ? '+' : ''}${rBelow.lift.toFixed(1)}pt (n_ef=${rBelow.n_eff})` : '—'} ${okBelow ? '✅' : '✗'}`);
}
console.log(`\n${aboveOk} de ${results.length} monedas: above separa por encima de la base.`);
console.log(`${belowOk} de ${results.length} monedas: below separa por encima de la base.`);
console.log(`Control de reflexión (agregado, tolerancia 5pp): ${mirrorOkAll}/${mirrorTotalAll} monedas dentro de margen.`);
console.log('\nLECTURA: si las 3 monedas replican en AMBAS direcciones con el IC separado, price_vs_vwap');
console.log('aislado tiene poder predictivo real de MOMENTUM a 24h. Si no replica, se archiva junto a');
console.log('B1-B3 — "no predice, ni como reversión ni como continuación".');
