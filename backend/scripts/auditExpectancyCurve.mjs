#!/usr/bin/env node
/**
 * auditExpectancyCurve.mjs — M10: la línea base de la EXPECTATIVA, ¿es una curva de una
 * variable? Y si lo es, ¿cuál?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE
 *
 * `summarizeShadowTrades` publica `expectancy_r`, y un `−0,1R` suelto no se sabe si es bueno.
 * `auditShadowBaseline` midió la referencia que faltaba —las MISMAS geometrías aplicadas en
 * instantes al azar— y dio **+0,004R [−0,036, +0,044]**, o sea cero, que es lo que debe dar
 * una geometría sin ventaja.
 *
 * **M8 rompió esa referencia.** Con barreras de 1×/2×ATR la misma aplicación al azar da
 * **−0,22/−0,35R**, y con 1,7×/3,4×ATR da **−0,02/−0,09R**. O sea que la línea base DEPENDE
 * DE LA FORMA: comparar un setup de barreras estrechas contra un +0,004R constante lo haría
 * parecer un desastre siendo sólo otra geometría. Por eso el producto v1 **no enseña**
 * `expectancy_r`, y por eso hace falta esta medición para poder enseñarlo.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LA ARRUGA DE DISEÑO, Y POR QUÉ LA REJILLA ES DE DOS EJES Y NO DE UNO
 *
 * La ficha de M10 supone un solo eje: `anchura_de_barrera / √vigencia`, la misma forma con la
 * que ya colapsaron `TRIGGER_BASE_RATE` y `TARGET_REACHABILITY`. Pero al escribirlo:
 *
 *   **Con la entrada EN el precio de mercado, la expectativa es 0 exacta pongas el stop y el
 *   objetivo donde los pongas.** No es empírico, es aritmética de juego justo: con el stop más
 *   cerca pierdes más veces pero pierdes menos cada vez, y cancela. Ya está comprobado aquí —
 *   `auditConditionalRR` con `ENTRY_K=0` obtuvo un acierto que CALCA el equilibrio
 *   (67,1 vs 66,7 · 57,5 vs 57,1 · 50,0 vs 50,0 · 43,5 vs 44,4).
 *
 * Entonces el −0,3R de M8 no puede venir de la anchura sola: viene de que la entrada **no
 * está en el precio**. Un `conditional_setup` real dice *"entro en 71,90"* con el precio en
 * 72,9, así que la orden sólo se llena si el mercado YA se movió — y eso deja de muestrear
 * "todos los instantes" para muestrear "los instantes después de un movimiento". Ahí se rompe
 * el argumento de juego justo, y por eso hay expectativa distinta de cero.
 *
 * **Luego hay DOS mandos: el desplazamiento de la entrada y la anchura relativa a la
 * vigencia.** La pregunta de M10 pasa a ser si el segundo absorbe al primero.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIRMADAS ANTES DE EJECUTAR
 *
 *   P1 · CONTROL CON RESPUESTA CONOCIDA: en la fila `ENTRY_K = 0` la expectativa debe salir
 *        ≈0 en las VEINTE celdas (5 anchuras × 4 vigencias). Si no sale, el arnés está mal y
 *        nada de lo de abajo se puede leer. Es un control positivo, no un resultado.
 *
 *   P2 · La expectativa de la ROTURA (`ENTRY_K < 0`) se hace MENOS negativa según crece
 *        `d = k/√V`: con barreras anchas para la vigencia la mayoría CADUCA, y un caducado
 *        renta ≈0R. Es el mecanismo que M8 propuso para explicar su discrepancia de 0,3R.
 *
 *   P3 · **El test que decide M10:** celdas con la MISMA `d` pero `(k, V)` distintos deben
 *        coincidir, como coincidieron dentro de 0,3-2,6 pt en `TARGET_REACHABILITY`. La
 *        rejilla está elegida para que existan pares exactos: `d = 0,204` sale de (k=0,5·V=6)
 *        y de (k=1·V=24); `0,408` de (1·6) y (2·24); `0,612` de (1,5·6) y (3·24).
 *
 *   P4 · Si además las filas de distinto `ENTRY_K` se superponen al indexar por `d`, entonces
 *        el eje ES de una variable y la curva se puede enviar como constante. Si NO se
 *        superponen —lo que espero— la línea base necesita los dos ejes, y **entonces el
 *        resultado de M10 es que `expectancy_r` sigue sin poder enseñarse**, pero por un dato
 *        y no por una intuición.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * MÉTRICA — se reportan las DOS, porque no son la misma pregunta
 *
 *   · `E[R | llenado]` es lo que calcula `summarizeShadowTrades` y por tanto **lo que el panel
 *     enseñaría**: es la que necesita línea base.
 *   · `E[R] por oportunidad` (un no llenado renta 0R, no se excluye) es la de M8, y es la
 *     correcta para COMPARAR dos reglas de entrada entre sí, porque sus tasas de llenado
 *     difieren por construcción.
 *
 * CONTROLES
 *   · Las dos direcciones en cada ancla, agregadas: cancela la deriva del periodo.
 *   · Anclas DISJUNTAS para el IC, conservando las dos direcciones de cada ancla — el bug que
 *     M8 cazó (encadenar sobre FILAS colapsa la cadena a una sola dirección y destruye el
 *     control de deriva).
 *   · Contra-periodo con `OFFSET_DAYS`.
 *   · `ENTRY_K = 0` como control positivo con respuesta conocida (P1).
 *
 * SOLO LECTURA. Usa `evaluateShadowTrade` y `expectancyR` REALES, la misma tubería que
 * produce el dato de producción — si el número no sale de ahí, no es comparable con él.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * ▶ RESULTADO (2026-08-04) — **la curva de M10 NO EXISTE, y el motivo es mejor que la curva**
 *
 * 180 d × SOL/BTC/ETH · 100 celdas · 631.200 réplicas · contra-periodo a −270 d · control de
 * R:R a 1,5. **P1 pasa:** con la entrada a mercado los 20 IC contienen el cero.
 *
 * 1 · **NO hay curva en `d = k/√V`, y el cuadro crudo dice por qué: la VIGENCIA NO IMPORTA.**
 *     Para (e=−1, k=0,5) la expectativa sale −0,622 / −0,625 / −0,615 / −0,626 con V =
 *     6/12/24/42 velas — cuatro cifras planas donde `d` cambia por un factor 2,6. El test de
 *     colapso falla en consecuencia: |Δ| hasta **0,49R** entre celdas de la misma `d`, cuando
 *     en `TARGET_REACHABILITY` eran 0,3-2,6 **puntos porcentuales**. **P2 queda REFUTADA tal
 *     como se firmó**: lo que aplana la expectativa es que el stop sea ancho, no que caduque.
 *
 * 2 · Tampoco colapsa por el eje alternativo `k/|e|` que el mecanismo sugería (|Δ| 0,33R y
 *     0,18R en los dos cocientes con más celdas). Se deja medido para que nadie lo reintente.
 *
 * 3 · **Lo que sí hay es una MESETA y un rincón.** Con el stop a >= 1,5×ATR de la entrada, las
 *     45 celdas caen entre −0,06 y +0,08R sea cual sea la entrada, la vigencia y el R:R. Todo
 *     el efecto vive en la columna del stop a 0,5×ATR: −0,62 / −0,45 / −0,16 según la entrada
 *     esté a 1 / 0,5 / 0,25 ATR.
 *
 * 4 · **Y ese rincón NO ES DEL MERCADO: es el convenio de empate del evaluador.** Medido con
 *     el contrafactual de `auditBarrierTies` (sustituir la vela de fill por una de rango cero,
 *     sin reimplementar el barrier):
 *
 *        e=−1,00 · k=0,5 → **66,2 %** de los llenados tienen entrada y stop en la MISMA vela
 *                          de 1h · ΔR **+0,656** sobre un observado de −0,622  ⇒  +0,034
 *        e=−0,50 · k=0,5 → 49,2 % · ΔR +0,464 sobre −0,446                     ⇒  +0,018
 *        e=−0,25 · k=0,5 → 22,1 % · ΔR +0,182 sobre −0,160                     ⇒  +0,022
 *        stop >= 1,5×ATR → <3 % de empates y ΔR <0,03R en todas las celdas
 *
 *     **Ninguno de los dos convenios es el correcto**: el orden intra-vela no es observable a
 *     resolución de 1h. Lo honesto es la BANDA que ambos acotan — y donde mide 0,66R de ancho,
 *     esa celda sencillamente **no tiene línea base legible**.
 *
 * 5 · Replica en las 3 monedas (−0,48/−0,50/−0,45 en la fila de la rotura real) y en el
 *     contra-periodo (−0,554 con 60,8 % de empates y ΔR +0,610). Y es **indiferente al R:R**
 *     (−0,635 con R:R 1,5 contra −0,622 con 2,0), como ya decía `auditConditionalRR`.
 *
 * ⚠️ **RECLASIFICA EL MECANISMO QUE PROPUSO M8.** M8 explicó su discrepancia de 0,3R con
 *    *"barreras estrechas ⇒ casi todo RESUELVE y la asimetría 2:1 muerde"*, que es una
 *    afirmación sobre el MERCADO. Los números de arriba dicen que el mecanismo dominante es
 *    la resolución de 1h del evaluador: en la celda de M8 (e=−1, k=1) los empates son el
 *    18,1 % y ΔR **+0,172** sobre un observado de −0,118. La aritmética de M8 no era falsa
 *    —las barreras estrechas sí resuelven más— pero la causa del signo no era la que se
 *    escribió.
 *
 * ▶ CONSECUENCIA PARA EL PRODUCTO — **y es una respuesta ÚTIL, no un NO-GO seco:**
 *
 *   · La línea base **no necesita curva**. Es **+0,004R** —el número que `auditShadowBaseline`
 *     ya publicó— y ahora se sabe que es robusto: plano en vigencia, en R:R, en desplazamiento
 *     de entrada y entre monedas, **siempre que el stop esté a >= 1,5×ATR de la entrada**.
 *   · Los `conditional_setup` reales llevan el stop a **~1,7×ATR** (medido en M8), o sea que
 *     **caen dentro de la meseta**. Para ellos `expectancy_r` SÍ se puede enseñar contra
 *     +0,004R.
 *   · Lo que hay que hacer no es una curva, es una **GUARDA**: si un setup declara el stop a
 *     menos de ~1,5×ATR de la entrada, su expectativa no se enseña, porque el convenio de
 *     empate la mueve más que cualquier ventaja que pudiera tener. Es el mismo patrón que
 *     `TARGET_UNREACHABLE_PCT`: no un número que pintar, sino una condición para callarse.
 *
 * Uso:
 *   node scripts/auditExpectancyCurve.mjs
 *   OFFSET_DAYS=270 node scripts/auditExpectancyCurve.mjs     # contra-periodo
 *   COINS=SOL DAYS=200 node scripts/auditExpectancyCurve.mjs
 *   RR=1.5 node scripts/auditExpectancyCurve.mjs              # control: ¿depende del R:R?
 */

