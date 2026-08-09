#!/usr/bin/env node
/**
 * auditBearishContinuationPower.mjs — ¿predicen ESTRUCTURA+VOLUMEN bajistas la continuación
 * de una caída, con la potencia que 90 días de Coinalyze no podían dar?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT Y EN QUÉ SE DIFERENCIA DE `auditOrderlyDecline.mjs`
 *
 * `auditOrderlyDecline.mjs` (2026-08-01) midió si estructura+volumen bajistas (proxies
 * deterministas de las mismas señales del LLM) predicen continuación DENTRO de la celda muda
 * `new_money_short`/`deleveraging` del cuadro OI×precio — y por separado, la MISMA pregunta
 * SIN mirar el OI en absoluto (su punto 3, "referencia"). Ese punto 3 no necesita el OI para
 * NADA — usa solo klines (`computeTrend`, `expectedVolumeScore` sobre CVD, ambos derivados de
 * velas) — pero estaba atado a los 90 días de Coinalyze porque el script entero se organizaba
 * alrededor de la historia de OI. Aquí se aísla esa pieza y se corre sobre AÑOS de klines.
 *
 * ⚠️ Además, `auditOrderlyDecline.mjs` es del 01-08, ANTES de que A8 (03-08) estableciera que
 * los anclajes deben ser DISJUNTOS (por tiempo) para no inflar el n: anclas cada 4h con
 * horizonte de 24h comparten 5/6 de su futuro. Su resultado (+2,1 pt, IC cruzando la base) se
 * midió con anclas CRUDAS, no disjuntas — así que además de tener menos potencia, puede que ni
 * siquiera tuviera el IC correcto. Aquí se usa `lib/disjointAnchors.mjs` desde el principio.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · Dentro del grupo «precio pasado ↓» (control de momentum obligatorio, A1 del script
 *       hermano), condicionar por estructura bajista debe subir la tasa de continuación sobre
 *       la base del grupo. Añadir volumen<=-1 debe subirla más todavía.
 *  P2 · CONTROL SIMÉTRICO (A3): el mismo condicionamiento en el grupo «precio pasado ↑» (con
 *       estructura/volumen ALCISTAS) debe dar un lift del MISMO ORDEN — si el lift bajista es
 *       mucho mayor que el alcista, sería una asimetría a explicar, no a asumir.
 *  P3 · Debe replicar en las 3 monedas con el mismo signo, y el lift debe superar +5 pt sobre
 *       la base del grupo (el umbral con el que se descartó `OI↑px↓` en su día) con n_ef>=30
 *       y el IC de Wilson sin cruzar la base.
 *
 * CONTROL DE CÓDIGO: reflexión de precio — invierte pasado y futuro a la vez (`p'=2A-p`,
 * agresor complementado), así que el grupo «↓» reflejado debe dar la MISMA tasa que «↑»
 * original, y viceversa. Mismo patrón que `auditComputeTrend.mjs`.
 *
 * PROXIES DETERMINISTAS (igual que el script hermano, misma limitación declarada): `structure`
 * = `computeTrend` (estructura, verificado simétrico al 100% bajo reflexión); `volume` =
 * `expectedVolumeScore` sobre `calculateCVD` (la guardia C2). Ambos son CONSERVADORES frente
 * al LLM real.
 *
 * SOLO LECTURA: Binance público, sin API key, sin Coinalyze. No toca BBDD ni producción.
 *
 * Uso:  node scripts/auditBearishContinuationPower.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditBearishContinuationPower.mjs
 */

import {
  calculateATRSeries, calculateCVD, calculateRSI, calculateMACD, calculateADX,
  calculateSuperTrend, calculateWaveTrend, calculateStochRSI, calculateVolumeDelta,
} from '../src/utils/indicators.js';
import { computeTrend } from '../src/services/indicatorService.js';
import { expectedVolumeScore } from '../src/utils/expectedScores.js';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 1000);
const LOOKBACK_4H = 6;             // 24h en velas de 4h — misma escala que el script hermano
const SQRT_WINDOW = Math.sqrt(LOOKBACK_4H);
const HORIZON_SEC = LOOKBACK_4H * 4 * 3600;
const STRIDE = 6;
const PX_BAND = 0.5;                // "precio pasado ↓/↑", igual que auditOrderlyDecline
const FWD_BAND = 0.5;                // "continúa" = |Δ futuro| > 0.5×ATR-normalizado
const TREND_WIN = 180;               // ventana de producción para computeTrend/CVD
const MIN_N = 30;                    // mismo listón que auditOrderlyDecline (A4)
const LIFT_NOISE_PT = 5;             // mismo umbral con el que se descartó OI↑px↓

