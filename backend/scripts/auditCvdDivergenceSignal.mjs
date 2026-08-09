#!/usr/bin/env node
/**
 * auditCvdDivergenceSignal.mjs — B10 (SESSION_STATE.md §10.1, última del Bloque B): ¿predice
 * la divergencia CVD↔precio (`calculateCVD().divergence`) la dirección del precio a 24h,
 * AISLADA de la puerta de fuerza (`cvd_strength`) y del resto del gating?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT
 *
 * La divergencia CVD es la señal más discutida del sistema — el veto exige `cvd_strength`
 * no-marginal antes de contarla (H3/Fase 2 de la 2ª auditoría red-team), el prompt la trata
 * como "absorción, MUY ALCISTA sobre soporte" en un contexto y como evidencia bajista en otro
 * (desambiguación estructural v6_6). Pero nunca se ha medido la señal PURA — sin la puerta de
 * fuerza, sin el contexto de nivel S/R, sin el veto — como predictor aislado.
 *
 * `divergence='bullish'` = precio BAJA pero CVD SUBE (venta sin convicción / absorción =
 * tesis de reversión alcista). `divergence='bearish'` = precio SUBE pero CVD BAJA (compra sin
 * convicción = tesis de reversión bajista). Se usa `calculateCVD` real, sin reimplementar.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · `divergence='bullish'` → el precio SUBE (fwdAtr > +0.5) más a menudo que la base
 *       incondicional de "sube" — la tesis de absorción/reversión.
 *  P2 · `divergence='bearish'` → el precio BAJA más a menudo que la base.
 *  P3 · Debe replicar en las 3 monedas con el IC de Wilson estrictamente separado, n_ef>=30.
 *
 * CONTROL DE CÓDIGO: AGREGADO por tolerancia (no exacto por ancla) — mismo motivo que B4/B5/B9.
 * El `delta` (real o heurístico) SÍ se niega EXACTO bajo la reflexión local (`taker_buy_base' =
 * volume - taker_buy_base`, o `buyRatio' = 1-buyRatio` en la rama heurística — álgebra
 * verificada en la cabecera del commit), y por tanto la serie CVD y su `trend`
 * (`rising`↔`falling`) se niegan/invierten EXACTOS. Pero `priceThreshold` compara
 * `Math.abs(prevClose)×0.001` — una magnitud de PRECIO, no de retorno — y `prevClose` no se
 * niega exacto bajo un ancla de reflexión fija (mismo motivo que el `high_volatility` de B7:
 * un valor absoluto de precio, no una razón). Se compara la tasa agregada "bearish-real →
 * baja" contra "bullish-de-reflejado → sube".
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción; `DIVERGENCE_WINDOW=20` interno de
 * `calculateCVD`, sin cambios). Horizonte 6 velas (24h). Anclajes DISJUNTOS vía
 * `lib/disjointAnchors.mjs`. Sin filtro de `cvd_strength` — es la señal PURA que pide B10.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditCvdDivergenceSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditCvdDivergenceSignal.mjs
 */

import { calculateATRSeries, calculateCVD } from '../src/utils/indicators.js';
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

