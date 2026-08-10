#!/usr/bin/env node
/**
 * auditLevelRejectionVsBreakout.mjs — C3: ¿un nivel S/R con toques probados aguanta más
 * (rechazo) que una línea cualquiera a la misma distancia, o rompe (ruptura) igual?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT Y NO UNA REPETICIÓN DE `auditVetoFrequency.mjs`
 *
 * El veto completo (CVD 1D + OI + S/R) está acotado a los 90 días que sirve Coinalyze
 * (ventana rodante, sin tier de pago). Con el veto disparando ~8% del tiempo y exigiendo
 * anclajes DISJUNTOS (A8), el n efectivo cae a 7-8 por moneda — insuficiente para separar
 * el IC de su complemento (medido el 2026-08-03, veredicto "sugerente, no establecido").
 *
 * Pero la hipótesis de fondo (§0, C3) es puramente GEOMÉTRICA y no necesita el OI: *"un
 * nivel con toques probados, ¿aguanta más que una línea cualquiera a esa distancia?"*. Eso
 * se mide con velas de Binance — sin límite de Coinalyze, años en vez de 90 días — usando
 * las funciones REALES de producción: `calculateSupportResistance` (tolerancia F2, ya en
 * producción) y `nearStrongLevel`/`dynamicNearLevelPct` de `gating.js`.
 *
 * No reemplaza a `auditVetoFrequency.mjs` (esto no mide el veto compuesto, solo su pata de
 * S/R) pero SÍ da la potencia estadística que aquél no tenía.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ EL CONTROL QUE CAMBIÓ LA PREGUNTA (léase antes de fiarse de un solo número)
 *
 * La primera versión de este script comparaba SOLO cubos de toques (1-2 / 3-4 / 5+) y
 * encontraba que TODOS rompían más del 50% del tiempo, incluso el cubo más débil — un
 * resultado que parecía decir "todo se rompe siempre", sospechosamente plano.
 *
 * Un primer control nulo (línea sintética fija en el BORDE del umbral `nearPct`) dio 21-25%
 * de ruptura — muy por debajo de los niveles reales, que parecía confirmar que los niveles
 * "importan". Pero ese control estaba MAL EMPAREJADO: los niveles reales aceptados caen en
 * cualquier punto entre 0 y `nearPct` de distancia (normalmente más cerca que el borde), así
 * que por pura distancia iban a romperse más a menudo — el control comparaba dos cosas a
 * distancias distintas y la diferencia no decía nada sobre los TOQUES.
 *
 * **Control correcto: EMPAREJAR POR DISTANCIA.** Para cada ancla con un nivel real aceptado
 * a distancia D, se prueba una línea sintética a esa MISMA distancia D (sin exigir toques).
 * Resultado: la tasa de ruptura del nivel real y la de la línea sintética son
 * INDISTINGUIBLES (diferencia <0,1 pt en las 3 monedas, n>1.000 cada una). **Los toques no
 * aportan nada que la distancia por sí sola no explique ya.**
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR (para el control por distancia)
 *
 *  P1 · Si "toques" es información real (el veto tiene razón: nivel probado = aguanta), el
 *       nivel REAL debe romper MENOS que la sintética a igual distancia → IC separados, con
 *       la sintética por encima.
 *  P2 · Si "toques" es ruido y solo importa la distancia, los dos deben salir INDISTINGUIBLES.
 *  P3 · Debe replicar en soporte Y resistencia, y en las 3 monedas — si solo aparece en una
 *       combinación, es la moneda/lado, no el mercado.
 *
 * CONTROL DE CÓDIGO (no de mercado): reflexión de precio — reflejar el camino intercambia
 * soporte↔resistencia; la tasa agregada de "soporte real" debe igualar la de "resistencia
 * sobre datos reflejados". Si no coincide, hay una asimetría en ESTE script, no en el mercado.
 *
 * MÉTODO: ventanas de 180 velas de 4h (igual que producción). Ancla aceptada si el precio
 * está dentro de `dynamicNearLevelPct` de un nivel con `SR_MIN_TOUCHES`+ toques. Horizonte
 * fijo de 6 velas (24h, la escala habitual del veto). RUPTURA = cierre más allá del nivel
 * (real o sintético) en alguna de las 6 velas siguientes. Anclajes DISJUNTOS vía
 * `lib/disjointAnchors.mjs` (A8: por TIEMPO, no por posición) — mismo módulo que usa
 * `auditVetoFrequency.mjs`, no una copia.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditLevelRejectionVsBreakout.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditLevelRejectionVsBreakout.mjs
 */