import { calculateATR } from '../src/utils/indicators.js';
import { evaluateShadowTrade } from '../src/utils/shadowTrade.js';
import { expectancyR } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 180);
const OFFSET_DAYS = Number(process.env.OFFSET_DAYS ?? 0);
const RR = Number(process.env.RR ?? 2);        // objetivo = RR × stop. 2 es el de los setups reales
const ATR_PERIOD = 14;
const HOUR_MS = 3600 * 1000;
const H4_MS = 4 * HOUR_MS;

/** Desplazamiento de la entrada, en ATR. <0 = ROTURA (lo que emite el sistema) · 0 = a mercado. */
const ENTRY_KS = [-1, -0.5, -0.25, 0, 0.5];
/** Anchura del stop desde la entrada, en ATR. */
const STOP_KS = [0.5, 1, 1.5, 2, 3];
/** Vigencia en velas del TF primario (4h). 42 = 7 d, justo el borde de la ventana del evaluador. */
const VALIDITIES = [6, 12, 24, 42];

const MAX_V = Math.max(...VALIDITIES);
const dOf = (k, v) => k / Math.sqrt(v);

// ─── Datos ───────────────────────────────────────────────────────────────────

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

/**
 * Anclas de 4h con su ATR y **su tramo de velas de 1h ya recortado**.
 *
 * El recorte por ancla NO es cosmético: `evaluateShadowTrade` llama a `candlesWithinValidity`,
 * que filtra el array ENTERO en cada evaluación. Con 100 celdas × 2 direcciones eso serían
 * cientos de millones de comparaciones contra las ~4.300 velas del periodo. Recortando una vez
 * por ancla (con un puntero que avanza, no un filter por ancla) cada evaluación ve ~170 velas.
 */
