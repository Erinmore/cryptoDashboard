#!/usr/bin/env node
/**
 * auditFvgMagnetSignal.mjs — B9 (SESSION_STATE.md §10.1, = pregunta D2 del backlog §6.4,
 * abierta desde hace semanas): ¿es un FVG no mitigado un IMÁN — el precio se mueve HACIA él
 * más a menudo que la base, en las 24h siguientes?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT
 *
 * La teoría SMC clásica dice que un "fair value gap" sin rellenar atrae al precio de vuelta.
 * El propio código lo declara así (`smc.js:321`, `FVG_MITIGATION_EXPIRED = 70 // mitigation_pct
 * > 70 → sin fuerza magnética`) pero nunca se ha medido si esa "fuerza magnética" existe.
 * Se usa `calculateSMC` (función real, con `signal_status` ya calculado — `active`/`context`/
 * `expired`, decay real por TF) sobre el FVG NO EXPIRADO más cercano al precio, combinando
 * bullish y bearish (el imán no tiene bando: lo que importa es si está por encima o por
 * debajo del precio actual, no si se formó en una subida o una bajada).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · El FVG no expirado más cercano está POR DEBAJO del precio → el precio baja (fwdAtr <
 *       -0.5, hacia el imán) más a menudo que la base incondicional de "baja".
 *  P2 · El FVG más cercano está POR ENCIMA → el precio sube (hacia el imán) más que la base.
 *  P3 · Debe replicar en las 3 monedas con el IC de Wilson estrictamente separado, n_ef>=30.
 *
 * CONTROL DE CÓDIGO: AGREGADO por tolerancia (mismo motivo que B4/B5 — la posición del FVG
 * relativa al precio es un porcentaje con denominador afín bajo la reflexión local, no una
 * negación exacta). Bajo `p'=2A-p`, un FVG bullish (`right.low>left.high`) se convierte en un
 * FVG bearish en los datos reflejados (`right.low'=2A-right.high`, `left.high'=2A-left.low` →
 * la condición se invierte exactamente a `right.high<left.low`, la definición bearish) —
 * mismo argumento que soporte↔resistencia en `auditLevelRejectionVsBreakout.mjs`. Se compara
 * la tasa agregada "imán abajo → baja" en los datos reales contra "imán arriba → sube" en el
 * reflejo local.
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción; `detectUnmitigatedFVGs` usa su
 * propio `windowBars=100` internamente sin cambios). Horizonte 6 velas (24h). Anclajes
 * DISJUNTOS vía `lib/disjointAnchors.mjs`.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditFvgMagnetSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditFvgMagnetSignal.mjs
 */

import { calculateATRSeries } from '../src/utils/indicators.js';
import { calculateSMC } from '../src/utils/smc.js';
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

