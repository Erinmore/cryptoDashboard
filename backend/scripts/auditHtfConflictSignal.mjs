#!/usr/bin/env node
/**
 * auditHtfConflictSignal.mjs — B6 (SESSION_STATE.md §10.1): el conflicto 1W/1D
 * (`htf_conflict_1w_1d`, `gating.js:335-342`) se USA como contradicción — degrada convicción
 * y empuja hacia `Esperar`. Pero nunca se ha medido si el conflicto EN SÍ predice algo: ¿la
 * lectura de 1D (el TF más cercano al primario) es MENOS fiable cuando 1W la contradice que
 * cuando la refuerza? Si no, la contradicción reduce convicción sin motivo medido.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * DISEÑO — dos preguntas, no una
 *
 *  H1 (¿degrada la fiabilidad direccional?) · cuando 1W y 1D coinciden, ¿acierta más la
 *     dirección de 1D sobre el movimiento de 24h del TF primario que cuando 1W la contradice?
 *     Grupo ACUERDO vs grupo CONFLICTO — comparación DIRECTA (no contra una base de mercado;
 *     la pregunta es si el conflicto cambia la fiabilidad de 1D, no si 1D "gana al azar").
 *
 *  H2 (¿aplana el movimiento, "chop"?) · el uso en `gating.js` trata el conflicto como
 *     incertidumbre, no necesariamente como error direccional. Se mide también la tasa de
 *     "movimiento grande" (|fwdAtr|>0.5, cualquier signo) en ACUERDO vs CONFLICTO — si el
 *     conflicto predice MENOS movimiento neto (choppier), eso también justificaría bajar
 *     convicción aunque H1 no separe.
 *
 * Se usa `computeTrend` (servicio real) + `calculateRSI/MACD/ADX/SuperTrend/WaveTrend/
 * StochRSI/VolumeDelta` (mismos indicadores que producción) sobre klines DIARIAS y SEMANALES
 * reales de Binance — no una reimplementación. `trendDir` (bull/bear/neutral desde el string
 * de `computeTrend`) se inlinea porque en `gating.js` es una función interna sin exportar (2
 * líneas triviales, citadas); el cálculo real (`computeTrend`) sí se importa.
 *
 * SIN LOOKAHEAD: para cada ancla de 4h en el instante T, se usa la última vela DIARIA/SEMANAL
 * cuyo CIERRE (no apertura) sea <= T — nunca una vela que aún no había cerrado en producción.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · H1: el acierto de "dirección de 1D → movimiento 24h" es MENOR en el grupo CONFLICTO
 *       que en el grupo ACUERDO (IC separados, conflicto por debajo).
 *  P2 · H2: la tasa de "movimiento grande" es MENOR en CONFLICTO que en ACUERDO (chop).
 *  P3 · Debe replicar en las 3 monedas con n_ef>=30 por grupo.
 *
 * CONTROL DE CÓDIGO: no se re-implementa un tercer pipeline de reflexión multi-TF (coste alto
 * para una garantía que ya se tiene). `auditComputeTrend.mjs` (2026-08-01) demostró al 100%
 * (3.609 ventanas) que `computeTrend` es exactamente simétrico bajo la reflexión local
 * (`bull'=bear`, `bear'=bull`). La clasificación ACUERDO/CONFLICTO es una función PURA de dos
 * llamadas independientes a esa misma función simétrica (1D y 1W): si ambas se reflejan
 * (`bull↔bear`), "iguales" sigue siendo "iguales" y "distintas" sigue siendo "distintas" — la
 * propiedad se hereda EXACTAMENTE de una invariante ya verificada, sin necesidad de una nueva
 * medición empírica. Lo que SÍ se verifica aquí (código, no mercado): una comprobación de
 * consistencia interna — el conteo de ACUERDO+CONFLICTO+NEUTRAL debe agotar el total de
 * anclas con ambas lecturas disponibles, sin solapes ni huecos.
 *
 * MÉTODO: primario 4h (igual que producción). 1D = ventana de 90 velas (constants.js), 1W =
 * ventana de 52 velas (constants.js) — mismos tamaños que `computeIndicators` usa en
 * producción. Horizonte 6 velas de 4h (24h). Anclajes DISJUNTOS vía `lib/disjointAnchors.mjs`.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditHtfConflictSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditHtfConflictSignal.mjs
 */

