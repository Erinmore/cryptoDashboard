#!/usr/bin/env node
/**
 * auditEntryGeometry.mjs — M8: ¿vale algo la geometría de ENTRADA que el producto va a enseñar?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE Y NO EL M8 ORIGINAL
 *
 * M8 se anotó como *"¿bate una geometría determinista a la línea base de +0,004R?"*. Al ir a
 * escribirlo resultó estar **casi contestado por tres mediciones que ya existen**:
 *
 *   · `auditShadowBaseline`   geometría real aplicada en instantes AL AZAR → **+0,004R**
 *                             [−0,036, +0,044], o sea indistinguible de cero.
 *   · `auditConditionalRR`    la expectativa es **PLANA** en todo el rango de R:R (barrido B:
 *                             −0,006 a +0,008R, IC conteniendo 0).
 *   · `auditDirectionalBias`  ninguna regla de dirección bate al azar (fase 0, NO-GO 3 de 3).
 *
 * Dirección sin ventaja + parámetros de geometría sin ventaja ⇒ cualquier setup por regla
 * sale ≈0R. Re-derivarlo sería trabajo circular.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LO QUE SÍ ESTÁ SIN CONTESTAR, Y ES JUSTO LO QUE EL PRODUCTO VA A ENSEÑAR
 *
 * `auditConditionalRR` puso la entrada con `entry = price − sg·K·atr` y `ENTRY_K = 0.75`.
 * Para un short (sg = −1) eso da una entrada POR ENCIMA del precio: **vender más alto**, o
 * sea una entrada a RETROCESO. De ahí salió su +0,204R, que aquel script atribuyó —bien— a
 * *selección por el llenado*: sólo se llena tras un movimiento en contra, y eso captura
 * reversión a la media.
 *
 * **Pero los `conditional_setup` que el sistema emite de verdad son lo CONTRARIO.** Medido
 * sobre los 4 últimos de producción: shorts con la entrada POR DEBAJO del precio (offset
 * −0,73 % a −1,47 %), o sea **vender más bajo** = entradas de ROTURA. La geometría que el
 * producto va a poner en pantalla nunca se ha medido; lo que se midió fue su opuesta.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LA MÉTRICA: EXPECTATIVA POR **OPORTUNIDAD**, NO POR TRADE LLENADO
 *
 * `expectancy_r` se calcula sobre los trades LLENADOS. Para comparar dos reglas de entrada
 * eso es la magnitud equivocada: una orden que no se llena no es una observación que se
 * excluye, es **un trade que no se hizo y renta 0R**. Y las dos reglas tienen tasas de
 * llenado muy distintas por construcción, así que condicionar al llenado compara peras con
 * manzanas — el mismo fallo de denominador que ya mordió cuatro veces aquí.
 *
 *     expectativa por OPORTUNIDAD = tasa_de_llenado × expectativa_condicional
 *
 * Se reportan las tres columnas para que la lectura no dependa de creerse esta elección.
 *
 * CONTROLES
 *   · Las DOS direcciones en cada ancla, agregadas: la deriva del periodo favorece a una y
 *     agregándolas se cancela (mismo método que `auditConditionalRR`).
 *   · `K = 0` (entrada a mercado) es la referencia interna: cualquier efecto de la entrada
 *     tiene que verse como una CURVA alrededor de ese punto, no como un número suelto.
 *   · Anclas DISJUNTAS (separadas por la vigencia) para el intervalo — sin esto el IC sale
 *     ~√6 veces demasiado estrecho.
 *   · Contra-periodo con `OFFSET_DAYS`: sólo usa klines, así que aquí SÍ es posible (al
 *     contrario que en la fase 0, donde el sumando de derivados lo impedía).
 *
 * SOLO LECTURA. Importa `evaluateShadowTrade` y `expectancyR` REALES — la misma tubería que
 * produce el dato de producción, o el número no sería comparable con él.
 *
 * Uso:
 *   node scripts/auditEntryGeometry.mjs
 *   OFFSET_DAYS=270 node scripts/auditEntryGeometry.mjs     # contra-periodo
 *   COINS=SOL DAYS=200 node scripts/auditEntryGeometry.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { evaluateShadowTrade } from '../src/utils/shadowTrade.js';
import { expectancyR } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 180);
const OFFSET_DAYS = Number(process.env.OFFSET_DAYS ?? 0);
const VIGENCIA = Number(process.env.VIGENCIA ?? 6);                 // velas de 4h = 24h, la vigencia típica de producción
const STOP_K = Number(process.env.STOP_K ?? 1);   // stop, en múltiplos de ATR desde la entrada
const TP_K = Number(process.env.TP_K ?? 2);       // TP1, en múltiplos de ATR desde la entrada
const ATR_PERIOD = 14;
const HOUR_MS = 3600 * 1000;
const H4_MS = 4 * HOUR_MS;

// K > 0 = RETROCESO (mejor precio, entrada en contra del movimiento)
// K < 0 = ROTURA    (peor precio, entrada a favor)  ← lo que emite el sistema
const ENTRY_KS = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

async function klines(coin, interval, startMs, endMs) {
  const out = [];
  let start = startMs;
  for (let g = 0; g < 40; g++) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT`
      + `&interval=${interval}&startTime=${start}&endTime=${endMs}&limit=1000`);
    if (!r.ok) throw new Error(`Binance ${coin}/${interval}: HTTP ${r.status}`);
    const b = (await r.json()).map((x) => ({
      t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
    }));
    if (!b.length) break;
    out.push(...b);
    if (b.length < 1000) break;
    start = b.at(-1).t + 1;
  }
  return out;
}

/** R realizado de un shadow trade. Un no-llenado renta 0R: no se hizo el trade. */
function rOf(ev, cs) {
  if (!ev || ev.preserve) return null;
  if (!ev.filled) return 0;
  const risk = Math.abs(cs.entry_price - cs.stop_price);
  if (!(risk > 0)) return null;
  if (!Number.isFinite(ev.exit_price)) return null;
  const sg = cs.direction === 'long' ? 1 : -1;
  return ((ev.exit_price - cs.entry_price) * sg) / risk;
}