/** FVG no expirado más cercano al precio: 'below' (imán abajo) / 'above' (imán arriba) / null. */
function nearestMagnetAt(candles, i) {
  const start = Math.max(0, i - WIN + 1);
  const smc = calculateSMC(candles.slice(start, i + 1), { timeframe: '4h' });
  if (!smc?.unmitigated_fvgs) return null;
  const price = candles[i].close;
  const all = [...(smc.unmitigated_fvgs.bullish ?? []), ...(smc.unmitigated_fvgs.bearish ?? [])]
    .filter((f) => f.signal_status !== 'expired');
  let best = null;
  for (const f of all) {
    let dist, dir;
    if (price > f.high) { dist = (price - f.high) / price * 100; dir = 'below'; }
    else if (price < f.low) { dist = (f.low - price) / price * 100; dir = 'above'; }
    else continue; // precio DENTRO de la zona — ya está en el imán, sin dirección que predecir
    if (best == null || dist < best.dist) best = { dist, dir };
  }
  return best ? best.dir : null;
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

    const dir = nearestMagnetAt(candles, i);
    if (dir == null) continue;

    const pxFwd = candles[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, dir, fwdAtr });

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
          const mDir = nearestMagnetAt(mLocal, mIdx);
          if (mDir != null) {
            const mPxFwd = mLocal[mIdx + LOOKBACK].close;
            const mFwdAtr = (((mPxFwd - mPrice) / mPrice) * 100) / (mAtrPct * SQRT_WINDOW);
            mirrorRows.push({ t, dir: mDir, fwdAtr: mFwdAtr });
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
console.log('B9 · ¿ES UN FVG NO MITIGADO UN IMÁN A 24H? — D2 del backlog, años de klines, señal AISLADA');
console.log(`${DAYS} d objetivo · TF 4h · calculateSMC (FVG no expirado más cercano) sobre ventana ${WIN} · horizonte ${LOOKBACK} velas`);
console.log('P1: imán abajo → baja más que la base · P2: imán arriba → sube más que la base');
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
  console.log(`  BASE incondicional (sobre anclas con imán)  sube=${baseUp?.point?.toFixed(1) ?? '—'}%  baja=${baseDn?.point?.toFixed(1) ?? '—'}%  (n_ef=${baseUp?.n_eff ?? 0}/${baseDn?.n_eff ?? 0})`);

  const below = rows.filter((r) => r.dir === 'below');
  const above = rows.filter((r) => r.dir === 'above');
  console.log(`  imán: below=${below.length}  above=${above.length}`);
  console.log('  imán below → ¿baja?:');
  const rBelow = line('imán below → baja', below, dnHit, baseDn);
  console.log('  imán above → ¿sube?:');
  const rAbove = line('imán above → sube', above, upHit, baseUp);

  // ── control de código: AGREGADO, tolerancia ───────────────────────────────────────────
  const belowOrig = rows.filter((r) => r.dir === 'below');
  const aboveMirror = mirrorRows.filter((r) => r.dir === 'above');
  const rate = (arr, hit) => (arr.length ? arr.filter(hit).length / arr.length : null);
  const rOrig = rate(belowOrig, dnHit);
  const rMir = rate(aboveMirror, upHit);
  if (rOrig != null && rMir != null) {
    mirrorTotalAll++;
    const close = Math.abs(rOrig - rMir) < 0.05;
    if (close) mirrorOkAll++;
    console.log(`  CONTROL DE CÓDIGO (reflejo local, agregado): below-real ${(rOrig * 100).toFixed(1)}% vs `
      + `above-de-reflejado ${(rMir * 100).toFixed(1)}%  ${close ? '✅' : '⚠️ revisar'}`);
  }

  results.push({ coin, rBelow, rAbove });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿replica el FVG como imán con potencia medible en 24h? (respuesta a D2)');
let belowOk = 0, aboveOk = 0;
for (const { coin, rBelow, rAbove } of results) {
  const okBelow = !!rBelow?.significant;
  const okAbove = !!rAbove?.significant;
  if (okBelow) belowOk++;
  if (okAbove) aboveOk++;
  console.log(`  ${coin.padEnd(4)} below→baja: ${rBelow ? `${rBelow.lift >= 0 ? '+' : ''}${rBelow.lift.toFixed(1)}pt (n_ef=${rBelow.n_eff})` : '—'} ${okBelow ? '✅' : '✗'}`
    + `   above→sube: ${rAbove ? `${rAbove.lift >= 0 ? '+' : ''}${rAbove.lift.toFixed(1)}pt (n_ef=${rAbove.n_eff})` : '—'} ${okAbove ? '✅' : '✗'}`);
}
console.log(`\n${belowOk} de ${results.length} monedas: imán below→baja separa por encima de la base.`);
console.log(`${aboveOk} de ${results.length} monedas: imán above→sube separa por encima de la base.`);
console.log(`Control de reflexión (agregado, tolerancia 5pp): ${mirrorOkAll}/${mirrorTotalAll} monedas dentro de margen.`);
console.log('\nLECTURA: si las 3 monedas replican en AMBAS direcciones con el IC separado, el FVG SÍ es');
console.log('un imán medible — respuesta GO a D2. Si no replica, D2 se cierra NO-GO junto al resto del');
console.log('Bloque B: "fuerza magnética" declarada en el código pero sin potencia medible en 24h.');