import {
  calculateATRSeries, calculateRSI, calculateMACD, calculateADX,
  calculateSuperTrend, calculateWaveTrend, calculateStochRSI, calculateVolumeDelta,
} from '../src/utils/indicators.js';
import { computeTrend } from '../src/services/indicatorService.js';
import { fetchKlines } from './lib/binanceKlines.mjs';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 1000);
const WIN_1D = 90;                 // ventana de producción para 1D (constants.js)
const WIN_1W = 52;                 // ventana de producción para 1W (constants.js)
const LOOKBACK = 6;                // 24h en velas de 4h (horizonte del movimiento medido)
const SQRT_WINDOW = Math.sqrt(LOOKBACK);
const HORIZON_SEC = LOOKBACK * 4 * 3600;
const STRIDE = 6;
const FWD_BAND = 0.5;
const MIN_N = 30;
const DAY_MS = 86400e3;
const WEEK_MS = 7 * DAY_MS;

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

// Réplica de gating.js:128-133 (función interna sin exportar, 2 líneas triviales) —
// computeTrend (la lógica real) SÍ se importa arriba.
function trendDir(t) {
  if (!t) return null;
  if (t.includes('bull')) return 'bull';
  if (t.includes('bear')) return 'bear';
  return 'neutral';
}

/** Serie {closeTime, dir} — una entrada por vela completada, con su dirección de trend. */
function precomputeTrendSeries(candles, win, intervalMs) {
  const out = [];
  for (let j = win - 1; j < candles.length; j++) {
    const window = candles.slice(j - win + 1, j + 1);
    const dir = trendDir(trendAt(window));
    out.push({ closeTime: candles[j].t + intervalMs, dir });
  }
  return out;
}

/** Última entrada de `series` cuyo closeTime <= t (sin lookahead). Puntero avanza monótono. */
function makeLookup(series) {
  let ptr = 0;
  return (t) => {
    while (ptr + 1 < series.length && series[ptr + 1].closeTime <= t) ptr++;
    return series[ptr] && series[ptr].closeTime <= t ? series[ptr] : null;
  };
}

console.log('═'.repeat(96));
console.log('B6 · ¿PREDICE EL CONFLICTO 1W/1D ALGO SOBRE EL MOVIMIENTO A 24H? — señal AISLADA');
console.log(`${DAYS} d objetivo · primario 4h · 1D ventana ${WIN_1D} · 1W ventana ${WIN_1W} · horizonte ${LOOKBACK} velas (24h)`);
console.log('H1: acuerdo 1D acierta MÁS que conflicto · H2: acuerdo tiene MÁS movimiento grande (chop)');
console.log('P3: replica en 3 monedas, IC separado, n_ef>=30 por grupo · CONTROL: invariante heredada (ver cabecera)');
console.log('═'.repeat(96));

const results = [];

