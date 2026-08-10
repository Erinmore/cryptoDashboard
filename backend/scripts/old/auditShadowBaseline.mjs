/**
 * auditShadowBaseline.mjs — línea base de la EXPECTATIVA de un shadow trade.
 *
 * POR QUÉ. `summarizeShadowTrades` ya reporta `expectancy_r`, pero un `-0,1R` suelto no se
 * sabe si es bueno o malo: falta contra qué compararlo. Igual que `offered_pct` necesitaba
 * `OPPORTUNITY_BASE_RATE` y `trigger_rate_pct` necesitaba `TRIGGER_BASE_RATE`, la expectativa
 * necesita saber qué habrían rendido ESAS MISMAS geometrías aplicadas en instantes al azar.
 *
 * QUÉ HACE. Toma la FORMA de cada `conditional_setup` real (dirección y distancias relativas
 * a entrada/stop/objetivo, más la vigencia declarada) y la aplica en CADA anclaje de 4h del
 * histórico. Evalúa con `evaluateShadowTrade` y agrega con `summarizeShadowTrades` — las
 * funciones REALES, sin copias: si el número no sale de la misma tubería que produce el dato
 * de producción, no es comparable con él.
 *
 * ⚠️ QUÉ **NO** MIDE. No mide el criterio del sistema. Aplica los setups en momentos al azar,
 * que es justamente quitar el timing — lo único que el sistema pretende aportar. Lo que da es
 * la línea sobre la que habría que ver la ventaja: si la geometría ya gana dinero por sí sola,
 * el mérito no es del modelo; si pierde, la ventaja del modelo tiene que venir toda del
 * momento en que decide. Leerlo como un veredicto sobre el sistema sería el error.
 *
 * ⚠️ EL IC SALE DEMASIADO ESTRECHO. Las N formas se aplican sobre los MISMOS anclajes, así que
 * las réplicas están correlacionadas y el n efectivo es bastante menor que el n bruto. Es el
 * mismo problema que `by_episode` resuelve para los análisis. Se reporta el n por forma para
 * que la corrección mental sea posible; no se estrecha el intervalo aquí.
 *
 * ORIGEN. Nació como ensayo en seco para comprobar que la tubería poblaba `expectancy_r` con
 * un punto y un intervalo de verdad. Encontró de paso que la expectativa excluía a los
 * caducados —el 52 % de los trades disparados, y siempre por el mismo lado, porque el stop
 * suele estar más cerca que el objetivo—, lo que la sesgaba a la baja. Ese fallo ya está
 * corregido (`cond_exit_price`); este script se queda como la línea base que faltaba.
 *
 * SOLO LECTURA: no toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditShadowBaseline.mjs
 *       COIN=BTC node scripts/auditShadowBaseline.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { evaluateShadowTrade } from '../src/utils/shadowTrade.js';
import { summarizeShadowTrades } from '../src/utils/stats.js';

const COIN = process.env.COIN ?? 'SOL';
const ATR_WINDOW = 19;          // = ATR_PERIOD+5, igual que `atr_pct_at_analysis`
const H4_MS = 4 * 3600 * 1000;

/**
 * Formas de los `conditional_setup` reales de producción, como distancias RELATIVAS al
 * precio del análisis. Se guardan relativas para poder aplicarlas a cualquier precio.
 * [precio, dirección, entrada, stop, tp1, vigencia_en_velas_4h]
 */
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
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
  }));
}

const k4 = await klines('4h', 560);
// El barrier evalúa sobre klines de 1h, igual que el job de outcome.
const k1raw = [];
for (const end of [Date.now() - 2000 * 3600e3, Date.now() - 1000 * 3600e3, Date.now()]) {
  k1raw.push(...await klines('1h', 1000, end));
}
const k1 = k1raw.sort((a, b) => a.t - b.t).filter((c, i, a) => i === 0 || c.t !== a[i - 1].t);
const lastT = k1.at(-1).t;

