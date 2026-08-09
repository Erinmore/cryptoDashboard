#!/usr/bin/env node
/**
 * auditWaveTrendCrossSignal.mjs — B2 (SESSION_STATE.md §10.1): ¿predice el CRUCE de WaveTrend
 * (`oversold_cross_up` / `overbought_cross_down`) la dirección del precio a 24h, aislado?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT
 *
 * WaveTrend solo se había probado MEZCLADO dentro del score de "ejecución" (RSI+MACD+
 * WaveTrend+StochRSI) en `auditDirectionalBias.mjs` (Fase 0, 03-08), que perdió contra el
 * azar en 3/3 monedas. Se usa `calculateWaveTrend().signal` — la MISMA función y el MISMO
 * campo que consume el prompt en producción (`technical[tf].wave_trend.signal`), no una
 * reimplementación de la lógica de cruce.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · `oversold_cross_up` (reversión alcista clásica) → el precio sube (fwdAtr > +0.5) más
 *       a menudo que la tasa base incondicional de "sube".
 *  P2 · `overbought_cross_down` (reversión bajista) → el precio baja (fwdAtr < -0.5) más a
 *       menudo que la tasa base incondicional de "baja".
 *  P3 · Debe replicar en las 3 monedas con el IC de Wilson estrictamente separado de la base,
 *       n_ef>=30. Si no replica en las 3, es "no predice", no "predice poco".
 *
 * CONTROL DE CÓDIGO (exacto, no estadístico): bajo la reflexión LOCAL `p'=2A-p` (mismo patrón
 * que B1/`auditComputeTrend.mjs`), el precio típico `ap=(h+l+c)/3` es afín (`ap'=2A-ap`), y
 * `esa=EMA(ap,n1)` es lineal → `esa'=2A-esa`. La desviación `d=EMA(|ap-esa|,n1)` usa un valor
 * ABSOLUTO: `|ap'-esa'|=|-(ap-esa)|=|ap-esa|`, así que `d` NO cambia de signo (es una medida
 * de amplitud, no de dirección) — a diferencia de MACD, donde todo el pipeline es lineal sin
 * ningún `Math.abs`. Con `d'=d`, `ci=(ap-esa)/(0.015·d)` sí se niega exactamente (`ci'=-ci`),
 * y de ahí `tci`/`wt1`/`wt2` también (`EMA` es lineal): `wt1'=-wt1`, `wt2'=-wt2`. Con umbrales
 * SIMÉTRICOS (`WT_OVERSOLD=-60`, `WT_OVERBOUGHT=+60`), la condición de `oversold_cross_up`
 * sobre los valores reflejados es EXACTAMENTE la de `overbought_cross_down` sobre los
 * originales, y viceversa — la señal reflejada debe ser el tipo opuesto exacto en el 100% de
 * las anclas (`neutral`↔`neutral`, `oversold`↔`overbought`).
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción, `n1=10/n2=21` sin cambios).
 * Horizonte 6 velas (24h). Anclajes DISJUNTOS vía `lib/disjointAnchors.mjs` (A8, por TIEMPO).
 * Recorrido normalizado por ATR%×√6 — misma convención que B1/`auditBearishContinuationPower`.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditWaveTrendCrossSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditWaveTrendCrossSignal.mjs
 */

import { calculateATRSeries, calculateWaveTrend } from '../src/utils/indicators.js';
import { fetchKlines, mirrorCandles } from './lib/binanceKlines.mjs';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 1000);
const WIN = 180;                  // ventana de producción para WaveTrend (4h)
const LOOKBACK = 6;                // 24h en velas de 4h
const SQRT_WINDOW = Math.sqrt(LOOKBACK);
const HORIZON_SEC = LOOKBACK * 4 * 3600;
const STRIDE = 6;
const FWD_BAND = 0.5;
const MIN_N = 30;

const FLIP = {
  oversold_cross_up: 'overbought_cross_down',
  overbought_cross_down: 'oversold_cross_up',
  oversold: 'overbought',
  overbought: 'oversold',
  neutral: 'neutral',
};

function signalAt(candles, i) {
  const start = Math.max(0, i - WIN + 1);
  const w = calculateWaveTrend(candles.slice(start, i + 1));
  return w ? w.signal : null;
}

/**
 * Igual que en B1: un solo pase construye la fila real y, en paralelo, el reflejo LOCAL del
 * tramo [i-WIN+1, i+LOOKBACK] para el control de código — sin recorrer los años dos veces.
 */