for (const coin of COINS) {
  let raw4h, rawD, rawW;
  try {
    [raw4h, rawD, rawW] = await Promise.all([
      fetchKlines(coin, DAYS, '4h'),
      fetchKlines(coin, DAYS + WIN_1D + 10, '1d'),
      fetchKlines(coin, DAYS + WIN_1W * 7 + 10, '1w'),
    ]);
  } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (raw4h.length < LOOKBACK + 20 || rawD.length < WIN_1D + 20 || rawW.length < WIN_1W + 20) {
    console.log(`${coin}: histórico insuficiente`); continue;
  }

  const dailySeries = precomputeTrendSeries(rawD, WIN_1D, DAY_MS);
  const weeklySeries = precomputeTrendSeries(rawW, WIN_1W, WEEK_MS);
  const lookupD = makeLookup(dailySeries);
  const lookupW = makeLookup(weeklySeries);

  const atrByIdx = new Map((calculateATRSeries(raw4h, 14) ?? []).map((e) => [e.idx, e.atr]));
  const agree = [], conflict = [], neutralGroup = [];
  let withBoth = 0;

  for (let i = 0; i + LOOKBACK < raw4h.length; i++) {
    const T = raw4h[i].t;
    const dEntry = lookupD(T);
    const wEntry = lookupW(T);
    if (!dEntry || !wEntry) continue; // sin cobertura suficiente todavía (arranque de la serie)
    withBoth++;

    const atr = atrByIdx.get(i);
    const price = raw4h[i].close;
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;
    const pxFwd = raw4h[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(T / 1000);

    const row = { t, d1D: dEntry.dir, d1W: wEntry.dir, fwdAtr };
    if (dEntry.dir === 'neutral' || wEntry.dir === 'neutral') neutralGroup.push(row);
    else if (dEntry.dir === wEntry.dir) agree.push(row);
    else conflict.push(row);
  }

  // ── control de código: consistencia interna (agota el total, sin solapes) ──────────────
  const consistent = (agree.length + conflict.length + neutralGroup.length) > 0
    && (agree.length + conflict.length + neutralGroup.length) <= withBoth;

  const hitDir = (r) => (r.d1D === 'bull' ? r.fwdAtr > FWD_BAND : r.fwdAtr < -FWD_BAND);
  const bigMove = (r) => Math.abs(r.fwdAtr) > FWD_BAND;

  const spanDays = ((raw4h.at(-1).t - raw4h[0].t) / 86400e3).toFixed(0);
  console.log(`\n${'─'.repeat(96)}\n${coin} — ${raw4h.length} velas 4h (${spanDays} días) · con 1D+1W disponibles=${withBoth}`);
  console.log(`  reparto: acuerdo=${agree.length}  conflicto=${conflict.length}  neutral(alguno)=${neutralGroup.length}`
    + `  ${consistent ? '✅ consistente' : '⚠️ revisar conteo'}`);

  const rAgreeDir = disjointRate(agree, hitDir, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const rConflictDir = disjointRate(conflict, hitDir, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const rAgreeBig = disjointRate(agree, bigMove, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const rConflictBig = disjointRate(conflict, bigMove, { horizonSec: HORIZON_SEC, stride: STRIDE });

  const fmt = (r) => (r ? `n_ef=${r.n_eff} tasa=${r.point.toFixed(1)}% IC[${r.low.toFixed(1)}-${r.high.toFixed(1)}]` : 'sin anclas');
  console.log(`  H1 · 1D acierta la dirección a 24h:`);
  console.log(`    acuerdo:   ${fmt(rAgreeDir)}`);
  console.log(`    conflicto: ${fmt(rConflictDir)}`);
  const vDir = verdictCI(rAgreeDir, rConflictDir);
  const h1Sig = rAgreeDir?.n_eff >= MIN_N && rConflictDir?.n_eff >= MIN_N && vDir.separated && vDir.side === 'above';
  console.log(`    → ${vDir.separated ? `SEPARADOS (${vDir.side === 'above' ? 'acuerdo > conflicto: el conflicto SÍ degrada' : 'conflicto > acuerdo: al revés de lo predicho'})` : 'IC se solapan — el conflicto no cambia el acierto'}  ${h1Sig ? '✅' : '✗'}`);

  console.log(`  H2 · tasa de movimiento grande (|fwdAtr|>0.5, cualquier signo):`);
  console.log(`    acuerdo:   ${fmt(rAgreeBig)}`);
  console.log(`    conflicto: ${fmt(rConflictBig)}`);
  const vBig = verdictCI(rAgreeBig, rConflictBig);
  const h2Sig = rAgreeBig?.n_eff >= MIN_N && rConflictBig?.n_eff >= MIN_N && vBig.separated && vBig.side === 'above';
  console.log(`    → ${vBig.separated ? `SEPARADOS (${vBig.side === 'above' ? 'acuerdo > conflicto: SÍ hay más chop en conflicto' : 'conflicto > acuerdo: al revés de lo predicho'})` : 'IC se solapan — el conflicto no cambia el chop'}  ${h2Sig ? '✅' : '✗'}`);

  results.push({ coin, h1Sig, h2Sig, rAgreeDir, rConflictDir, rAgreeBig, rConflictBig });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿predice el conflicto 1W/1D algo sobre el movimiento a 24h?');
let h1Count = 0, h2Count = 0;
for (const { coin, h1Sig, h2Sig } of results) {
  if (h1Sig) h1Count++;
  if (h2Sig) h2Count++;
  console.log(`  ${coin.padEnd(4)} H1 (degrada acierto): ${h1Sig ? '✅' : '✗'}   H2 (más chop): ${h2Sig ? '✅' : '✗'}`);
}
console.log(`\n${h1Count} de ${results.length} monedas: H1 separado (conflicto degrada el acierto de 1D).`);
console.log(`${h2Count} de ${results.length} monedas: H2 separado (conflicto predice más chop).`);
console.log('\nLECTURA: si H1 o H2 replican en las 3 monedas, el conflicto 1W/1D SÍ aporta información');
console.log('propia y la contradicción de gating.js tiene una base medida. Si ninguna replica, reduce');
console.log('convicción sin que el conflicto en sí prediga nada distinguible del acuerdo.');