async function anchorsFor(coin) {
  const endMs = Date.now() - OFFSET_DAYS * 24 * HOUR_MS;
  const startMs = endMs - (DAYS + 5) * 24 * HOUR_MS;
  const [k4, k1] = await Promise.all([
    klines(coin, '4h', startMs, endMs),
    klines(coin, '1h', startMs, endMs),
  ]);
  if (k4.length < ATR_PERIOD + 6 || !k1.length) return [];
  const lastT = k1.at(-1).t;
  const needMs = MAX_V * H4_MS;

  const out = [];
  let p = 0;                                   // puntero sobre k1, avanza monótonamente
  for (let i = ATR_PERIOD + 1; i < k4.length; i++) {
    const price = k4[i].close;
    const tMs = k4[i].t + H4_MS;               // el análisis ocurre al CIERRE de la vela
    if (!(price > 0)) continue;
    if (lastT < tMs + needMs) continue;         // sin la vigencia MÁS LARGA completa → fuera,
                                                // para que todas las celdas compartan anclas
    const atr = calculateATR(k4.slice(Math.max(0, i - ATR_PERIOD - 5), i + 1), ATR_PERIOD);
    if (!Number.isFinite(atr) || atr <= 0) continue;
    while (p < k1.length && k1[p].t < tMs) p++;
    const sub = k1.slice(p, p + MAX_V * 4 + 4);
    if (!sub.length) continue;
    out.push({ tMs, price, atr, sub });
  }
  return out;
}