/**
 * Cadena de ANCLAS separadas al menos por la vigencia, conservando las DOS direcciones de
 * cada ancla seleccionada.
 *
 * ⚠️ BUG QUE ESTO ARREGLA (cazado por el descuadre punto↔muestra completa). La primera
 * versión encadenaba sobre las FILAS, y las dos direcciones de un ancla comparten `tMs`: al
 * exigir separación >= vigencia, la segunda dirección se descartaba SIEMPRE. La cadena se
 * quedaba con una sola dirección y eso **destruye el control que cancela la deriva** — en un
 * periodo bajista, "siempre largo" da −0,758R donde la muestra completa da −0,251R, con IC
 * que ni se rozan. Es la misma familia de fallo que el bloqueo de fase del brazo de azar en
 * la fase 0: el submuestreo interactuando con la estructura interna del dato.
 */
function disjointRows(rows, offset, sepMs) {
  const times = [...new Set(rows.map((r) => r.tMs))].sort((a, b) => a - b);
  const keep = new Set();
  let last = -Infinity;
  for (let i = offset; i < times.length; i++) {
    if (times[i] - last >= sepMs) { keep.add(times[i]); last = times[i]; }
  }
  return rows.filter((r) => keep.has(r.tMs));
}

async function anchorsFor(coin) {
  const endMs = Date.now() - OFFSET_DAYS * 24 * HOUR_MS;
  const startMs = endMs - (DAYS + 5) * 24 * HOUR_MS;
  const [k4, k1] = await Promise.all([
    klines(coin, '4h', startMs, endMs),
    klines(coin, '1h', startMs, endMs),
  ]);
  if (k4.length < ATR_PERIOD + 6 || !k1.length) return [];
  const lastT = k1.at(-1).t;

  const out = [];
  for (let i = ATR_PERIOD + 1; i < k4.length; i++) {
    const price = k4[i].close;
    const tMs = k4[i].t + H4_MS;                     // el análisis ocurre al CIERRE
    if (!(price > 0)) continue;
    if (lastT < tMs + VIGENCIA * H4_MS) continue;     // sin vigencia completa → fuera
    const atr = calculateATR(k4.slice(Math.max(0, i - ATR_PERIOD - 5), i + 1), ATR_PERIOD);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    out.push({ tMs, price, atr, atrPct: (atr / price) * 100 });
  }
  return out.map((a) => ({ ...a, k1 }));
}

// ─── Medición ────────────────────────────────────────────────────────────────

const f = (x, d = 3) => (x == null ? '  —   ' : (x >= 0 ? '+' : '') + x.toFixed(d));
const pc = (x) => (x == null ? ' — ' : (x * 100).toFixed(1) + '%');

console.log('═'.repeat(96));
console.log('M8 · GEOMETRÍA DE ENTRADA — ¿rota o retroceso? Expectativa por OPORTUNIDAD');
console.log(`${DAYS} d · offset ${OFFSET_DAYS} d · vigencia ${VIGENCIA} velas 4h (24h)`
  + ` · stop ${STOP_K}×ATR · TP ${TP_K}×ATR (R:R ${(TP_K / STOP_K).toFixed(1)})`);
