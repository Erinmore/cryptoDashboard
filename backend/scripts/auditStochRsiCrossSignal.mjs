#!/usr/bin/env node
/**
 * auditStochRsiCrossSignal.mjs — B3 (SESSION_STATE.md §10.1): ¿predice el CRUCE de StochRSI
 * (`oversold_cross_up` / `overbought_cross_down`) la dirección del precio a 24h, aislado?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT
 *
 * StochRSI solo se había probado MEZCLADO dentro del score de "ejecución" en
 * `auditDirectionalBias.mjs` (Fase 0, 03-08), que perdió contra el azar en 3/3 monedas. Se
 * usa `calculateStochRSI().signal` — la MISMA función y el MISMO campo que consume el prompt
 * en producción, no una reimplementación de la lógica de cruce. Mismo patrón que B1 (MACD) y
 * B2 (WaveTrend).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · `oversold_cross_up` (%K sale de zona <20 cruzando %D al alza) → el precio sube
 *       (fwdAtr > +0.5) más a menudo que la base incondicional de "sube".
 *  P2 · `overbought_cross_down` (%K sale de zona >80 cruzando %D a la baja) → el precio baja
 *       más a menudo que la base incondicional de "baja".
 *  P3 · Debe replicar en las 3 monedas con el IC de Wilson estrictamente separado de la base,
 *       n_ef>=30.
 *
 * CONTROL DE CÓDIGO (casi exacto, con una fuente de ruido documentada): StochRSI opera sobre
 * la serie RSI, y `auditComputeTrend.mjs` (2026-08-01) ya demostró al 100% que bajo la
 * reflexión LOCAL `p'=2A-p` (ganancia↔pérdida intercambiadas) `RSI'=100-RSI`. El estocástico
 * sobre esa serie usa min/max de una ventana: bajo `x'=100-x`, `min(x')=100-max(x)` y
 * `max(x')=100-min(x)`, así que el RANGO no cambia y `stochRaw'=100-stochRaw` — lineal, igual
 * que las SMA de %K/%D: `K'=100-K`, `D'=100-D`. Con umbrales SIMÉTRICOS respecto a 50
 * (`<20`/`>80`), la condición de `oversold_cross_up` sobre los valores reflejados es
 * EXACTAMENTE la de `overbought_cross_down` sobre los originales, y viceversa. ⚠️ En la
 * práctica sale ~99,97%, no 100,00% — depurado (ver commit): en anclas de SATURACIÓN extrema
 * (k≈99/d≈93, o sea `avgLoss`≈0 sostenido varias velas) el redondeo de punto flotante que se
 * acumula en la recursión de Wilder de `avgGain`/`avgLoss` (14 pasos) empuja `k>prevK` a un
 * lado en el original y al otro en el reflejo, justo en el borde de una desigualdad ESTRICTA
 * evaluada sobre valores que difieren en <1e-10 relativo. Es la MISMA familia de artefacto que
 * el boundary de redondeo cazado en B1 (MACD), pero aquí no hay redondeo explícito de por
 * medio — es precisión de punto flotante pura en una cadena recursiva de 14 pasos, no
 * corregible sin tocar `calculateStochRSI` (función de producción, fuera de alcance de un
 * script de auditoría). Umbral de aceptación: ≥99,9% (afecta a 1-3 anclas de ~6.800, ninguna
 * cambia el veredicto agregado).
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción, RSI 14 / Stoch 14 / smooth 3/3,
 * sin cambios de parámetros). Horizonte 6 velas (24h). Anclajes DISJUNTOS vía
 * `lib/disjointAnchors.mjs` (A8, por TIEMPO). Recorrido normalizado por ATR%×√6.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditStochRsiCrossSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditStochRsiCrossSignal.mjs
 */

import { calculateATRSeries, calculateStochRSI } from '../src/utils/indicators.js';
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

const FLIP = {
  oversold_cross_up: 'overbought_cross_down',
  overbought_cross_down: 'oversold_cross_up',
  oversold: 'overbought',
  overbought: 'oversold',
  neutral: 'neutral',
};

function signalAt(closes, i) {
  const start = Math.max(0, i - WIN + 1);
  const s = calculateStochRSI(closes.slice(start, i + 1));
  return s ? s.signal : null;
}

function build(candles) {
  const atrByIdx = new Map((calculateATRSeries(candles, 14) ?? []).map((e) => [e.idx, e.atr]));
  const closes = candles.map((c) => c.close);
  const rows = [];
  let mirrorTotal = 0, mirrorMatch = 0;

  for (let i = WIN; i + LOOKBACK < candles.length; i++) {
    const atr = atrByIdx.get(i);
    const price = candles[i].close;
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;

    const sig = signalAt(closes, i);
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
      const mCloses = mLocal.map((c) => c.close);
      const mSig = signalAt(mCloses, mIdx);
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
console.log('B3 · ¿PREDICE EL CRUCE DE STOCHRSI LA DIRECCIÓN A 24H? — años de klines, señal AISLADA');
console.log(`${DAYS} d objetivo · TF 4h · StochRSI 14/14/3/3 sobre ventana ${WIN} · horizonte ${LOOKBACK} velas (24h)`);
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

  const mirrorPct = mirrorTotal ? (mirrorMatch / mirrorTotal) * 100 : 0;
  console.log(`  CONTROL DE CÓDIGO (reflejo local): ${mirrorMatch}/${mirrorTotal} anclas`
    + ` (${mirrorTotal ? mirrorPct.toFixed(2) : '—'}%) con señal opuesta exacta`
    + `  ${mirrorPct >= 99.9 ? '✅ (≥99.9%, resto = saturación k/d ≈0/100, ver cabecera)' : '⚠️ revisar'}`);

  results.push({ coin, rBull, rBear });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿replica el cruce de StochRSI como señal direccional aislada en 24h?');
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
console.log('StochRSI aislado tiene poder predictivo real a 24h. Si no replica en las 3, o solo en una');
console.log('dirección, se archiva en el Bloque A junto al resto de "ejecución".');