// ─── R de una réplica ────────────────────────────────────────────────────────

/**
 * R realizado. Un NO LLENADO renta 0R (no se hizo el trade), no se excluye.
 * @returns {{r:number, filled:boolean}|null} null ⇒ la réplica no es utilizable.
 */
function replicate(a, dir, entryK, stopK, v, now) {
  const sg = dir === 'long' ? 1 : -1;
  const entry = a.price - sg * entryK * a.atr;
  const cs = {
    direction: dir,
    entry_price: entry,
    stop_price: entry - sg * stopK * a.atr,
    tp1_price: entry + sg * stopK * RR * a.atr,
    validity_candles: v,
    tf_execution: '4h',
  };
  const ev = evaluateShadowTrade({
    conditionalSetup: cs, candles: a.sub, tMs: a.tMs, primaryTf: '4h', now,
  });
  if (!ev || ev.preserve) return null;
  // 'open'/'truncated' = la ventana no ha vencido o no alcanza: no es un 0R, es un no-dato.
  if (ev.outcome === 'open' || ev.outcome === 'truncated') return null;
  if (!ev.filled) return { r: 0, filled: false };
  const risk = Math.abs(cs.entry_price - cs.stop_price);
  if (!(risk > 0) || !Number.isFinite(ev.exit_price)) return null;
  return { r: ((ev.exit_price - cs.entry_price) * sg) / risk, filled: true };
}

/**
 * Cadena de anclas separadas al menos por `sepMs`, conservando las DOS direcciones de cada
 * ancla seleccionada. Se encadena sobre los INSTANTES, no sobre las filas: las dos direcciones
 * comparten `tMs`, así que encadenar sobre filas descarta siempre la segunda y deja la cadena
 * con una sola dirección — el bug que destruyó el control de deriva en M8.
 */
function disjoint(rows, offset, sepMs) {
  const times = [...new Set(rows.map((r) => r.tMs))].sort((x, y) => x - y);
  const keep = new Set();
  let last = -Infinity;
  for (let i = offset; i < times.length; i++) {
    if (times[i] - last >= sepMs) { keep.add(times[i]); last = times[i]; }
  }
  return rows.filter((r) => keep.has(r.tMs));
}

/** IC sobre la cadena disjunta más larga. Punto e intervalo salen de la MISMA muestra. */
function ciDisjoint(rows, v) {
  let best = null;
  for (let off = 0; off < v; off++) {
    const sub = disjoint(rows, off, v * H4_MS);
    if (!best || sub.length > best.length) best = sub;
  }
  return expectancyR(best.map((x) => x.r));
}

// ─── Medición ────────────────────────────────────────────────────────────────

const f = (x, d = 3) => (x == null ? '   —  ' : (x >= 0 ? '+' : '') + x.toFixed(d));
const pc = (x) => (x == null ? ' — ' : (x * 100).toFixed(0) + '%');

console.log('═'.repeat(104));
console.log('M10 · LÍNEA BASE DE LA EXPECTATIVA — ¿curva de una variable?');
console.log(`${DAYS} d · offset ${OFFSET_DAYS} d · ${COINS.join('+')} · R:R ${RR} · TF 4h`);
console.log(`ejes: ENTRY_K (${ENTRY_KS.join(', ')}) × stop en ATR (${STOP_KS.join(', ')})`
  + ` × vigencia (${VALIDITIES.join(', ')} velas) = ${ENTRY_KS.length * STOP_KS.length * VALIDITIES.length} celdas`);
console.log('ENTRY_K<0 = ROTURA (lo que emite el sistema) · 0 = a mercado · >0 = retroceso');
console.log('═'.repeat(104));

