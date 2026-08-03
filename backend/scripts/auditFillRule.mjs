#!/usr/bin/env node
/**
 * auditFillRule.mjs — M7: ¿cuánto cuesta que el evaluador llene al TOCAR y el gatillo pida CERRAR?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LA PREGUNTA, Y POR QUÉ BLOQUEA AL PRODUCTO
 *
 * `SHADOW_FILL_RULE = 'touch_entry_intrabar'`: el evaluador da por entrada el simple TOQUE del
 * precio intravela. Pero el gatillo que declara el modelo pide otra cosa — *"cierre 4h por
 * debajo de 72,09 con OI expandiendo y CVD vendedor"*: un CIERRE de vela, más dos condiciones
 * que ni siquiera se parsean.
 *
 * Mientras el panel enseñaba esto como telemetría interna era un matiz declarado. Desde que el
 * registro del shadow trade está en la pantalla que el usuario lee para operar, **la cifra que
 * ve no es la que obtendría siguiendo las instrucciones que se le dan**. Eso es P3, y M7 es su
 * requisito: sin saber cuánto cuesta la diferencia, no se puede decidir si se cambia la regla,
 * se cambia el gatillo o basta con avisar más fuerte.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * MÉTODO — NO se reimplementa el barrier (precedente: `auditBarrierTies`)
 *
 * Las dos ramas usan `evaluateShadowTrade` REAL. Lo único que cambia es lo que se le pasa:
 *
 *   A · TOQUE (actual)  → el setup tal cual, sobre todas las velas desde el análisis.
 *   B · CIERRE          → llenado AL CIERRE de la vela que confirma (entrada = ese cierre).
 *   C · CONFIRMA+LÍMITE → primero el cierre de confirmación, y DESPUÉS el toque del
 *                         `entry_price` DECLARADO. Es lo que el setup describe de verdad.
 *
 * ⚠️ AUTOCORRECCIÓN. La primera versión sólo tenía A y B, y concluyó que "el setup es
 * incoherente". Al releer un caso real —gatillo *cierre 4h < 72,09*, entrada **71,90**, o sea
 * un nivel MÁS ABAJO— se ve que no lo es: describe *confirmar la rotura y luego entrar con
 * límite un poco mejor*. Eso es la rama C, y no estaba medida. B mide una TERCERA cosa que el
 * setup no dice. La conclusión útil sale de comparar A con C, no A con B.
 *
 * ⚠️ LA RAMA B EMPEORA POR DOS VÍAS A LA VEZ, y las dos son reales, no artefactos:
 *   (1) se entra a un precio PEOR (el cierre ya rompió el nivel), y
 *   (2) con la entrada peor y el stop donde se declaró, el R:R REAL baja.
 * Ejemplo del análisis 8: entrada declarada 71,90 / stop 73,60 / TP 68,32 → R:R 2,11. El cierre
 * 4h fue 71,27, así que entrando ahí el riesgo pasa de 1,70 a 2,33 y el premio de 3,58 a 2,95:
 * **R:R 1,27**. Por eso se reporta el R:R realizado de cada rama, no solo el declarado.
 *
 * ⚠️ TRES APROXIMACIONES DECLARADAS, todas conservadoras hacia "la rama B no sale mejor de lo
 * que es":
 *   · La vigencia se cuenta desde el ANÁLISIS en las dos ramas (es lo que el análisis declara),
 *     no desde el llenado. La rama B tiene por tanto menos tiempo útil — igual que en la vida.
 *   · Las dos condiciones extra del gatillo (OI expandiendo, CVD vendedor) **no se comprueban**:
 *     son datos que no están en klines. La rama B es por tanto un TECHO de la rama estricta.
 *   · En la rama B el llenado ocurre en la vela de confirmación, donde el precio ya está en la
 *     entrada; el evaluador la llena de inmediato. Es la lectura más favorable a B.
 *
 * POBLACIÓN: las FORMAS de los `conditional_setup` reales de producción (distancias relativas
 * al precio), aplicadas a cada anclaje de 4h del histórico — mismo arnés que
 * `auditShadowBaseline`, para que las cifras sean comparables con su línea base.
 *
 * SOLO LECTURA. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditFillRule.mjs
 *       COINS=SOL DAYS=180 node scripts/auditFillRule.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { evaluateShadowTrade } from '../src/utils/shadowTrade.js';
import { expectancyR } from '../src/utils/stats.js';
import { TF_DURATION_MS } from '../src/config/constants.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 180);
const HOUR_MS = 3600e3;
const H4_MS = TF_DURATION_MS['4h'];

/**
 * Formas reales de producción: [precio, dirección, entrada, stop, tp1, vigencia_en_velas_4h].
 * Las mismas que usa `auditShadowBaseline`, más las tres emitidas desde entonces.
 */
