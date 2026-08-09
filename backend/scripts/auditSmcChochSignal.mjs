#!/usr/bin/env node
/**
 * auditSmcChochSignal.mjs — B8 (SESSION_STATE.md §10.1): ¿predice un CHoCH activo
 * (`last_choch.signal_status='active'`) la dirección del precio en las 24h siguientes,
 * aislado?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE SCRIPT
 *
 * `auditCleanMoveDirection.mjs` (M9, 03-08) probó 7 features pre-registradas, incluyendo
 * `smc_bos`, pero NUNCA CHoCH — que es estructuralmente la señal OPUESTA (primer aviso de
 * REVERSIÓN, no de continuación de tendencia) y merece su propia medición, no una inferencia
 * desde el resultado de BOS. Se usa `calculateSMC` (función real, `detectLastCHoCH` +
 * `bosChochStatus` para el decay `active`/`context`/`expired`) — no una reimplementación de
 * la detección de swings ni de la tabla de decay por TF.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · CHoCH `active` con `direction='bullish'` → el precio sube (fwdAtr > +0.5) más a
 *       menudo que la base incondicional de "sube" — es la tesis explícita de la señal
 *       (primer quiebre en dirección opuesta a la tendencia previa = reversión en marcha).
 *  P2 · CHoCH `active` con `direction='bearish'` → el precio baja más a menudo que la base.
 *  P3 · Debe replicar en las 3 monedas con el IC de Wilson estrictamente separado, n_ef>=30.
 *
 * CONTROL DE CÓDIGO (exacto, por ancla): la detección de swings (`detectSwings`) compara
 * `high`/`low` entre velas vecinas — bajo la reflexión LOCAL `p'=2A-p` (high'=2A-low,
 * low'=2A-high), un swing-high se convierte en swing-low y viceversa (mismo argumento que
 * `auditLevelRejectionVsBreakout.mjs`, que verificó soporte↔resistencia). `inferStructuralTrend`
 * y la comparación `close > swing.price` / `close < swing.price` son comparaciones de ORDEN
 * sobre precios, que se invierten exactamente bajo `p'=2A-p`. La `direction` del CHoCH
 * (bullish/bearish) debe salir INVERTIDA exacta en el reflejo; `signal_status`
 * (`active`/`context`/`expired`) depende solo de `candles_ago` (tiempo, no precio) y debe
 * salir IDÉNTICO. Se verifica el 100% en las anclas con CHoCH presente en ambos lados.
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción). `calculateSMC(window,
 * {timeframe:'4h'})` con sus defaults (`lookback=2`, `maxCandlesAgo=12`, `activeMax=4` para
 * 4h — tabla de decay real, sin reimplementar). Horizonte 6 velas (24h). Anclajes DISJUNTOS
 * vía `lib/disjointAnchors.mjs`.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditSmcChochSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditSmcChochSignal.mjs
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

const FLIP_DIR = { bullish: 'bearish', bearish: 'bullish' };

function activeChochAt(candles, i) {
  const start = Math.max(0, i - WIN + 1);
  const smc = calculateSMC(candles.slice(start, i + 1), { timeframe: '4h' });
  const c = smc?.last_choch;
  if (!c || c.signal_status !== 'active') return null;
  return c.direction; // 'bullish' | 'bearish'
}

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

    const dir = activeChochAt(candles, i);
    if (dir == null) continue;

    const pxFwd = candles[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, dir, fwdAtr });

    // ── control de código: reflejo LOCAL del tramo [i-WIN+1, i] ────────────────────────
    const lo = i - WIN + 1;
    if (lo >= 0) {
      const mLocal = mirrorCandles(candles.slice(lo, i + 1), candles[lo].close);
      const mDir = activeChochAt(mLocal, mLocal.length - 1);
      if (mDir != null) {
        mirrorTotal++;
        if (mDir === FLIP_DIR[dir]) mirrorMatch++;
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
console.log('B8 · ¿PREDICE UN CHoCH ACTIVO LA DIRECCIÓN A 24H? — años de klines, señal AISLADA');
console.log(`${DAYS} d objetivo · TF 4h · calculateSMC (lookback=2, decay real 4h) sobre ventana ${WIN} · horizonte ${LOOKBACK} velas (24h)`);
console.log('P1: CHoCH bullish activo → sube más que la base · P2: CHoCH bearish activo → baja más que la base');
console.log('P3: replica en 3 monedas, IC separado, n_ef>=30 · CONTROL: reflejo local = dirección opuesta exacta');
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

  // Base: unconditional, sobre TODAS las anclas (no solo las de CHoCH) — recorrido aparte.
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

  const bull = rows.filter((r) => r.dir === 'bullish');
  const bear = rows.filter((r) => r.dir === 'bearish');
  console.log(`  CHoCH activo: bullish=${bull.length}  bearish=${bear.length}  (${((rows.length / allRows.length) * 100).toFixed(1)}% de las anclas)`);
  console.log('  CHoCH bullish activo → ¿sube?:');
  const rBull = line('CHoCH bullish → sube', bull, upHit, baseUp);
  console.log('  CHoCH bearish activo → ¿baja?:');
  const rBear = line('CHoCH bearish → baja', bear, dnHit, baseDn);

  console.log(`  CONTROL DE CÓDIGO (reflejo local, exacto): ${mirrorMatch}/${mirrorTotal} anclas`
    + ` (${mirrorTotal ? ((mirrorMatch / mirrorTotal) * 100).toFixed(2) : '—'}%) con dirección opuesta exacta`
    + `  ${mirrorTotal && mirrorMatch === mirrorTotal ? '✅' : '⚠️ revisar'}`);

  results.push({ coin, rBull, rBear });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿replica el CHoCH activo como señal de REVERSIÓN aislada en 24h?');
let bullOk = 0, bearOk = 0;
for (const { coin, rBull, rBear } of results) {
  const okBull = !!rBull?.significant;
  const okBear = !!rBear?.significant;
  if (okBull) bullOk++;
  if (okBear) bearOk++;
  console.log(`  ${coin.padEnd(4)} bullish: ${rBull ? `${rBull.lift >= 0 ? '+' : ''}${rBull.lift.toFixed(1)}pt (n_ef=${rBull.n_eff})` : '—'} ${okBull ? '✅' : '✗'}`
    + `   bearish: ${rBear ? `${rBear.lift >= 0 ? '+' : ''}${rBear.lift.toFixed(1)}pt (n_ef=${rBear.n_eff})` : '—'} ${okBear ? '✅' : '✗'}`);
}
console.log(`\n${bullOk} de ${results.length} monedas: CHoCH bullish separa por encima de la base.`);
console.log(`${bearOk} de ${results.length} monedas: CHoCH bearish separa por encima de la base.`);
console.log(`Control de reflexión global: ${mirrorMatchAll}/${mirrorTotalAll}`
  + ` (${mirrorTotalAll ? ((mirrorMatchAll / mirrorTotalAll) * 100).toFixed(2) : '—'}%).`);
console.log('\nLECTURA: si las 3 monedas replican en AMBAS direcciones con el IC separado, el CHoCH activo');
console.log('tiene poder predictivo real de REVERSIÓN a 24h — a diferencia de BOS (M9, no predijo la');
console.log('dirección del movimiento limpio). Si no replica, se archiva junto a BOS en el Bloque A.');