import { calculateATR, calculateSupportResistance } from '../src/utils/indicators.js';
import { nearStrongLevel, dynamicNearLevelPct } from '../src/utils/gating.js';
import { SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_ATR_MULT } from '../src/config/constants.js';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 1000);       // ~2.7 años; sube con DAYS=1500 etc.
const WIN = 180;                  // SR_LOOKBACK de producción en velas de 4h
const HORIZON_CANDLES = 6;        // 24h a 4h — escala habitual del veto
const HORIZON_SEC = HORIZON_CANDLES * 4 * 3600;
const STRIDE = 6;                 // arranques de la cadena disjunta (mismo valor que otros scripts)
const MIN_N = 15;                 // guarda T4/auditPriceBand: bajo esto no es evidencia

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
    if (b.length < 1000) break;   // llegamos al origen del listado de Binance
    end = b[0].t - 1;
    if ((out.at(-1).t - out[0].t) / 86400e3 >= days) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Reflexión del camino: intercambia high/low (y por tanto soporte↔resistencia). */
function mirror(candles) {
  const A = candles[0].close;
  return candles.map((c) => ({
    t: c.t, open: 2 * A - c.open, close: 2 * A - c.close,
    high: 2 * A - c.low, low: 2 * A - c.high, volume: c.volume,
  }));
}

/**
 * Recorre `all` y devuelve, para cada ancla con un nivel real aceptado en el lado pedido,
 * el resultado REAL (rompió el nivel de verdad) y el SINTÉTICO (rompió una línea a la MISMA
 * distancia relativa, sin exigir toques) — el par que hace posible el control emparejado.
 */
function scanSide(all, side) {
  const real = [], synth = [];
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

    const future = all.slice(end, end + HORIZON_CANDLES);
    const t = Math.floor(w.at(-1).t / 1000);
    const brokeReal = side === 'support'
      ? future.some((c) => c.close < near.level.price)
      : future.some((c) => c.close > near.level.price);
    // Sintética: misma distancia relativa que el nivel real, sin exigir ningún toque.
    const synthLevel = side === 'support'
      ? price * (1 - near.distance_pct / 100)
      : price * (1 + near.distance_pct / 100);
    const brokeSynth = side === 'support'
      ? future.some((c) => c.close < synthLevel)
      : future.some((c) => c.close > synthLevel);

    real.push({ t, touches: near.level.touches, broke: brokeReal });
    synth.push({ t, broke: brokeSynth });
  }
  return { real, synth };
}

function bucketOf(touches) {
  if (touches >= 5) return '5+';
  if (touches >= 3) return '3-4';
  return '1-2';
}

console.log('═'.repeat(96));
console.log('C3 · ¿UN NIVEL S/R CON TOQUES AGUANTA MÁS QUE UNA LÍNEA A IGUAL DISTANCIA?');
console.log(`${DAYS} d objetivo · TF 4h · horizonte ${HORIZON_CANDLES} velas (24h) · SR tolerancia F2 (k=${SR_TOLERANCE_ATR_MULT})`);
console.log('P1: real < sintética (el veto tendría razón) · P2: indistinguibles (toques = ruido)');
console.log('P3: replica en soporte/resistencia y en las 3 monedas · CONTROL DE CÓDIGO: reflexión');
console.log('═'.repeat(96));

const headline = { support: {}, resistance: {} };
let mirrorTotal = 0, mirrorOk = 0;