const now = Date.now();
/** clave `${entryK}|${stopK}|${v}` → réplicas de TODAS las monedas. */
const pooled = new Map();
const perCoin = new Map();
/** Anclas por moneda, conservadas para el diagnóstico de empates (P6). Los `sub` son slices
 *  del mismo array de klines, así que no duplican velas en memoria. */
const anchorsByCoin = new Map();

for (const coin of COINS) {
  let anchors;
  try { anchors = await anchorsFor(coin); } catch (e) { console.log(`\n${coin}: ${e.message}`); continue; }
  if (!anchors.length) { console.log(`\n${coin}: sin anclas`); continue; }
  anchorsByCoin.set(coin, anchors);

  const cells = new Map();
  let dropped = 0;
  for (const entryK of ENTRY_KS) {
    for (const stopK of STOP_KS) {
      for (const v of VALIDITIES) {
        const key = `${entryK}|${stopK}|${v}`;
        const rows = [];
        for (const a of anchors) {
          for (const dir of ['long', 'short']) {
            const x = replicate(a, dir, entryK, stopK, v, now);
            if (!x) { dropped++; continue; }
            rows.push({ tMs: a.tMs, r: x.r, filled: x.filled });
          }
        }
        cells.set(key, rows);
        if (!pooled.has(key)) pooled.set(key, []);
        pooled.get(key).push(...rows);
      }
    }
  }
  perCoin.set(coin, cells);
  console.log(`\n${coin}: ${anchors.length} anclas · ${[...cells.values()].reduce((s, r) => s + r.length, 0)} réplicas`
    + `${dropped ? ` · ${dropped} descartadas (ventana sin vencer)` : ' · 0 descartadas'}`);
}

if (!pooled.size) { console.log('\nSin datos.'); process.exit(1); }

/**
 * ⚠️ CADA PUNTO CON EL IC DE SU PROPIA MUESTRA. La primera versión daba `eFill` sobre TODAS
 * las réplicas llenadas y a su lado el IC de la cadena disjunta de TODAS las réplicas
 * (llenadas y no llenadas, éstas a 0R) — dos estadísticos distintos en la misma línea, que es
 * cómo se publica un punto fuera de su propio intervalo. Salió a la vista literalmente así:
 * `-0.630` con IC `[-0.46, -0.27]`. Es el mismo fallo que M8 cazó y que su cabecera avisa.
 */
const statsOf = (rows, v) => {
  const filled = rows.filter((x) => x.filled);
  return {
    n: rows.length,
    fill: rows.length ? filled.length / rows.length : null,
    eFill: filled.length ? filled.reduce((s, x) => s + x.r, 0) / filled.length : null,
    eOpp: rows.length ? rows.reduce((s, x) => s + x.r, 0) / rows.length : null,
    ciFill: ciDisjoint(filled, v),   // IC de E[R | llenado]  ← sólo las llenadas
    ciOpp: ciDisjoint(rows, v),      // IC de E[R] por oportunidad ← todas
  };
};

// ── P1 · CONTROL con respuesta conocida ──────────────────────────────────────
console.log(`\n${'═'.repeat(104)}`);
console.log('P1 · CONTROL — con la entrada A MERCADO (ENTRY_K=0) la expectativa DEBE salir ≈0 en las 20 celdas.');
console.log('     No es un resultado: si falla, el arnés está mal y nada de lo de abajo se puede leer.');
console.log('═'.repeat(104));
console.log('  stop×ATR  vigencia    d=k/√V   llenado   E[R|llenado]        IC95                       n_ef');
console.log('  (punto e intervalo salen AMBOS de la cadena disjunta — nunca de muestras distintas)');
let worst = 0;
for (const stopK of STOP_KS) {
  for (const v of VALIDITIES) {
    const s = statsOf(pooled.get(`0|${stopK}|${v}`), v);
    worst = Math.max(worst, Math.abs(s.ciFill.point ?? 0));
    console.log(`  ${String(stopK).padStart(7)}  ${String(v).padStart(7)}   ${dOf(stopK, v).toFixed(3).padStart(7)}`
      + `   ${pc(s.fill).padStart(6)}   ${f(s.ciFill.point).padStart(11)}`
      + `      [${f(s.ciFill.ci_low)}, ${f(s.ciFill.ci_high)}]   ${String(s.ciFill.n).padStart(5)}`);
  }
}
console.log(`\n  → desviación máxima del cero: ${worst.toFixed(3)}R`);