function build(candles) {
  const atrByIdx = new Map((calculateATRSeries(candles, 14) ?? []).map((e) => [e.idx, e.atr]));
  const rows = [];
  let mirrorTotal = 0, mirrorMatch = 0;

  for (let i = WIN; i + LOOKBACK < candles.length; i++) {
    const atr = atrByIdx.get(i);
    const price = candles[i].close;
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;

    const sig = signalAt(candles, i);
    if (sig == null) continue;

    const pxFwd = candles[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, sig, fwdAtr });

    // ── control de código: reflejo LOCAL del tramo [i-WIN+1, i+LOOKBACK] ────────────────
    const lo = i - WIN + 1;
    if (lo >= 0) {
      const localSlice = candles.slice(lo, i + 1 + LOOKBACK);
      const mLocal = mirrorCandles(localSlice, localSlice[0].close);
      const mIdx = i - lo;
      const mSig = signalAt(mLocal, mIdx);
      if (mSig != null) {
        mirrorTotal++;
        if (mSig === FLIP[sig]) mirrorMatch++;
      }
    }
  }
  return { rows, mirrorTotal, mirrorMatch };
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
console.log('B2 · ¿PREDICE EL CRUCE DE WAVETREND LA DIRECCIÓN A 24H? — años de klines, señal AISLADA');
console.log(`${DAYS} d objetivo · TF 4h · WaveTrend n1=10/n2=21 sobre ventana ${WIN} · horizonte ${LOOKBACK} velas (24h)`);
console.log('P1: oversold_cross_up → sube más que la base · P2: overbought_cross_down → baja más que la base');
console.log('P3: replica en 3 monedas, IC separado, n_ef>=30 · CONTROL: reflejo local = tipo opuesto exacto');
console.log('═'.repeat(96));

const results = [];
let mirrorTotalAll = 0, mirrorMatchAll = 0;

for (const coin of COINS) {
  let raw;
  try { raw = await fetchKlines(coin, DAYS); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (raw.length < WIN + LOOKBACK + 20) { console.log(`${coin}: histórico insuficiente`); continue; }
  const spanDays = ((raw.at(-1).t - raw[0].t) / 86400e3).toFixed(0);
  const { rows, mirrorTotal, mirrorMatch } = build(raw);
  mirrorTotalAll += mirrorTotal; mirrorMatchAll += mirrorMatch;

  const upHit = (r) => r.fwdAtr > FWD_BAND;
  const dnHit = (r) => r.fwdAtr < -FWD_BAND;
  const baseUp = disjointRate(rows, upHit, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const baseDn = disjointRate(rows, dnHit, { horizonSec: HORIZON_SEC, stride: STRIDE });

  console.log(`\n${'─'.repeat(96)}\n${coin} — ${raw.length} velas de 4h (${spanDays} días) · n anclas=${rows.length}`);
  console.log(`  BASE incondicional  sube=${baseUp?.point?.toFixed(1) ?? '—'}%  baja=${baseDn?.point?.toFixed(1) ?? '—'}%  (n_ef=${baseUp?.n_eff ?? 0}/${baseDn?.n_eff ?? 0})`);

  const bull = rows.filter((r) => r.sig === 'oversold_cross_up');
  const bear = rows.filter((r) => r.sig === 'overbought_cross_down');
  console.log(`  cruces: oversold_cross_up=${bull.length}  overbought_cross_down=${bear.length}  (${((bull.length + bear.length) / rows.length * 100).toFixed(1)}% de las anclas)`);
  console.log('  oversold_cross_up → ¿sube?:');
  const rBull = line('oversold_cross_up → sube', bull, upHit, baseUp);
  console.log('  overbought_cross_down → ¿baja?:');
  const rBear = line('overbought_cross_down → baja', bear, dnHit, baseDn);

  console.log(`  CONTROL DE CÓDIGO (reflejo local, exacto): ${mirrorMatch}/${mirrorTotal} anclas`
    + ` (${mirrorTotal ? ((mirrorMatch / mirrorTotal) * 100).toFixed(2) : '—'}%) con señal opuesta exacta`
    + `  ${mirrorTotal && mirrorMatch === mirrorTotal ? '✅' : '⚠️ revisar'}`);

  results.push({ coin, rBull, rBear });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿replica el cruce de WaveTrend como señal direccional aislada en 24h?');
let bullOk = 0, bearOk = 0;
for (const { coin, rBull, rBear } of results) {
  const okBull = !!rBull?.significant;
  const okBear = !!rBear?.significant;
  if (okBull) bullOk++;
  if (okBear) bearOk++;
  console.log(`  ${coin.padEnd(4)} oversold_cross_up: ${rBull ? `${rBull.lift >= 0 ? '+' : ''}${rBull.lift.toFixed(1)}pt (n_ef=${rBull.n_eff})` : '—'} ${okBull ? '✅' : '✗'}`
    + `   overbought_cross_down: ${rBear ? `${rBear.lift >= 0 ? '+' : ''}${rBear.lift.toFixed(1)}pt (n_ef=${rBear.n_eff})` : '—'} ${okBear ? '✅' : '✗'}`);
}
console.log(`\n${bullOk} de ${results.length} monedas: oversold_cross_up separa por encima de la base.`);
console.log(`${bearOk} de ${results.length} monedas: overbought_cross_down separa por encima de la base.`);
console.log(`Control de reflexión global: ${mirrorMatchAll}/${mirrorTotalAll}`
  + ` (${mirrorTotalAll ? ((mirrorMatchAll / mirrorTotalAll) * 100).toFixed(2) : '—'}%).`);
console.log('\nLECTURA: si las 3 monedas replican en AMBAS direcciones con el IC separado, el cruce de');
console.log('WaveTrend aislado tiene poder predictivo real a 24h. Si no replica en las 3, o solo en una');
console.log('dirección, se archiva en el Bloque A junto al resto de "ejecución" — no predice, mezclado');
console.log('ni aislado.');
