/**
 * auditBarrierTies.mjs — ¿cuántos resultados decide en silencio el convenio "adverso primero"?
 *
 * Los cruces se miran sobre velas de 1h y el orden INTRA-vela no es resoluble (el high y el
 * low no vienen ordenados). Cuando dos niveles caen en la misma vela, el código asume
 * siempre el adverso primero: `evaluateSetupBarrier` comprueba el stop ANTES que el TP1
 * ([outcome.js:157](../src/utils/outcome.js#L157)) y `classifyPathOutcome` usa `<=` a favor
 * del stop ([stats.js:336](../src/utils/stats.js#L336)). Es un convenio conservador y
 * declarado, pero si la ambigüedad fuera frecuente estaría FIJANDO el resultado en vez de
 * desempatarlo, y la expectativa del checkpoint heredaría ese sesgo.
 *
 * `auditPathWinRate.mjs` ya respondió por el lado del recorrido: con barreras a 2× y 1× ATR
 * el empate exige que UNA vela de 1h cubra 3×ATR → **0,0 %** medido (y el contador se
 * demuestra vivo: 3,6 % con barreras a 0,5×/0,5×). Falta el lado que puede doler, porque sus
 * niveles están MUCHO más juntos: el barrier del setup real.
 *
 * ANCLAS, fijadas antes de ejecutar:
 *   B1 · La ambigüedad stop↔TP1 exige una vela de 1h que cubra TODO el recorrido del trade
 *        (5-8 % en las 7 geometrías reales de SOL). El rango típico de una vela de 1h de
 *        SOL es ~1 %, así que se espera **< 2 %** de los trades resueltos. Un valor alto
 *        sería señal de geometrías demasiado apretadas para la resolución de 1h.
 *   B2 · La ambigüedad entrada↔stop es OTRA cosa y debe ser MÁS frecuente: sus niveles
 *        distan 1,9-3,3 %, no 5-8 %. Aquí el código llena y comprueba el stop en la misma
 *        vela, así que un toque de entrada seguido de un latigazo se cuenta como `stop`.
 *   B3 · IMPACTO, no solo frecuencia: para los casos B1 se calcula el R bajo el convenio
 *        contrario (tp1 en vez de stop) y se reporta cuánto se movería la expectativa
 *        agregada. Si el desplazamiento es menor que la anchura del IC de la línea base
 *        (±0,04R), el convenio es irrelevante para el checkpoint; si no, hay que decirlo.
 *
 * Método: las MISMAS 7 formas reales y el MISMO harness que `auditShadowBaseline.mjs`
 * (mismos anclajes de 4h, barrier real sobre velas de 1h). La detección de ambigüedad es
 * una lectura de las velas, no una reimplementación del barrier: el resultado sigue
 * saliendo de `evaluateShadowTrade`.
 *
 * SOLO LECTURA. No abre la BBDD. Binance público, sin API keys.
 *
 * Uso: node scripts/auditBarrierTies.mjs   ·   COIN=BTC node scripts/auditBarrierTies.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { evaluateShadowTrade } from '../src/utils/shadowTrade.js';

const COIN = process.env.COIN ?? 'SOL';
const ATR_WINDOW = 19;
const H4_MS = 4 * 3600 * 1000;

// Idénticas a auditShadowBaseline.mjs: [precio, dirección, entrada, stop, tp1, vigencia]
const REALES = [
  [74.01, 'long', 75.60, 73.10, 79.37, 12], [73.31, 'short', 72.20, 73.55, 69.50, 6],
  [74.81, 'long', 76.70, 74.30, 79.50, 12], [73.59, 'long', 74.65, 72.80, 76.57, 6],
  [73.04, 'short', 72.25, 73.55, 69.50, 6], [73.02, 'short', 72.20, 73.55, 68.32, 6],
  [72.91, 'short', 72.20, 74.55, 68.32, 6],
];
const FORMAS = REALES.map(([p, dir, e, s, t, v]) => ({
  dir, e: e / p - 1, s: s / p - 1, t: t / p - 1, v,
}));

async function klines(interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${COIN}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({ t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4] }));
}

const k4 = await klines('4h', 560);
const k1raw = [];
for (const end of [Date.now() - 2000 * 3600e3, Date.now() - 1000 * 3600e3, Date.now()]) {
  k1raw.push(...await klines('1h', 1000, end));
}
const k1 = k1raw.sort((a, b) => a.t - b.t).filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
const lastT = k1.at(-1).t;

const touches = (c, lvl) => c.low <= lvl && lvl <= c.high;
const rangePct = (c) => (c.high - c.low) / c.close * 100;

const stat = {
  resolved: 0, filled: 0,
  tieStopTp: 0,          // B1 · una vela toca stop Y tp1 con el trade ya vivo
  tieEntryStop: 0,       // B2 · la vela de fill toca también el stop
  tieEntryTp: 0,         // la vela de fill toca también el tp1 (misma ambigüedad, otro lado)
  rDeltaSum: 0,        // B3 · desplazamiento de R si el convenio fuera "objetivo primero"
  rDeltaEntrySum: 0,   // B3 · idem para la ambigüedad entrada↔stop
  rSum: 0, rN: 0,
  ranges: [],
};

for (let i = ATR_WINDOW - 1; i < k4.length; i++) {
  const w = k4.slice(i - ATR_WINDOW + 1, i + 1);
  const atr = calculateATR(w, 14);
  if (!Number.isFinite(atr)) continue;
  const tMs = k4[i].t + H4_MS;
  const price = k4[i].close;

  for (const f of FORMAS) {
    if (tMs + f.v * H4_MS > lastT) continue;
    const cs = {
      direction: f.dir,
      entry_price: price * (1 + f.e), stop_price: price * (1 + f.s),
      tp1_price: price * (1 + f.t), validity_candles: f.v, tf_execution: '4h',
    };
    const candles = k1.filter((c) => c.t >= tMs && c.t <= tMs + 8 * 24 * 3600e3);
    const ev = evaluateShadowTrade({ conditionalSetup: cs, candles, tMs, primaryTf: '4h', now: Date.now() });
    if (!ev || ev.preserve) continue;
    stat.resolved++;
    if (!ev.filled) continue;
    stat.filled++;

    const rr = Math.abs(cs.tp1_price - cs.entry_price) / Math.abs(cs.entry_price - cs.stop_price);
    const r = (ev.exit_price != null)
      ? (cs.direction === 'long'
        ? (ev.exit_price - cs.entry_price) / (cs.entry_price - cs.stop_price)
        : (cs.entry_price - ev.exit_price) / (cs.stop_price - cs.entry_price))
      : null;
    if (Number.isFinite(r)) { stat.rSum += r; stat.rN++; }

    // Recorre las mismas velas para localizar la vela de fill y la de resolución.
    let filled = false;
    for (const c of candles) {
      if (!filled) {
        if (!touches(c, cs.entry_price)) continue;
        filled = true;
        if (touches(c, cs.stop_price)) {
          stat.tieEntryStop++;
          // Convenio contrario para ESTE caso: la entrada se llenó y el stop vino después,
          // así que el trade sigue vivo a partir de la vela siguiente. Se mide con el
          // evaluador REAL, sustituyendo la vela de fill por una de rango cero en la
          // entrada (llena y no resuelve) — no se reimplementa el barrier.
          const rest = candles.filter((x) => x.t > c.t);
          const alt = evaluateShadowTrade({
            conditionalSetup: cs,
            candles: [{ t: c.t, open: cs.entry_price, high: cs.entry_price, low: cs.entry_price, close: cs.entry_price }, ...rest],
            tMs, primaryTf: '4h', now: Date.now(),
          });
          if (alt && !alt.preserve && alt.exit_price != null) {
            const rAlt = cs.direction === 'long'
              ? (alt.exit_price - cs.entry_price) / (cs.entry_price - cs.stop_price)
              : (cs.entry_price - alt.exit_price) / (cs.stop_price - cs.entry_price);
            if (Number.isFinite(rAlt) && Number.isFinite(r)) stat.rDeltaEntrySum += rAlt - r;
          }
        }
        if (touches(c, cs.tp1_price)) stat.tieEntryTp++;
        stat.ranges.push(rangePct(c));
      }
      const hitStop = touches(c, cs.stop_price) || (cs.direction === 'long' ? c.low < cs.stop_price : c.high > cs.stop_price);
      const hitTp = touches(c, cs.tp1_price) || (cs.direction === 'long' ? c.high > cs.tp1_price : c.low < cs.tp1_price);
      if (hitStop && hitTp) {
        stat.tieStopTp++;
        // B3 · convenio contrario: este trade habría salido en TP1 (+R:R) en vez de en stop (−1).
        if (ev.outcome === 'stop') stat.rDeltaSum += rr - (-1);
        break;
      }
      if (hitStop || hitTp) break;
    }
  }
}

const pct = (x, n) => (n ? `${(x / n * 100).toFixed(2)}%` : '—');
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };

console.log(`\n${'═'.repeat(74)}\n${COIN} — ambigüedad intra-vela del barrier (convenio "adverso primero")\n${'═'.repeat(74)}`);
console.log(`  ${stat.resolved} réplicas resueltas · ${stat.filled} llenadas (${pct(stat.filled, stat.resolved)})`);
console.log(`  rango mediano de la vela de fill: ${median(stat.ranges)?.toFixed(2)}%`
  + `  ·  recorrido stop→tp1 de las formas: 5-8%`);
console.log(`\n  B1 stop y TP1 en la MISMA vela : ${stat.tieStopTp} (${pct(stat.tieStopTp, stat.filled)} de las llenadas)`);
console.log(`  B2 entrada y stop en la misma  : ${stat.tieEntryStop} (${pct(stat.tieEntryStop, stat.filled)})`);
console.log(`     entrada y TP1 en la misma   : ${stat.tieEntryTp} (${pct(stat.tieEntryTp, stat.filled)})`);
const expNow = stat.rN ? stat.rSum / stat.rN : null;
const expAlt = stat.rN ? (stat.rSum + stat.rDeltaSum) / stat.rN : null;
console.log(`\n  B3 expectativa con el convenio actual      : ${expNow?.toFixed(4)}R  (n=${stat.rN})`);
console.log(`     expectativa con el convenio CONTRARIO   : ${expAlt?.toFixed(4)}R`);
console.log(`     desplazamiento máximo del convenio      : ${(expAlt - expNow).toFixed(4)}R`);
const expAltE = stat.rN ? (stat.rSum + stat.rDeltaEntrySum) / stat.rN : null;
console.log(`     idem si la ambigüedad ENTRADA↔stop se resolviera al revés: ${expAltE?.toFixed(4)}R`
  + `  (Δ ${(expAltE - expNow).toFixed(4)}R)`);
console.log(`     desplazamiento conjunto de los dos convenios: `
  + `${((stat.rSum + stat.rDeltaSum + stat.rDeltaEntrySum) / stat.rN - expNow).toFixed(4)}R`);
console.log(`     (compárese con el IC de la línea base, ±0,04R)`);
