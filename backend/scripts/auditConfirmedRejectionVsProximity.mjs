#!/usr/bin/env node
/**
 * auditConfirmedRejectionVsProximity.mjs — C3 (propuesta original, 2026-07-27): ¿un RECHAZO
 * CONFIRMADO del nivel (mecha que lo atraviesa + cierre de vuelta) predice que aguanta mejor
 * que la mera CERCANÍA (precio cerca, sin haberlo tocado ni rebotado todavía)?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT Y EN QUÉ SE DIFERENCIA DE `auditLevelRejectionVsBreakout.mjs`
 *
 * Aquel script preguntó "¿el nº de TOQUES históricos del nivel predice si va a romperse?" y
 * la respuesta, con años de datos y control por distancia emparejada, fue NO — un nivel con
 * toques rompe exactamente igual que una línea sin toques a la misma distancia.
 *
 * Pero la propuesta ORIGINAL de C3 (anotada el 27-07, tras el episodio del veto en un soporte
 * de 5 toques que rompió y cayó −4,58%) no hablaba de contar toques pasados: hablaba de exigir
 * una señal de rechazo EN EL MOMENTO — mecha que atraviesa el nivel y vela que cierra de vuelta
 * dentro — en vez de conformarse con que el precio esté simplemente cerca. Es una hipótesis
 * distinta y más específica, y no se había medido hasta ahora.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · Si la propuesta de C3 tiene mérito, el grupo con RECHAZO CONFIRMADO reciente (mecha
 *       + cierre de vuelta en las últimas `REJECTION_LOOKBACK` velas) debe romper MENOS en el
 *       horizonte siguiente que el grupo de mera CERCANÍA (near, sin mecha de vuelta) — IC
 *       separados, cercanía por encima.
 *  P2 · Ambos grupos deben seguir sin distinguirse de sus respectivas líneas SINTÉTICAS a
 *       igual distancia SI el efecto (si existe) es "el rechazo confirmado es la señal real,
 *       no la distancia" — o sea, el control de `auditLevelRejectionVsBreakout.mjs` se repite
 *       aquí para no reintroducir el mismo error de emparejamiento.
 *  P3 · Debe replicar en soporte/resistencia y en las 3 monedas.
 *
 * CONTROL DE CÓDIGO: reflexión de precio (mismo patrón que el script hermano) — intercambia
 * soporte↔resistencia; sirve para detectar una asimetría en ESTE código, no en el mercado.
 *
 * MÉTODO: mismas ventanas (180 velas de 4h), mismo nivel S/R (tolerancia F2), mismo umbral de
 * cercanía (`dynamicNearLevelPct`) y mismo horizonte (6 velas/24h) que el script hermano — solo
 * cambia el CRITERIO DE ENTRADA. "Rechazo confirmado": en las últimas `REJECTION_LOOKBACK`
 * velas de la ventana, el precio penetró el nivel (low<nivel para soporte, high>nivel para
 * resistencia) Y la vela más reciente cierra de vuelta al lado seguro. "Mera cercanía": el
 * ancla pasa el filtro de `nearStrongLevel` pero NO muestra ese patrón.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditConfirmedRejectionVsProximity.mjs
 *       COINS=SOL DAYS=1000 REJECTION_LOOKBACK=3 node scripts/auditConfirmedRejectionVsProximity.mjs
 */

import { calculateATR, calculateSupportResistance } from '../src/utils/indicators.js';
import { nearStrongLevel, dynamicNearLevelPct } from '../src/utils/gating.js';
import { SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_ATR_MULT } from '../src/config/constants.js';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 1000);
const WIN = 180;
const HORIZON_CANDLES = 6;
const HORIZON_SEC = HORIZON_CANDLES * 4 * 3600;
const STRIDE = 6;
const MIN_N = 15;
// Cuántas velas atrás se mira para detectar la mecha de rechazo. 3 velas de 4h = 12h: una
// ventana corta a propósito — un rechazo de hace 3 días ya no describe el estado ACTUAL.
const REJECTION_LOOKBACK = Number(process.env.REJECTION_LOOKBACK ?? 3);