console.log('K<0 = ROTURA (lo que emite el sistema) · K=0 = a mercado · K>0 = RETROCESO');
console.log('⚠️ Un no-llenado renta 0R (no se hizo el trade), NO se excluye del denominador.');
console.log('═'.repeat(96));

const all = new Map(ENTRY_KS.map((k) => [k, []]));

for (const coin of COINS) {
  let anchors;
  try { anchors = await anchorsFor(coin); } catch (e) { console.log(`\n${coin}: ${e.message}`); continue; }
  if (!anchors.length) { console.log(`\n${coin}: sin anclas`); continue; }
  const k1 = anchors[0].k1;

  console.log(`\n${'─'.repeat(96)}\n${coin} · ${anchors.length} anclas`);
  console.log('   K      llenado   E[R|llenado]     E[R]/oportunidad (cadena disjunta)  n_ef   (todas)');

  for (const K of ENTRY_KS) {
    const perOpp = [];        // R de TODAS las oportunidades (0 si no se llenó)
    const perFill = [];       // R sólo de las llenadas — la magnitud "clásica"
    const tagged = [];        // para la cadena disjunta

    for (const a of anchors) {
      for (const dir of ['long', 'short']) {
        const sg = dir === 'long' ? 1 : -1;
        const entry = a.price - sg * K * a.atr;
        const cs = {
          direction: dir, entry_price: entry,
          stop_price: entry - sg * STOP_K * a.atr,
          tp1_price: entry + sg * TP_K * a.atr,
          validity_candles: VIGENCIA, tf_execution: '4h',
        };
        const ev = evaluateShadowTrade({
          conditionalSetup: cs, candles: k1, tMs: a.tMs, primaryTf: '4h', now: Date.now(),
        });
        const r = rOf(ev, cs);
        if (r == null) continue;
        perOpp.push(r);
        if (ev.filled) perFill.push(r);
        tagged.push({ tMs: a.tMs, r });
      }
    }
    if (!perOpp.length) continue;
    all.get(K).push(...tagged);

    // IC sobre anclas DISJUNTAS: se recorren varios arranques y se toma la cadena más larga.
    let best = null;
    for (let off = 0; off < VIGENCIA; off++) {
      const sub = disjointRows(tagged, off, VIGENCIA * H4_MS);
      if (!best || sub.length > best.length) best = sub;
    }
    // ⚠️ EL PUNTO Y EL INTERVALO SALEN DE LA MISMA MUESTRA. La primera versión imprimía la
    // media de TODAS las réplicas junto al IC de la cadena DISJUNTA — dos muestras distintas
    // en la misma línea, que es cómo se publica un punto fuera de su propio intervalo.
    const ci = expectancyR(best.map((x) => x.r));
    const fill = perFill.length / perOpp.length;
    const eFill = perFill.length ? perFill.reduce((s, x) => s + x, 0) / perFill.length : null;
    const eOppAll = perOpp.reduce((s, x) => s + x, 0) / perOpp.length;

    console.log(`  ${String(K).padStart(5)}   ${pc(fill).padStart(6)}    ${f(eFill)}`
      + `        ${f(ci.point)}  [${f(ci.ci_low)}, ${f(ci.ci_high)}]   ${String(ci.n).padStart(4)}`
      + `   ${f(eOppAll)}`);
  }
}

// ─── Agregado ────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(96)}\nAGREGADO ${COINS.join('+')} — expectativa por OPORTUNIDAD, anclas disjuntas`);
console.log('⚠️ Las 3 monedas comparten el factor mercado: el IC conjunto es OPTIMISTA.');
for (const K of ENTRY_KS) {
  const tagged = all.get(K);
  if (!tagged?.length) continue;
  let best = null;
  for (let off = 0; off < VIGENCIA; off++) {
    const sub = disjointRows(tagged, off, VIGENCIA * H4_MS);
    if (!best || sub.length > best.length) best = sub;
  }
  const ci = expectancyR(best.map((x) => x.r));
  const tag = K < 0 ? 'rotura  ' : K > 0 ? 'retroceso' : 'a mercado';
  console.log(`  K=${String(K).padStart(5)} ${tag}  ${f(ci.point)}  [${f(ci.ci_low)}, ${f(ci.ci_high)}]`
    + `  n=${ci.n}${ci.inconclusive ? '  (IC cruza 0)' : '  ← NO cruza 0'}`);
}
console.log('\nLínea base de referencia: +0,004R [−0,036, +0,044] (auditShadowBaseline).');