function divergenceAt(candles, i) {
  const start = Math.max(0, i - WIN + 1);
  const cvd = calculateCVD(candles.slice(start, i + 1));
  return cvd ? cvd.divergence : null; // 'bullish' | 'bearish' | 'none'
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

    const div = divergenceAt(candles, i);
    if (div == null || div === 'none') continue;

    const pxFwd = candles[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, div, fwdAtr });

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
          const mDiv = divergenceAt(mLocal, mIdx);
          if (mDiv != null && mDiv !== 'none') {
            const mPxFwd = mLocal[mIdx + LOOKBACK].close;
            const mFwdAtr = (((mPxFwd - mPrice) / mPrice) * 100) / (mAtrPct * SQRT_WINDOW);
            mirrorRows.push({ t, div: mDiv, fwdAtr: mFwdAtr });
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
console.log('B10 · ¿PREDICE LA DIVERGENCIA CVD LA DIRECCIÓN A 24H, PURA? — señal AISLADA (última del Bloque B)');
console.log(`${DAYS} d objetivo · TF 4h · calculateCVD (ventana divergencia=20) sobre ventana ${WIN} · horizonte ${LOOKBACK} velas`);
console.log('P1: bullish (venta sin convicción) → sube más que la base · P2: bearish → baja más que la base');
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
  console.log(`  BASE incondicional (sobre anclas con divergencia)  sube=${baseUp?.point?.toFixed(1) ?? '—'}%  baja=${baseDn?.point?.toFixed(1) ?? '—'}%  (n_ef=${baseUp?.n_eff ?? 0}/${baseDn?.n_eff ?? 0})`);

  const bull = rows.filter((r) => r.div === 'bullish');
  const bear = rows.filter((r) => r.div === 'bearish');
  console.log(`  divergencia: bullish=${bull.length}  bearish=${bear.length}`);
  console.log('  bullish (absorción venta) → ¿sube?:');
  const rBull = line('bullish → sube', bull, upHit, baseUp);
  console.log('  bearish (absorción compra) → ¿baja?:');
  const rBear = line('bearish → baja', bear, dnHit, baseDn);

  // ── control de código: AGREGADO, tolerancia ───────────────────────────────────────────
  const bearOrig = rows.filter((r) => r.div === 'bearish');
  const bullMirror = mirrorRows.filter((r) => r.div === 'bullish');
  const rate = (arr, hit) => (arr.length ? arr.filter(hit).length / arr.length : null);
  const rOrig = rate(bearOrig, dnHit);
  const rMir = rate(bullMirror, upHit);
  if (rOrig != null && rMir != null) {
    mirrorTotalAll++;
    const close = Math.abs(rOrig - rMir) < 0.05;
    if (close) mirrorOkAll++;
    console.log(`  CONTROL DE CÓDIGO (reflejo local, agregado): bearish-real ${(rOrig * 100).toFixed(1)}% vs `
      + `bullish-de-reflejado ${(rMir * 100).toFixed(1)}%  ${close ? '✅' : '⚠️ revisar'}`);
  }

  results.push({ coin, rBull, rBear });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿replica la divergencia CVD pura como señal direccional aislada en 24h?');
let bullOk = 0, bearOk = 0;
for (const { coin, rBull, rBear } of results) {
  const okBull = !!rBull?.significant;
  const okBear = !!rBear?.significant;
  if (okBull) bullOk++;
  if (okBear) bearOk++;
  console.log(`  ${coin.padEnd(4)} bullish: ${rBull ? `${rBull.lift >= 0 ? '+' : ''}${rBull.lift.toFixed(1)}pt (n_ef=${rBull.n_eff})` : '—'} ${okBull ? '✅' : '✗'}`
    + `   bearish: ${rBear ? `${rBear.lift >= 0 ? '+' : ''}${rBear.lift.toFixed(1)}pt (n_ef=${rBear.n_eff})` : '—'} ${okBear ? '✅' : '✗'}`);
}
console.log(`\n${bullOk} de ${results.length} monedas: divergencia bullish separa por encima de la base.`);
console.log(`${bearOk} de ${results.length} monedas: divergencia bearish separa por encima de la base.`);
console.log(`Control de reflexión (agregado, tolerancia 5pp): ${mirrorOkAll}/${mirrorTotalAll} monedas dentro de margen.`);
console.log('\nLECTURA: si las 3 monedas replican en AMBAS direcciones con el IC separado, la divergencia');
console.log('CVD PURA tiene poder predictivo real a 24h, incluso sin la puerta de fuerza. Si no replica,');
console.log('cierra el Bloque B entero: ninguna de las 10 señales aisladas predijo nada en 90d-Coinalyze');
console.log('ni en años de klines — el problema no era el umbral de ninguna, era la premisa.');