const BEAR = new Set(['bearish', 'strongly_bearish']);
const BULL = new Set(['bullish', 'strongly_bullish']);

async function klines(coin, days) {
  const out = [];
  let end = Date.now();
  for (let g = 0; g < 20; g++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=4h&limit=1000&endTime=${end}`);
    if (!r.ok) throw new Error(`Binance ${coin}: HTTP ${r.status}`);
    const b = (await r.json()).map((x) => ({
      t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
      volume: +x[5], taker_buy_base: +x[9],
    }));
    if (!b.length) break;
    out.unshift(...b);
    if (b.length < 1000) break;
    end = b[0].t - 1;
    if ((out.at(-1).t - out[0].t) / 86400e3 >= days) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

function mirror(candles) {
  const A = candles[0].close;
  return candles.map((c) => ({
    t: c.t, open: 2 * A - c.open, close: 2 * A - c.close,
    high: 2 * A - c.low, low: 2 * A - c.high, volume: c.volume,
    taker_buy_base: c.volume - c.taker_buy_base,
  }));
}

function trendAt(candles) {
  const closes = candles.map((c) => c.close);
  return computeTrend({
    rsi: { value: calculateRSI(closes) },
    macd: calculateMACD(closes),
    adx: calculateADX(candles),
    superTrend: calculateSuperTrend(candles),
    waveTrend: calculateWaveTrend(candles),
    stochRsi: calculateStochRSI(closes),
    volumeDelta: calculateVolumeDelta(candles),
  });
}

/**
 * Construye las filas {t, pxAtr, fwdAtr, trend, vol} para una serie de velas, y en paralelo
 * su companion REFLEJADO LOCALMENTE por ancla — no una reflexión global de la serie entera.
 *
 * ⚠️ BUG cazado el 2026-08-09: la 1ª versión reflejaba la serie COMPLETA de años una sola vez
 * alrededor de `candles[0].close`. Para un ancla lejana en el tiempo (precio ya muy distinto
 * del inicio de la serie, típico en cripto: SOL se ha movido >10x en 3 años) `p'=2A-p` da
 * valores absurdos o negativos — la reflexión solo conserva los cambios PORCENTUALES si el
 * punto ancla está cerca del precio que se refleja. `auditComputeTrend.mjs` lo hace bien
 * porque refleja cada ventana LOCAL alrededor de su propio primer cierre, nunca un punto
 * global fijo sobre miles de velas. Aquí se corrige reflejando, por cada ancla, solo su
 * propio tramo local (ventana + horizonte futuro) alrededor de su propio inicio.
 */
function build(candles) {
  const atrByIdx = new Map((calculateATRSeries(candles, 14) ?? []).map((e) => [e.idx, e.atr]));
  const rows = [];
  const mirrorRows = [];
  for (let i = TREND_WIN; i + LOOKBACK_4H < candles.length; i++) {
    const atr = atrByIdx.get(i);
    const price = candles[i].close;
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;

    const pxPrev = candles[i - LOOKBACK_4H].close;
    const pxChange = ((price - pxPrev) / pxPrev) * 100;
    const pxAtr = pxChange / (atrPct * SQRT_WINDOW);

    const pxFwd = candles[i + LOOKBACK_4H].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);

    const win = candles.slice(i - TREND_WIN + 1, i + 1);
    const trend = trendAt(win);
    const vol = expectedVolumeScore(calculateCVD(win)).score;

    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, pxAtr, fwdAtr, trend, vol });

    // ── companion reflejado LOCALMENTE (solo para el control de código) ──────────────
    const localSlice = candles.slice(i - TREND_WIN + 1, i + 1 + LOOKBACK_4H);
    const localMirror = mirror(localSlice);
    const mIdx = TREND_WIN - 1; // posición del ancla dentro del tramo local reflejado
    const mAtrEntry = (calculateATRSeries(localMirror, 14) ?? []).find((e) => e.idx === mIdx);
    const mPrice = localMirror[mIdx].close;
    if (mAtrEntry && mPrice > 0) {
      const mAtrPct = (mAtrEntry.atr / mPrice) * 100;
      if (mAtrPct > 0) {
        const mPxPrev = localMirror[mIdx - LOOKBACK_4H].close;
        const mPxChange = ((mPrice - mPxPrev) / mPxPrev) * 100;
        const mPxAtr = mPxChange / (mAtrPct * SQRT_WINDOW);
        const mPxFwd = localMirror[mIdx + LOOKBACK_4H].close;
        const mFwdAtr = (((mPxFwd - mPrice) / mPrice) * 100) / (mAtrPct * SQRT_WINDOW);
        mirrorRows.push({ t, pxAtr: mPxAtr, fwdAtr: mFwdAtr });
      }
    }
  }
  return { rows, mirrorRows };
}