const rows = [];
let anclajes = 0;
for (let i = ATR_WINDOW - 1; i < k4.length; i++) {
  const w = k4.slice(i - ATR_WINDOW + 1, i + 1);
  const atr = calculateATR(w, 14);
  if (!Number.isFinite(atr)) continue;
  const atrPct = parseFloat((atr / k4[i].close * 100).toFixed(2));
  const tMs = k4[i].t + H4_MS;          // instante del "análisis" = cierre de la vela
  const price = k4[i].close;
  let usado = false;
  for (const f of FORMAS) {
    // Solo anclajes cuya vigencia CABE en los datos: si no, saldrían `not_triggered` por
    // falta de velas y no porque el mercado no llegara.
    if (tMs + f.v * H4_MS > lastT) continue;
    const cs = {
      direction: f.dir,
      entry_price: price * (1 + f.e), stop_price: price * (1 + f.s),
      tp1_price: price * (1 + f.t), validity_candles: f.v, tf_execution: '4h',
    };
    const candles = k1.filter((c) => c.t >= tMs && c.t <= tMs + 8 * 24 * 3600e3);
    const ev = evaluateShadowTrade({ conditionalSetup: cs, candles, tMs, primaryTf: '4h', now: Date.now() });
    if (!ev || ev.preserve) continue;
    usado = true;
    rows.push({
      id: `${i}-${f.dir}-${f.v}`, coin: COIN, primary_tf: '4h',
      timestamp: new Date(tMs).toISOString(), price_current: price,
      atr_pct_at_analysis: atrPct, conditional_setup: JSON.stringify(cs),
      cond_outcome: ev.outcome, cond_filled: ev.filled, cond_exit_price: ev.exit_price,
    });
  }
  if (usado) anclajes++;
}

const s = summarizeShadowTrades(rows);
const e = s.expectancy_r;
console.log(`\n${'═'.repeat(74)}`);
console.log(`${COIN} — línea base de la expectativa del shadow trade`);
console.log('═'.repeat(74));
console.log(`  ${rows.length} réplicas · ${FORMAS.length} formas × ${anclajes} anclajes de 4h\n`);
console.log(`  disparó            ${s.trigger_rate_pct}%  (${s.triggered_n}/${s.conclusive_n})`
  + `   base ${s.trigger_base_rate_pct}%   LIFT ${s.trigger_lift_pct > 0 ? '+' : ''}${s.trigger_lift_pct}`);
console.log(`  desglose           tp1 ${s.tp1} · stop ${s.stop} · caducados ${s.expired} · sin disparar ${s.not_triggered}`);
console.log(`  acierto (TP/stop)  ${s.win_rate}%  IC95 [${s.win_rate_ci_low}, ${s.win_rate_ci_high}]`
  + `   equilibrio ${s.breakeven_win_rate_pct}%   R:R mediana ${s.rr_median}`);
console.log(`\n  EXPECTATIVA  ${e.point > 0 ? '+' : ''}${e.point} R   IC95 [${e.ci_low}, ${e.ci_high}]   n=${e.n}`
  + `   → ${e.inconclusive ? 'INCONCLUSA' : 'el signo se puede afirmar'}`);
console.log(`  (incluye los caducados a su R real: ${s.expired} de los ${e.n} que entran)`);
for (const d of ['long', 'short']) {
  const b = s.by_direction[d], x = b.expectancy_r;
  if (!x || x.point == null) continue;
  console.log(`    ${d.padEnd(5)}  expectativa ${x.point > 0 ? '+' : ''}${x.point}R [${x.ci_low}, ${x.ci_high}]`
    + `  n=${x.n}  ·  acierto ${b.win_rate}% vs equilibrio ${b.breakeven_win_rate_pct}%`);
}
console.log('\n  ⚠️ Es la línea base de la GEOMETRÍA, no un veredicto sobre el sistema: aplica los');
console.log('     setups en instantes al azar, que es quitar el timing. Y el IC sale estrecho');
console.log(`     porque las ${FORMAS.length} formas comparten anclajes (réplicas correlacionadas).\n`);