// ── ¿Manda la vigencia, o manda la anchura? Cuadro k × V, sin normalizar ─────
console.log(`\n${'═'.repeat(104)}`);
console.log('P2 · E[R | llenado] en el cuadro CRUDO  anchura_stop (ATR) × vigencia (velas 4h)');
console.log('     Si el eje fuera k/√V, cada diagonal (k∝√V) sería plana. Mirar si lo es.');
console.log('     (medias de la MUESTRA COMPLETA, sin IC: aquí interesa la forma del cuadro, no el signo de una celda)');
console.log('═'.repeat(104));
for (const entryK of ENTRY_KS) {
  console.log(`\n  ENTRY_K = ${entryK}${entryK < 0 ? '  (rotura)' : entryK > 0 ? '  (retroceso)' : '  (a mercado — control)'}`);
  console.log('    stop\\V ' + VALIDITIES.map((v) => String(v).padStart(9)).join('') + '     llenado');
  for (const k of STOP_KS) {
    const cells = VALIDITIES.map((v) => statsOf(pooled.get(`${entryK}|${k}|${v}`), v));
    console.log(`    ${String(k).padStart(5)}  `
      + cells.map((s) => f(s.eFill, 3).padStart(9)).join('')
      + '     ' + cells.map((s) => pc(s.fill)).join('/'));
  }
}

// ── P2 · La curva por fila de entrada ────────────────────────────────────────
console.log(`\n${'═'.repeat(104)}`);
console.log('P4 · E[R | llenado] indexada por d = anchura_stop / √vigencia');
console.log('     Si las filas de distinto ENTRY_K se SUPERPONEN, el eje es de UNA variable (P4).');
console.log('     (medias de la MUESTRA COMPLETA, sin IC)');
console.log('═'.repeat(104));
const buckets = new Map();   // d redondeada → [k,v]
for (const k of STOP_KS) for (const v of VALIDITIES) {
  const d = parseFloat(dOf(k, v).toFixed(3));
  if (!buckets.has(d)) buckets.set(d, []);
  buckets.get(d).push([k, v]);
}
const ds = [...buckets.keys()].sort((a, b) => a - b);
console.log('  ENTRY_K  ' + ds.map((d) => d.toFixed(3).padStart(7)).join(''));
for (const entryK of ENTRY_KS) {
  const row = ds.map((d) => {
    const rows = [];
    let vRef = 0;
    for (const [k, v] of buckets.get(d)) { rows.push(...pooled.get(`${entryK}|${k}|${v}`)); vRef = Math.max(vRef, v); }
    const s = statsOf(rows, vRef);
    return (s.eFill == null ? '   —  ' : f(s.eFill, 2)).padStart(7);
  }).join('');
  console.log(`  ${String(entryK).padStart(7)}  ${row}`);
}
console.log('\n  (mismo cuadro, expectativa por OPORTUNIDAD — un no llenado renta 0R)');
console.log('  ENTRY_K  ' + ds.map((d) => d.toFixed(3).padStart(7)).join(''));
for (const entryK of ENTRY_KS) {
  const row = ds.map((d) => {
    const rows = [];
    for (const [k, v] of buckets.get(d)) rows.push(...pooled.get(`${entryK}|${k}|${v}`));
    const s = statsOf(rows, 6);
    return (s.eOpp == null ? '   —  ' : f(s.eOpp, 2)).padStart(7);
  }).join('');
  console.log(`  ${String(entryK).padStart(7)}  ${row}`);
}

// ── P3 · EL TEST DE COLAPSO ──────────────────────────────────────────────────
console.log(`\n${'═'.repeat(104)}`);
console.log('P3 · TEST DE COLAPSO — celdas con la MISMA d y (k,V) DISTINTOS. Si el eje vale, coinciden.');
console.log('═'.repeat(104));
const pairs = ds.filter((d) => buckets.get(d).length > 1);
if (!pairs.length) console.log('  (la rejilla no produjo ninguna d repetida)');
for (const entryK of ENTRY_KS) {
  for (const d of pairs) {
    const parts = buckets.get(d).map(([k, v]) => {
      const s = statsOf(pooled.get(`${entryK}|${k}|${v}`), v);
      return { k, v, e: s.ciFill.point, ciFill: s.ciFill };
    });
    const vals = parts.map((p) => p.e).filter(Number.isFinite);
    const spread = vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : null;
    console.log(`  ENTRY_K ${String(entryK).padStart(5)}  d=${d.toFixed(3)}   `
      + parts.map((p) => `k=${p.k}/V=${p.v}: ${f(p.e, 3)} [${f(p.ciFill.ci_low, 2)},${f(p.ciFill.ci_high, 2)}]`).join('   ')
      + `   |Δ| ${spread == null ? '—' : spread.toFixed(3)}R`);
  }
}