for (const coin of COINS) {
  let raw;
  try { raw = await klines(coin, DAYS); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (raw.length < WIN + HORIZON_CANDLES + 20) { console.log(`${coin}: histórico insuficiente`); continue; }
  const spanDays = ((raw.at(-1).t - raw[0].t) / 86400e3).toFixed(0);
  console.log(`\n${'─'.repeat(96)}\n${coin} — ${raw.length} velas de 4h (${spanDays} días reales)`);

  for (const side of ['support', 'resistance']) {
    const { real, synth } = scanSide(raw, side);
    const rReal = disjointRate(real, (r) => r.broke, { horizonSec: HORIZON_SEC, stride: STRIDE });
    const rSynth = disjointRate(synth, (r) => r.broke, { horizonSec: HORIZON_SEC, stride: STRIDE });
    headline[side][coin] = { rReal, rSynth };
    const v = verdictCI(rReal, rSynth);
    const label = side === 'support' ? 'SOPORTE' : 'RESISTENCIA';
    console.log(`  ${label} — REAL (con toques) vs SINTÉTICA (misma distancia, sin toques):`);
    console.log(`    real:     ruptura=${rReal.point.toFixed(1)}%  IC[${rReal.low.toFixed(1)}-${rReal.high.toFixed(1)}]  n_ef=${rReal.n_eff}`);
    console.log(`    sintética: ruptura=${rSynth.point.toFixed(1)}%  IC[${rSynth.low.toFixed(1)}-${rSynth.high.toFixed(1)}]  n_ef=${rSynth.n_eff}`);
    console.log(`    → ${v.separated ? `SEPARADOS (${v.side === 'above' ? 'sintética > real: los toques SÍ sostienen' : 'real > sintética: los toques rompen MÁS'})` : 'IC se solapan — indistinguibles (los toques no aportan nada sobre la distancia)'}`);

    // Desglose secundario por nº de toques — contexto, no la pregunta principal.
    const byBucket = {};
    for (const a of real) (byBucket[bucketOf(a.touches)] ??= []).push(a);
    const bucketStr = ['1-2', '3-4', '5+'].map((b) => {
      const items = byBucket[b] ?? [];
      const r = disjointRate(items, (a) => a.broke, { horizonSec: HORIZON_SEC, stride: STRIDE });
      return `${b}:${r && r.n_eff >= MIN_N ? `${r.point.toFixed(1)}%(n=${r.n_eff})` : 'n<15'}`;
    }).join('  ');
    console.log(`    (por nº de toques, contexto: ${bucketStr})`);
  }

  // ── CONTROL DE CÓDIGO: reflexión ────────────────────────────────────────────────────
  const mirrored = mirror(raw);
  const { real: supOrig } = scanSide(raw, 'support');
  const { real: resMirror } = scanSide(mirrored, 'resistance');
  const rOrig = supOrig.length ? supOrig.filter((a) => a.broke).length / supOrig.length : null;
  const rMir = resMirror.length ? resMirror.filter((a) => a.broke).length / resMirror.length : null;
  if (rOrig != null && rMir != null) {
    mirrorTotal++;
    const close = Math.abs(rOrig - rMir) < 0.05; // 5pp de margen: agregado, no par a par
    if (close) mirrorOk++;
    console.log(`  CONTROL DE CÓDIGO (reflexión): soporte real ${(rOrig * 100).toFixed(1)}% vs `
      + `resistencia-de-reflejado ${(rMir * 100).toFixed(1)}%  ${close ? '✅' : '⚠️ revisar'}`);
  }
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — real vs sintética a igual distancia, por lado y moneda');
let separated = 0, compared = 0;
for (const side of ['support', 'resistance']) {
  for (const coin of COINS) {
    const h = headline[side][coin];
    if (!h) continue;
    compared++;
    const v = verdictCI(h.rReal, h.rSynth);
    if (v.separated) separated++;
  }
}
console.log(`${separated} de ${compared} combinaciones (lado × moneda) separan real de sintética.`);
console.log('\nLECTURA: si la mayoría SEPARA con la sintética por encima, los toques sí sostienen y');
console.log('el veto tiene una base real. Si la mayoría NO separa (indistinguibles), los toques no');
console.log('aportan información más allá de la distancia — la S/R "fuerte" del veto no predice');
console.log('mejor que una línea cualquiera a la misma distancia del precio.');