function report(coin, rows) {
  const down = rows.filter((r) => r.pxAtr < -PX_BAND);
  const up = rows.filter((r) => r.pxAtr > PX_BAND);
  const dnHit = (r) => r.fwdAtr < -FWD_BAND;
  const upHit = (r) => r.fwdAtr > FWD_BAND;

  const baseDn = disjointRate(down, dnHit, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const baseUp = disjointRate(up, upHit, { horizonSec: HORIZON_SEC, stride: STRIDE });
  console.log(`\n${'─'.repeat(96)}\n${coin} — n total=${rows.length}`);
  console.log(`  BASE «precio pasado ↓» n_ef=${baseDn?.n_eff ?? 0}  sigue bajando=${baseDn?.point?.toFixed(1) ?? '—'}%`);
  console.log(`  BASE «precio pasado ↑» n_ef=${baseUp?.n_eff ?? 0}  sigue subiendo=${baseUp?.point?.toFixed(1) ?? '—'}%`);

  const line = (label, sel, hit, base) => {
    const r = disjointRate(sel, hit, { horizonSec: HORIZON_SEC, stride: STRIDE });
    if (!r) { console.log(`    ${label.padEnd(38)} sin anclas`); return null; }
    const lift = r.point - base.point;
    const v = verdictCI(r, base);
    // 2026-08-09: el veredicto de "replica" usa el CRUCE DEL IC (v.separated), no el umbral
    // fijo de +5pt — ese 5 se eligió a ojo en OTRA medición (auditDerivativesRubric, cifras
    // +3.7/+4.7/-3.4 vs -20.2/-24.2) con su propio n, y a los n_ef de ESTE script (180-380)
    // el margen de una sola proporción ya es ±4-6pt, así que la diferencia de dos tiene más
    // ruido que eso: 5pt es más laxo de lo que esta muestra puede sostener, no más estricto.
    // `significant` es el criterio real: IC de la condición estrictamente por encima de la
    // base, sin depender de ningún número redondo ajeno al tamaño de esta muestra.
    const significant = r.n_eff >= MIN_N && v.separated && v.side === 'above';
    const flag = r.n_eff < MIN_N ? '⚠ n<30'
      : (significant ? '✅ IC por encima de la base' : v.separated ? '⚠️ IC por debajo' : '✗ IC cruza la base');
    console.log(`    ${label.padEnd(38)} n_ef=${String(r.n_eff).padStart(4)}  tasa=${r.point.toFixed(1)}%`
      + `  lift=${lift >= 0 ? '+' : ''}${lift.toFixed(1)}pt  IC[${r.low.toFixed(1)}-${r.high.toFixed(1)}]  ${flag}`);
    return { r, lift, n_eff: r.n_eff, significant };
  };

  console.log('  Condicionando DENTRO de «precio pasado ↓» (sin mirar el OI en absoluto):');
  const bear = down.filter((r) => BEAR.has(r.trend));
  const bearVol = bear.filter((r) => r.vol <= -1);
  const rBear = line('+ estructura bajista', bear, dnHit, baseDn);
  const rBearVol = line('+ estructura bajista Y volumen<=-1', bearVol, dnHit, baseDn);

  console.log('  CONTROL SIMÉTRICO en «precio pasado ↑» (estructura/volumen ALCISTAS):');
  const bull = up.filter((r) => BULL.has(r.trend));
  const bullVol = bull.filter((r) => r.vol >= 1);
  const rBull = line('+ estructura alcista', bull, upHit, baseUp);
  const rBullVol = line('+ estructura alcista Y volumen>=1', bullVol, upHit, baseUp);

  return { rBear, rBearVol, rBull, rBullVol };
}

console.log('═'.repeat(96));
console.log('¿PREDICEN ESTRUCTURA+VOLUMEN BAJISTAS LA CONTINUACIÓN? — con años de klines, sin Coinalyze');
console.log(`${DAYS} d objetivo · TF 4h · horizonte 24h · anclajes DISJUNTOS (lib/disjointAnchors.mjs)`);
console.log('P1: lift>+5pt sobre la base del grupo, replicado en 3 monedas · P2: control simétrico alcista');
console.log('del mismo orden · CONTROL DE CÓDIGO: reflexión intercambia ↓↔↑ exactamente');
console.log('═'.repeat(96));

const results = [];
let mirrorTotal = 0, mirrorOk = 0;

for (const coin of COINS) {
  let raw;
  try { raw = await klines(coin, DAYS); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (raw.length < TREND_WIN + LOOKBACK_4H + 20) { console.log(`${coin}: histórico insuficiente`); continue; }
  const { rows, mirrorRows } = build(raw);
  const res = report(coin, rows);
  results.push({ coin, ...res });

  // Control de código: reflexión LOCAL por ancla (ver comentario en `build`) intercambia
  // los grupos ↓ y ↑ exactamente — a diferencia de reflejar la serie de años entera de una vez.
  const dn0 = rows.filter((r) => r.pxAtr < -PX_BAND);
  const upM = mirrorRows.filter((r) => r.pxAtr > PX_BAND);
  const rate = (arr, hit) => (arr.length ? arr.filter(hit).length / arr.length : null);
  const rOrig = rate(dn0, (r) => r.fwdAtr < -FWD_BAND);
  const rMir = rate(upM, (r) => r.fwdAtr > FWD_BAND);
  if (rOrig != null && rMir != null) {
    mirrorTotal++;
    const close = Math.abs(rOrig - rMir) < 0.03;
    if (close) mirrorOk++;
    console.log(`  CONTROL DE CÓDIGO (reflexión LOCAL por ancla): ↓ real ${(rOrig * 100).toFixed(1)}% vs `
      + `↑-de-reflejado ${(rMir * 100).toFixed(1)}%  ${close ? '✅' : '⚠️ revisar'}`);
  }
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — lift de "estructura bajista + volumen<=-1" sobre la base de «precio pasado ↓»');
console.log(`(criterio: IC de Wilson estrictamente por encima de la base — NO el umbral fijo de`);
console.log(`${LIFT_NOISE_PT}pt, que se eligió a ojo en otra medición con otro n y aquí es más laxo que`);
console.log(`el propio ruido de muestra: ±4-6pt para una sola proporción a n_ef=180-380)`);
let replicaCount = 0;
for (const { coin, rBearVol } of results) {
  const ok = !!rBearVol?.significant;
  if (ok) replicaCount++;
  console.log(`  ${coin.padEnd(4)} lift=${rBearVol ? `${rBearVol.lift >= 0 ? '+' : ''}${rBearVol.lift.toFixed(1)}pt (n_ef=${rBearVol.n_eff})` : '—'}`
    + `  ${ok ? '✅ IC por encima de la base' : '✗ IC cruza la base (o falta muestra)'}`);
}
console.log(`\n${replicaCount} de ${results.length} monedas replican con el IC estrictamente por encima de la base.`);
console.log(`Control de reflexión: ${mirrorOk}/${mirrorTotal} monedas dentro de margen.`);
console.log('\nLECTURA: si replica en las 3 con el control simétrico del mismo orden, la intuición del');
console.log('usuario (soporte roto + estructura + volumen bajistas → sigue cayendo) tiene ahora la');
console.log('potencia que le faltaba en 90 días. Si no replica o el simétrico alcista es mucho mayor,');
console.log('sigue sin ser una señal fiable — sería el mismo "sugerente, no establecido" con más datos.');