// ── EJE ALTERNATIVO · el que los datos señalan ───────────────────────────────
//
// Si el colapso por `d` falla, la siguiente hipótesis no es libre: el mecanismo dice cuál es.
// Con la entrada desplazada `|e|` ATR desde el precio y el stop a `k` ATR de la ENTRADA, el
// stop queda a `k − |e|` ATR del precio ORIGINAL. Cuando `k < |e|` el stop está ENTRE la
// entrada y el punto de partida, así que un simple retroceso al precio de salida ya te saca:
// la geometría se vuelve casi imposible por construcción, sin que el mercado tenga que hacer
// nada. Eso predice que el mando es el COCIENTE `k / |e|`, no `k / √V`.
console.log(`\n${'═'.repeat(104)}`);
console.log('P5 · EJE ALTERNATIVO — E[R | llenado] indexada por  k / |ENTRY_K|  (stop ÷ desplazamiento)');
console.log('     Mecanismo: con k < |e| el stop cae ENTRE la entrada y el precio de partida, así que');
console.log('     un retroceso al punto de salida basta para saltarlo. Predice que el mando es este cociente.');
console.log('═'.repeat(104));
const ratioBuckets = new Map();
for (const e of ENTRY_KS) {
  if (e >= 0) continue;                       // el cociente sólo tiene sentido con entrada desplazada
  for (const k of STOP_KS) for (const v of VALIDITIES) {
    const r = parseFloat((k / Math.abs(e)).toFixed(2));
    if (!ratioBuckets.has(r)) ratioBuckets.set(r, []);
    ratioBuckets.get(r).push({ e, k, v });
  }
}
console.log('  k/|e|    E[R|llenado]        IC (anclas disjuntas)      n_ef   celdas (e,k,V) que agrupa');
for (const r of [...ratioBuckets.keys()].sort((a, b) => a - b)) {
  const combos = ratioBuckets.get(r);
  const rows = [];
  for (const c of combos) rows.push(...pooled.get(`${c.e}|${c.k}|${c.v}`));
  const s = statsOf(rows, 6);
  const uniq = [...new Set(combos.map((c) => `${c.e}/${c.k}`))];
  console.log(`  ${String(r).padStart(5)}   ${f(s.ciFill.point).padStart(11)}`
    + `      [${f(s.ciFill.ci_low)}, ${f(s.ciFill.ci_high)}]   ${String(s.ciFill.n).padStart(5)}`
    + `   ${uniq.length} pares e/k: ${uniq.slice(0, 6).join(' ')}`);
}
console.log('\n  DISPERSIÓN DENTRO DE CADA COCIENTE (si el eje vale, las celdas de una misma fila coinciden):');
for (const r of [...ratioBuckets.keys()].sort((a, b) => a - b)) {
  const combos = ratioBuckets.get(r);
  const byPair = new Map();
  for (const c of combos) {
    const key = `e=${c.e}/k=${c.k}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(...pooled.get(`${c.e}|${c.k}|${c.v}`));
  }
  const vals = [...byPair.entries()].map(([key, rows]) => ({ key, e: statsOf(rows, 6).eFill }))
    .filter((x) => Number.isFinite(x.e));
  if (vals.length < 2) continue;
  const spread = Math.max(...vals.map((x) => x.e)) - Math.min(...vals.map((x) => x.e));
  console.log(`  k/|e| = ${String(r).padStart(5)}   |Δ| ${spread.toFixed(3)}R   `
    + vals.map((x) => `${x.key}: ${f(x.e, 2)}`).join('  '));
}

// ── Réplica por moneda de la fila que importa ────────────────────────────────
console.log(`\n${'═'.repeat(104)}`);
console.log('RÉPLICA POR MONEDA — fila ENTRY_K=-0,5 (la ROTURA que emite el sistema), E[R|llenado]');
console.log('═'.repeat(104));
console.log('  moneda   ' + ds.map((d) => d.toFixed(3).padStart(7)).join(''));
for (const [coin, cells] of perCoin) {
  const row = ds.map((d) => {
    const rows = [];
    for (const [k, v] of buckets.get(d)) rows.push(...(cells.get(`-0.5|${k}|${v}`) ?? []));
    const s = statsOf(rows, 6);
    return (s.eFill == null ? '   —  ' : f(s.eFill, 2)).padStart(7);
  }).join('');
  console.log(`  ${coin.padEnd(8)} ${row}`);
}

// ── P6 · ¿ES MERCADO O ES EL EVALUADOR? ──────────────────────────────────────
//
// El rincón negativo aparece cuando el stop es ESTRECHO (0,5×ATR). Y hay una explicación que
// no es del mercado: `evaluateSetupBarrier` mira el stop ANTES que el TP1 dentro de la misma
// vela de 1h porque el orden intra-vela no es resoluble, y **la vela de fill también se
// comprueba contra el stop**. Cuanto más juntos estén entrada y stop, más a menudo caen en la
// misma vela y más muerde ese convenio. `auditBarrierTies` ya lo midió para las geometrías
// REALES: el 4,83 % de los llenados, y resolverlo al revés mueve +0,0527R.
//
// Aquí se mide POR CELDA, con el mismo contrafactual y sin reimplementar el barrier:
// se sustituye la vela de fill por una de rango cero en la entrada (llena y no resuelve).
console.log(`\n${'═'.repeat(104)}`);
console.log('P6 · ¿MERCADO O EVALUADOR? — empate entrada↔stop en la MISMA vela de 1h, por celda (V=6)');
console.log('     Convenio actual: la vela de fill se comprueba contra el stop (conservador y declarado).');
console.log('     ΔR = cuánto se movería la expectativa resolviendo el empate al revés.');
console.log('═'.repeat(104));
console.log('  ENTRY_K  stop×ATR   llenadas   empate e↔s   ΔR de la celda   E[R] actual → convenio opuesto   ¿determinado?');
const AMBIG_MAX = 0.05;   // por encima de esto la celda no tiene línea base legible
const touches = (c, lvl) => c.low <= lvl && lvl <= c.high;
for (const entryK of ENTRY_KS) {
  for (const k of STOP_KS) {
    let filled = 0, ties = 0, dSum = 0, dN = 0;
    for (const [, anchors] of anchorsByCoin) {
      for (const a of anchors) {
        for (const dir of ['long', 'short']) {
          const sg = dir === 'long' ? 1 : -1;
          const entry = a.price - sg * entryK * a.atr;
          const cs = {
            direction: dir, entry_price: entry,
            stop_price: entry - sg * k * a.atr, tp1_price: entry + sg * k * RR * a.atr,
            validity_candles: 6, tf_execution: '4h',
          };
          const ev = evaluateShadowTrade({ conditionalSetup: cs, candles: a.sub, tMs: a.tMs, primaryTf: '4h', now });
          if (!ev || ev.preserve || !ev.filled || !Number.isFinite(ev.exit_price)) continue;
          filled++;
          const risk = Math.abs(cs.entry_price - cs.stop_price);
          const r = ((ev.exit_price - cs.entry_price) * sg) / risk;
          // Localiza la vela de fill y comprueba si TAMBIÉN toca el stop.
          const c = a.sub.find((x) => touches(x, cs.entry_price));
          if (!c || !touches(c, cs.stop_price)) continue;
          ties++;
          const rest = a.sub.filter((x) => x.t > c.t);
          const alt = evaluateShadowTrade({
            conditionalSetup: cs,
            candles: [{ t: c.t, open: entry, high: entry, low: entry, close: entry }, ...rest],
            tMs: a.tMs, primaryTf: '4h', now,
          });
          if (alt && !alt.preserve && Number.isFinite(alt.exit_price)) {
            dSum += (((alt.exit_price - cs.entry_price) * sg) / risk) - r;
            dN++;
          }
        }
      }
    }
    const s = statsOf(pooled.get(`${entryK}|${k}|6`), 6);
    const dR = dN ? dSum / filled : 0;
    // Ninguno de los dos convenios es "el correcto": el orden intra-vela no es observable a
    // 1h. Lo honesto es la BANDA que los dos acotan. Si es ancha, esa celda simplemente NO
    // TIENE línea base legible, y ningún `expectancy_r` suyo se puede interpretar.
    console.log(`  ${String(entryK).padStart(7)}  ${String(k).padStart(8)}   ${String(filled).padStart(8)}`
      + `   ${(filled ? (ties / filled * 100).toFixed(1) : '—').padStart(9)}%`
      + `   ${f(dR).padStart(13)}`
      + `   ${f(s.eFill).padStart(11)} → ${f((s.eFill ?? 0) + dR).padStart(7)}`
      + `        ${Math.abs(dR) <= AMBIG_MAX ? 'sí' : `NO (banda ${Math.abs(dR).toFixed(2)}R)`}`);
  }
}

console.log('\n  ⚠️ Las 3 monedas comparten el factor mercado: cualquier IC conjunto es OPTIMISTA.');
console.log('  Línea base de referencia con la geometría real: +0,004R [−0,036, +0,044] (auditShadowBaseline).\n');