async function klines(coin, days) {
  const out = [];
  let end = Date.now();
  for (let g = 0; g < 20; g++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=4h&limit=1000&endTime=${end}`);
    if (!r.ok) throw new Error(`Binance ${coin}: HTTP ${r.status}`);
    const b = (await r.json()).map((x) => ({
      t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
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
  }));
}

/**
 * Para cada ancla con nivel cercano aceptado, clasifica en 'rejection' (mecha reciente +
 * cierre de vuelta) o 'proximity' (cerca, sin ese patrón), y calcula el resultado real +
 * el de una sintética a la misma distancia (mismo control que el script hermano).
 */
function scanSide(all, side) {
  const rejection = [], proximity = [];
  const rejectionSynth = [], proximitySynth = [];

  for (let end = WIN; end + HORIZON_CANDLES < all.length; end++) {
    const w = all.slice(end - WIN, end);
    const price = w.at(-1).close;
    const atr = calculateATR(w);
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    const tol = (SR_TOLERANCE_ATR_MULT * atrPct) / 100;
    const sr = calculateSupportResistance(w, SR_LOOKBACK, SR_MIN_TOUCHES, tol);
    const levels = side === 'support' ? sr.supports : sr.resistances;
    const nearPct = dynamicNearLevelPct(atrPct, '4h');
    const near = nearStrongLevel(levels, price, SR_MIN_TOUCHES, nearPct);
    if (!near.found) continue;

    const level = near.level.price;
    const recent = w.slice(-REJECTION_LOOKBACK);
    // Rechazo confirmado: alguna vela reciente penetró el nivel Y la ÚLTIMA cierra de vuelta.
    const penetrated = side === 'support'
      ? recent.some((c) => c.low < level)
      : recent.some((c) => c.high > level);
    const closedBackSafe = side === 'support' ? price > level : price < level; // siempre cierto si `near`
    const isRejection = penetrated && closedBackSafe;

    const future = all.slice(end, end + HORIZON_CANDLES);
    const t = Math.floor(w.at(-1).t / 1000);
    const brokeReal = side === 'support'
      ? future.some((c) => c.close < level)
      : future.some((c) => c.close > level);
    const synthLevel = side === 'support'
      ? price * (1 - near.distance_pct / 100)
      : price * (1 + near.distance_pct / 100);
    const brokeSynth = side === 'support'
      ? future.some((c) => c.close < synthLevel)
      : future.some((c) => c.close > synthLevel);

    const bucket = isRejection ? rejection : proximity;
    const bucketSynth = isRejection ? rejectionSynth : proximitySynth;
    bucket.push({ t, broke: brokeReal });
    bucketSynth.push({ t, broke: brokeSynth });
  }
  return { rejection, proximity, rejectionSynth, proximitySynth };
}

console.log('═'.repeat(96));
console.log('C3 (propuesta original) · ¿RECHAZO CONFIRMADO aguanta más que MERA CERCANÍA?');
console.log(`${DAYS} d objetivo · TF 4h · horizonte ${HORIZON_CANDLES} velas (24h) · lookback rechazo=${REJECTION_LOOKBACK} velas`);
console.log('P1: rechazo confirmado rompe MENOS que cercanía (IC separados) · P2: cada grupo sigue');
console.log('indistinguible de su sintética a igual distancia · P3: replica en 3 monedas y 2 lados');
console.log('═'.repeat(96));

let sepCount = 0, cmpCount = 0, rejectionBreaksMoreCount = 0, proximityBreaksMoreCount = 0;
let mirrorTotal = 0, mirrorOk = 0;

for (const coin of COINS) {
  let raw;
  try { raw = await klines(coin, DAYS); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (raw.length < WIN + HORIZON_CANDLES + 20) { console.log(`${coin}: histórico insuficiente`); continue; }
  console.log(`\n${'─'.repeat(96)}\n${coin} — ${raw.length} velas de 4h`);

  for (const side of ['support', 'resistance']) {
    const { rejection, proximity, rejectionSynth, proximitySynth } = scanSide(raw, side);
    const rRej = disjointRate(rejection, (r) => r.broke, { horizonSec: HORIZON_SEC, stride: STRIDE });
    const rProx = disjointRate(proximity, (r) => r.broke, { horizonSec: HORIZON_SEC, stride: STRIDE });
    const label = side === 'support' ? 'SOPORTE' : 'RESISTENCIA';
    console.log(`  ${label} (n rechazo=${rejection.length}, n cercanía=${proximity.length})`);

    if (rRej && rRej.n_eff >= MIN_N && rProx && rProx.n_eff >= MIN_N) {
      cmpCount++;
      const v = verdictCI(rRej, rProx);
      if (v.separated) {
        sepCount++;
        if (v.side === 'above') rejectionBreaksMoreCount++; else proximityBreaksMoreCount++;
      }
      console.log(`    rechazo confirmado: ruptura=${rRej.point.toFixed(1)}%  IC[${rRej.low.toFixed(1)}-${rRej.high.toFixed(1)}]  n_ef=${rRej.n_eff}`);
      console.log(`    mera cercanía:      ruptura=${rProx.point.toFixed(1)}%  IC[${rProx.low.toFixed(1)}-${rProx.high.toFixed(1)}]  n_ef=${rProx.n_eff}`);
      // verdictCI(rRej, rProx): side='above' → rRej > rProx (el rechazo rompe MÁS que la
      // cercanía, al revés de la hipótesis P1). side='below' → rRej < rProx (el rechazo
      // sostiene mejor, como predecía la propuesta original de C3).
      console.log(`    → ${v.separated ? `SEPARADOS (${v.side === 'above' ? 'el RECHAZO rompe MÁS que la cercanía: al revés de lo esperado' : 'la cercanía rompe más: el rechazo SÍ sostiene, como predecía C3'})` : 'IC se solapan — indistinguibles'}`);
    } else {
      console.log(`    ⚠ muestra insuficiente (rechazo n_ef=${rRej?.n_eff ?? 0}, cercanía n_ef=${rProx?.n_eff ?? 0}) — sin veredicto`);
    }

    // Control por distancia dentro de cada grupo (mismo control que el script hermano).
    const rRejSynth = disjointRate(rejectionSynth, (r) => r.broke, { horizonSec: HORIZON_SEC, stride: STRIDE });
    const rProxSynth = disjointRate(proximitySynth, (r) => r.broke, { horizonSec: HORIZON_SEC, stride: STRIDE });
    if (rRej && rRejSynth && rRej.n_eff >= MIN_N) {
      const v = verdictCI(rRej, rRejSynth);
      console.log(`    (rechazo vs su sintética a igual distancia: ${v.separated ? 'SEPARADOS' : 'indistinguibles'})`);
    }
    if (rProx && rProxSynth && rProx.n_eff >= MIN_N) {
      const v = verdictCI(rProx, rProxSynth);
      console.log(`    (cercanía vs su sintética a igual distancia: ${v.separated ? 'SEPARADOS' : 'indistinguibles'})`);
    }
  }

  const mirrored = mirror(raw);
  const supOrig = scanSide(raw, 'support');
  const resMirror = scanSide(mirrored, 'resistance');
  const allOrig = [...supOrig.rejection, ...supOrig.proximity];
  const allMirror = [...resMirror.rejection, ...resMirror.proximity];
  const rOrig = allOrig.length ? allOrig.filter((a) => a.broke).length / allOrig.length : null;
  const rMir = allMirror.length ? allMirror.filter((a) => a.broke).length / allMirror.length : null;
  if (rOrig != null && rMir != null) {
    mirrorTotal++;
    const close = Math.abs(rOrig - rMir) < 0.05;
    if (close) mirrorOk++;
    console.log(`  CONTROL DE CÓDIGO (reflexión): soporte real ${(rOrig * 100).toFixed(1)}% vs `
      + `resistencia-de-reflejado ${(rMir * 100).toFixed(1)}%  ${close ? '✅' : '⚠️ revisar'}`);
  }
}

console.log(`\n${'═'.repeat(96)}`);
console.log(`VEREDICTO: ${sepCount} de ${cmpCount} combinaciones (lado × moneda) separan rechazo de cercanía.`);
console.log(`  De ellas: ${rejectionBreaksMoreCount} con el RECHAZO rompiendo más (al revés de C3) · `
  + `${proximityBreaksMoreCount} con la CERCANÍA rompiendo más (como predecía C3).`);
console.log(`Control de reflexión: ${mirrorOk}/${mirrorTotal} monedas dentro de margen.`);
console.log('\nLECTURA: si la mayoría separa con la cercanía rompiendo MÁS, la propuesta original de C3');
console.log('(exigir rechazo confirmado en vez de mera cercanía) tiene base real. Si la mayoría separa');
console.log('con el RECHAZO rompiendo más, es la señal contraria: una mecha que ya perforó el nivel');
console.log('avisa de ruptura, no de que vaya a aguantar — y ninguna definición de "cerca" probada');
console.log('hasta ahora (toques, distancia, rechazo reciente) sostiene la hipótesis original de C3.');