const REALES = [
  [74.01, 'long', 75.60, 73.10, 79.37, 12], [73.31, 'short', 72.20, 73.55, 69.50, 6],
  [74.81, 'long', 76.70, 74.30, 79.50, 12], [73.59, 'long', 74.65, 72.80, 76.57, 6],
  [73.04, 'short', 72.25, 73.55, 69.50, 6], [73.02, 'short', 72.20, 73.55, 68.32, 6],
  [72.91, 'short', 72.20, 74.55, 68.32, 6], [71.21, 'short', 70.30, 72.55, 68.05, 6],
  [73.38, 'short', 72.30, 73.80, 70.58, 6], [73.64, 'short', 72.60, 74.60, 68.30, 12],
  [72.43, 'short', 71.90, 73.60, 68.32, 12],
];
const FORMAS = REALES.map(([p, dir, e, s, t, v]) => ({ dir, e: e / p - 1, s: s / p - 1, t: t / p - 1, v }));

async function klines(coin, interval, startMs, endMs) {
  const out = [];
  let start = startMs;
  for (let g = 0; g < 40; g++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=${interval}&startTime=${start}&endTime=${endMs}&limit=1000`);
    if (!r.ok) throw new Error(`Binance ${coin}/${interval}: HTTP ${r.status}`);
    const b = (await r.json()).map((x) => ({
      t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
    }));
    if (!b.length) break;
    out.push(...b);
    if (b.length < 1000) break;
    start = b.at(-1).t + 1;
  }
  return out;
}

/** R realizado. Un no-llenado renta 0R: no se hizo el trade. */
function rOf(ev, entry, stop) {
  if (!ev || ev.preserve) return null;
  if (!ev.filled) return 0;
  const risk = entry - stop;
  if (risk === 0 || !Number.isFinite(ev.exit_price)) return null;
  return (ev.exit_price - entry) / risk;
}

const acumula = () => ({ n: 0, filled: 0, tp1: 0, stop: 0, expired: 0, notTrig: 0, rs: [], rr: [] });

function anota(acc, ev, entry, stopP, tp) {
  if (!ev || ev.preserve) return;
  acc.n++;
  if (ev.filled) acc.filled++;
  if (ev.outcome === 'tp1') acc.tp1++;
  else if (ev.outcome === 'stop') acc.stop++;
  else if (ev.outcome === 'expired') acc.expired++;
  else if (ev.outcome === 'not_triggered') acc.notTrig++;
  const r = rOf(ev, entry, stopP);
  if (r != null) acc.rs.push(r);
  const risk = Math.abs(entry - stopP), rew = Math.abs(tp - entry);
  if (risk > 0 && ev.filled) acc.rr.push(rew / risk);
}

async function auditCoin(coin) {
  const endMs = Date.now();
  const startMs = endMs - (DAYS + 5) * 24 * HOUR_MS;
  const [k4, k1] = await Promise.all([klines(coin, '4h', startMs, endMs), klines(coin, '1h', startMs, endMs)]);
  if (k4.length < 25 || !k1.length) return null;
  const lastT = k1.at(-1).t;

  const A = acumula(), B = acumula(), C = acumula();
  for (let i = 20; i < k4.length; i++) {
    const price = k4[i].close;
    const tMs = k4[i].t + H4_MS;
    if (!(price > 0)) continue;
    const atr = calculateATR(k4.slice(i - 19, i + 1), 14);
    if (!Number.isFinite(atr) || atr <= 0) continue;

    for (const f of FORMAS) {
      const expiry = tMs + f.v * H4_MS;
      if (expiry > lastT) continue;                       // sin vigencia completa → fuera
      const entry = price * (1 + f.e);
      const stopP = price * (1 + f.s);
      const tp = price * (1 + f.t);
      const cs = {
        direction: f.dir, entry_price: entry, stop_price: stopP, tp1_price: tp,
        validity_candles: f.v, tf_execution: '4h',
      };
      const velas = k1.filter((c) => c.t >= tMs && c.t <= tMs + 8 * 24 * HOUR_MS);

      // ── A · TOQUE (la regla actual) ──
      anota(A, evaluateShadowTrade({ conditionalSetup: cs, candles: velas, tMs, primaryTf: '4h', now: Date.now() }),
        entry, stopP, tp);

      // ── B · CIERRE de vela del TF de ejecución ──
      const sg = f.dir === 'long' ? 1 : -1;
      const conf = k4.find((c) => c.t >= tMs && c.t + H4_MS <= expiry
        && (sg > 0 ? c.close >= entry : c.close <= entry));
      const noTrig = { outcome: 'not_triggered', filled: 0, preserve: false, exit_price: null };
      if (!conf) {
        anota(B, noTrig, entry, stopP, tp);
        anota(C, noTrig, entry, stopP, tp);
        continue;
      }
      const desde = velas.filter((c) => c.t >= conf.t + H4_MS - HOUR_MS);
      const fill = conf.close;                            // se entra al cierre: peor precio
      anota(B, evaluateShadowTrade({
        conditionalSetup: { ...cs, entry_price: fill },
        candles: desde, tMs, primaryTf: '4h', now: Date.now(),
      }), fill, stopP, tp);

      // ── C · CONFIRMA y LUEGO límite en la entrada DECLARADA (lo que el setup dice) ──
      // Confirmación de cierre PRIMERO; el llenado sigue siendo el toque del nivel declarado,
      // así que el R:R declarado SÍ es el realizable. Lo que baja es la frecuencia.
      anota(C, evaluateShadowTrade({
        conditionalSetup: cs, candles: desde, tMs, primaryTf: '4h', now: Date.now(),
      }), entry, stopP, tp);
    }
  }
  return { A, B, C };
}

// ─── Reporte ─────────────────────────────────────────────────────────────────
const pc = (x, n) => (n ? `${(x / n * 100).toFixed(1)}%` : '  — ');
const f3 = (x) => (x == null ? '  —   ' : (x >= 0 ? '+' : '') + x.toFixed(3));
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

console.log('═'.repeat(92));
console.log('M7 · COSTE DE LA REGLA DE LLENADO — toque intravela (actual) vs cierre de vela');
console.log(`${DAYS} d · ${FORMAS.length} formas reales de producción · evaluador REAL en las dos ramas`);
console.log('⚠️ La rama CIERRE no comprueba las condiciones extra del gatillo (OI, CVD): es un TECHO.');
console.log('═'.repeat(92));

const TOT = { A: acumula(), B: acumula(), C: acumula() };
for (const coin of COINS) {
  let d;
  try { d = await auditCoin(coin); } catch (e) { console.log(`\n${coin}: ${e.message}`); continue; }
  if (!d) { console.log(`\n${coin}: sin datos`); continue; }
  console.log(`\n${'─'.repeat(92)}\n${coin} · ${d.A.n} réplicas`);
  console.log('  rama      llenado   tp1     stop    caducó   no disparó   R:R real   E[R]/oportunidad');
  for (const [lbl, acc] of [['A toque ', d.A], ['B cierre', d.B], ['C conf+lim', d.C]]) {
    for (const k of ['n', 'filled', 'tp1', 'stop', 'expired', 'notTrig']) TOT[lbl[0]][k] += acc[k];
    TOT[lbl[0]].rs.push(...acc.rs); TOT[lbl[0]].rr.push(...acc.rr);
    const e = expectancyR(acc.rs);
    console.log(`  ${lbl}  ${pc(acc.filled, acc.n).padStart(7)}  ${pc(acc.tp1, acc.n).padStart(6)}`
      + `  ${pc(acc.stop, acc.n).padStart(6)}  ${pc(acc.expired, acc.n).padStart(6)}`
      + `   ${pc(acc.notTrig, acc.n).padStart(8)}    ${(med(acc.rr) ?? 0).toFixed(2).padStart(6)}`
      + `     ${f3(e.point)}`);
  }
}

console.log(`\n${'═'.repeat(92)}\nAGREGADO ${COINS.join('+')}`);
for (const [lbl, acc] of [['A toque ', TOT.A], ['B cierre', TOT.B], ['C conf+lim', TOT.C]]) {
  const e = expectancyR(acc.rs);
  console.log(`  ${lbl}  llenado ${pc(acc.filled, acc.n)} · tp1 ${pc(acc.tp1, acc.n)} · stop ${pc(acc.stop, acc.n)}`
    + ` · caducó ${pc(acc.expired, acc.n)} · no disparó ${pc(acc.notTrig, acc.n)}`
    + `  |  R:R real ${(med(acc.rr) ?? 0).toFixed(2)}  |  E[R] ${f3(e.point)} [${f3(e.ci_low)}, ${f3(e.ci_high)}]`);
}
const d = (x, y) => ((TOT[y].filled / TOT[y].n - TOT[x].filled / TOT[x].n) * 100).toFixed(1);
const dr = (x, y) => f3((expectancyR(TOT[y].rs).point ?? 0) - (expectancyR(TOT[x].rs).point ?? 0));
console.log(`\n  COSTE frente a la regla actual (A):`);
console.log(`    B cierre     llenado ${d('A','B')} pt · expectativa ${dr('A','B')} R`);
console.log(`    C conf+lim   llenado ${d('A','C')} pt · expectativa ${dr('A','C')} R   ← lo que el setup DICE`);
console.log('  ⚠️ Los IC de arriba NO están corregidos por solape (las formas comparten anclajes).');
console.log('     Sirven para el ORDEN de magnitud del coste, no para afirmar un signo con precisión.');
