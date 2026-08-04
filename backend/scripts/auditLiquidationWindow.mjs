#!/usr/bin/env node
/**
 * auditLiquidationWindow.mjs — M1 + M5: la ventana rodante de 24 h de las liquidaciones se
 * cuenta POR POSICIÓN, no por tiempo. ¿Cuánto cambia eso, y aguantan los cortes?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * M1 · EL DEFECTO
 *
 * `coinalyzeService.fetchLiquidations` construye las dos piezas de la cascada con `slice`
 * sobre el array de la API:
 *
 *     const last24h  = hist.slice(-24);              // ventana ACTUAL  → skew y numerador
 *     for (i=24..)  const w = hist.slice(i-24, i);   // ventanas para la MEDIANA de 30 d
 *
 * Coinalyze **omite las horas sin liquidaciones** en vez de mandarlas a 0 (verificado sobre
 * los 88-90 días archivados: CERO filas con total 0, y 50 horas ausentes en SOL · 7 en
 * BTC/ETH, en rachas de 1-2 h). Así que 24 FILAS no son 24 HORAS: cuando hay huecos, la
 * ventana alcanza más atrás en el tiempo y suma de más.
 *
 * Es propiedad del código ya desplegado, no la introduce la serie `liquidations_1h`. Lo que
 * esa serie aporta es la posibilidad de MEDIRLO: la ventana de 90 días de la API rueda y
 * olvida, y esta comparación exige tener la resolución horaria guardada.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIRMADAS ANTES DE EJECUTAR
 *
 *   P1 · La inflación existe pero es MINORITARIA y asimétrica entre monedas: SOL (2,3 % de
 *        horas ausentes) tendrá bastantes más ventanas de >24 h que BTC/ETH (0,3 %).
 *
 *   P2 · La inflación se concentra en los tramos TRANQUILOS — un hueco es, por definición,
 *        una hora sin liquidaciones — así que la MEDIANA sube bajo la regla posicional.
 *
 *   P3 · **Y por eso NO se cancela en el caso que importa.** Durante una cascada no hay
 *        huecos, luego el numerador NO se infla mientras el denominador SÍ: la magnitud sale
 *        más baja y la cascada se vuelve más difícil de disparar. Predicción con signo: la
 *        ventana TEMPORAL dispara la cascada al menos tan a menudo como la posicional.
 *
 *        ⚠️ Esto MATIZA la predicción original de la ficha M1 ("numerador y denominador se
 *        inflan a la vez, así que el cociente cancela en parte"). Cancela en promedio; no
 *        cancela condicionado a que haya cascada, que es justo cuando la regla decide.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * M5 · LOS CORTES
 *
 * `cascade_skew_max = -0.5` y `cascade_magnitude_mult = 2` se calibraron con
 * `auditLiquidations.mjs`, que usa **la misma ventana posicional** (`liqHist.slice(i-24, i)`).
 * Si la ventana corregida desplaza la distribución que bucketizan, los cortes hay que
 * re-leerlos sobre ella — la regla que este proyecto no negocia. Criterio de lectura, el de
 * T1-T6: por debajo del 5 % es RAMA MUERTA; entre 45 y 55 % es MONEDA AL AIRE.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * MÉTODO
 *
 * Fuente: la serie de archivo `history_series / liquidations_1h` (88-90 d × 3 monedas), NO la
 * API — así el contrafactual se mide sobre exactamente las mismas horas en las dos ramas.
 * Anclajes cada 4 h (el TF primario de producción) con **mediana de 30 días COMPLETA**, que
 * es el régimen en el que opera producción por el guard `cascade_min_points: 620`; medir con
 * la mediana a medio formar fue el defecto que ya diluyó la señal casi a la mitad
 * (auditDerivativesRubric / auditLiquidations, 2026-07-30).
 *
 * SOLO LECTURA: abre la BBDD en modo readonly y no toca producción ni la ruta de decisión.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * ▶ RESULTADO (2026-08-04) — **F1 es casi un no-op: el defecto es real y no decide nada**
 *
 * Sobre el snapshot de la Pi (88-90 d × 3 monedas, ~345 anclajes/moneda con mediana de 30 d
 * COMPLETA). Control de fidelidad: `median_window_points` sale 689-697, que es lo que produce
 * el fetch real (720 h menos huecos menos 23) — el arnés simula la producción que dice.
 *
 *   P1 ✔ y más fuerte de lo previsto en SOL: la ventana posicional abarca **>24 h el 27,5 %**
 *        del tiempo (p90 26 h, máx 29 h) frente al **3,2-3,5 % en BTC/ETH**. La asimetría
 *        entre monedas es la predicha, la magnitud en SOL no.
 *
 *   P2 ✔ pero pequeño: la mediana posicional queda **×1,0087** (p90 1,0498) en SOL y
 *        **×1,0000** en BTC/ETH.
 *
 *   P3 ✔ en signo, por debajo de la resolución en tamaño. La magnitud posicional sale
 *        **×0,9955** en SOL —o sea la cascada más difícil, como predecía el mecanismo— y la
 *        ventana corregida dispara **5,2 % frente a 4,3 %** (4 anclajes que sólo disparan con
 *        la temporal contra 1 que sólo con la posicional, de 349). En **BTC y ETH la
 *        coincidencia es EXACTA: 0 discrepancias**. Los IC de Wilson de 15/349 y 18/349 se
 *        solapan casi enteros → «sugerente, no establecido», el veredicto de siempre.
 *
 *   ⚠️ Y hay una cola que el promedio esconde: en SOL el NUMERADOR llega a inflarse **×3,5**
 *      en algún anclaje suelto (la ventana alcanza hacia atrás y se traga una hora grande
 *      fuera de las 24). No cambia la tasa agregada, pero sí puede cambiar un análisis
 *      concreto — que es el que ve el usuario.
 *
 *   M5 · **Los cortes NO se mueven.** Con la ventana temporal, `skew <= -0,5` sale 31,8 /
 *        25,9 / 16,3 % y `magnitud >= 2×` 11,5 / 7,5 / 10,5 % (SOL/BTC/ETH), contra 32,7 /
 *        25,9 / 16,3 y 10,0 / 7,5 / 10,5 con la posicional. Ninguna celda cruza a rama muerta
 *        ni a moneda al aire por el cambio de ventana. **No hay nada que recalibrar.**
 *
 * ⚠️ HALLAZGO COLATERAL, ABIERTO: **la tasa de cascada NO es estable entre ventanas, y el
 *    propio `auditLiquidations` no reproduce hoy su cifra publicada.** Re-ejecutado el
 *    2026-08-04, da (mediana 30 d completa · skew<=-0,5 · mag>=2×) **SOL 4,1 % · BTC 5,2 %**
 *    frente al **9,9 % · 7,0 %** anotado el 2026-07-30, con sólo 4 días de rodaje de ventana.
 *    La fila «TODOS los anclajes» SÍ replica (8,8→8,4 · 10,6→11,0), así que la discrepancia
 *    se concentra en el subconjunto con mediana completa. Desglose por mes sobre el archivo
 *    (ventana temporal): SOL **5,9 / 3,2 / 23,5 %** · BTC **7,7 / 3,2 / 0** · ETH
 *    **5,0 / 0 / 0** (jun/jul/ago). Es un evento extremo y su frecuencia depende del régimen,
 *    así que **citar la cifra sin su fecha es un error** — mismo aviso que ya lleva la
 *    frecuencia del veto (8,2 % → 6,6 % según ventana). Lo que NO se puede resolver desde
 *    aquí: los días anteriores al 2026-05-06 ya no los sirve la API ni están en el archivo.
 *    **Refuerza el "no tocar":** un corte cuya tasa oscila entre 0 y 23 % por mes no se
 *    reajusta con la ventana que uno tenga a mano.
 *
 * Uso:
 *   node scripts/auditLiquidationWindow.mjs
 *   DB=/ruta/snapshot.db node scripts/auditLiquidationWindow.mjs
 *   COINS=SOL node scripts/auditLiquidationWindow.mjs
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { DERIVATIVES_RUBRIC } from '../src/utils/derivativesScore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB ?? path.join(here, '../data/cryptex.db');
const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());

const H = 3600;
const WINDOW_H = 24;          // ventana de agregación, la de `fetchLiquidations`
const STEP_H = 4;             // un anclaje por vela del TF primario
const MEDIAN_DAYS = 30;       // ventana de la mediana, la de `fetchLiquidations`

const SKEW_CUT = DERIVATIVES_RUBRIC.cascade_skew_max;       // -0.5
const MAG_CUT = DERIVATIVES_RUBRIC.cascade_magnitude_mult;  // 2
const MIN_POINTS = DERIVATIVES_RUBRIC.cascade_min_points;   // 620

const q = (sorted, p) => sorted[Math.floor(p * (sorted.length - 1))];
const median = (a) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? q(s, 0.5) : null; };
const pctS = (n, t) => (t ? `${((n / t) * 100).toFixed(1).padStart(5)}%` : '   —  ');
const verdict = (p) => (p < 5 ? '← RAMA MUERTA' : p >= 45 && p <= 55 ? '← MONEDA AL AIRE' : '');

// ─── Carga ───────────────────────────────────────────────────────────────────

function loadHourly(db, coin) {
  const rows = db.prepare(
    'SELECT ts_key, payload FROM history_series WHERE metric = ? AND coin = ? ORDER BY ts_key',
  ).all('liquidations_1h', coin);
  return rows.map((r) => {
    const p = JSON.parse(r.payload);
    return { t: r.ts_key, l: p.longs_coins ?? 0, s: p.shorts_coins ?? 0 };
  }).filter((r) => Number.isFinite(r.t));
}

/** Rejilla horaria DENSA: las horas que la API omite entran como ceros. */
function densify(sparse) {
  const byT = new Map(sparse.map((r) => [r.t, r]));
  const out = [];
  for (let t = sparse[0].t; t <= sparse.at(-1).t; t += H) {
    const r = byT.get(t);
    out.push({ t, l: r?.l ?? 0, s: r?.s ?? 0, present: !!r });
  }
  return out;
}

// ─── Las dos ventanas ────────────────────────────────────────────────────────

/**
 * POSICIONAL — lo que hace producción: las 24 FILAS PRESENTES anteriores a `t`.
 * @returns {{l:number,s:number,total:number,spanH:number}|null}
 */
function windowPositional(sparse, idxEnd) {
  if (idxEnd < WINDOW_H) return null;
  const w = sparse.slice(idxEnd - WINDOW_H, idxEnd);
  const l = w.reduce((a, x) => a + x.l, 0);
  const s = w.reduce((a, x) => a + x.s, 0);
  return { l, s, total: l + s, spanH: (w.at(-1).t - w[0].t) / H + 1 };
}

/** TEMPORAL — `[t − 24 h, t)`, con las horas ausentes valiendo 0. */
function windowTemporal(dense, idxEnd) {
  if (idxEnd < WINDOW_H) return null;
  const w = dense.slice(idxEnd - WINDOW_H, idxEnd);
  const l = w.reduce((a, x) => a + x.l, 0);
  const s = w.reduce((a, x) => a + x.s, 0);
  return { l, s, total: l + s, spanH: WINDOW_H };
}

/**
 * Mediana de los totales de las ventanas rodantes de los últimos `MEDIAN_DAYS`, reproduciendo
 * el filtro de producción (`if (s > 0)`) y devolviendo también el nº de ventanas, que es el
 * `median_window_points` contra el que se compara `cascade_min_points`.
 */
function rollingMedian(arr, idxEnd, windowFn) {
  // ⚠️ EL CORTE EXTERIOR ES POR TIEMPO EN LAS DOS RAMAS, y no es un detalle. Producción pide
  // `from = now − 30 d` a la API, así que el CONJUNTO de puntos está acotado por tiempo; lo
  // único posicional es el `slice(i-24, i)` de dentro. La primera versión de este script
  // tomaba las últimas 720 FILAS, que en SOL abarcan ~737 h — o sea que simulaba una
  // producción más laxa que la real e inflaba `median_window_points` de ~680 a 721.
  const tEnd = arr[idxEnd].t;
  const tFrom = tEnd - MEDIAN_DAYS * 24 * H;
  let from = idxEnd;
  while (from > 0 && arr[from - 1].t >= tFrom) from--;
  const sums = [];
  for (let i = Math.max(from + WINDOW_H, WINDOW_H); i <= idxEnd; i++) {
    const w = windowFn(arr, i);
    if (w && w.total > 0) sums.push(w.total);
  }
  return { median: median(sums), points: sums.length };
}

// ─── Medición por moneda ─────────────────────────────────────────────────────

function auditCoin(db, coin) {
  const sparse = loadHourly(db, coin);
  if (sparse.length < MEDIAN_DAYS * 24 + WINDOW_H) {
    console.log(`\n${coin}: sólo ${sparse.length} filas horarias — hacen falta >${MEDIAN_DAYS * 24 + WINDOW_H}. Se omite.`);
    return null;
  }
  const dense = densify(sparse);
  const missing = dense.length - sparse.length;

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`${coin}  ·  ${sparse.length} filas presentes en ${dense.length} horas`
    + `  ·  ${missing} ausentes (${((missing / dense.length) * 100).toFixed(2)} %)`
    + `  ·  ${(dense.length / 24).toFixed(0)} d`);
  console.log('═'.repeat(90));

  // Índice de la rejilla densa por timestamp, para anclar las dos ramas al MISMO instante.
  const idxDense = new Map(dense.map((r, i) => [r.t, i]));
  const warmupH = MEDIAN_DAYS * 24 + WINDOW_H;   // mediana de 30 d COMPLETA, en HORAS

  const anchors = [];
  for (let i = 0; i < sparse.length; i++) {
    const t = sparse[i].t;
    if ((t / H) % STEP_H !== 0) continue;                  // anclaje en frontera de 4 h
    const j = idxDense.get(t);
    if (j < warmupH) continue;                             // exige 30 d + ventana de historia REAL

    const wp = windowPositional(sparse, i);
    const wt = windowTemporal(dense, j);
    if (!wp || !wt || wp.total <= 0 || wt.total <= 0) continue;

    const mp = rollingMedian(sparse, i, windowPositional);
    const mt = rollingMedian(dense, j, windowTemporal);
    if (!(mp.median > 0) || !(mt.median > 0)) continue;

    anchors.push({
      t,
      pos: { ...wp, skew: (wp.s - wp.l) / wp.total, mag: wp.total / mp.median, med: mp.median, points: mp.points },
      tmp: { ...wt, skew: (wt.s - wt.l) / wt.total, mag: wt.total / mt.median, med: mt.median, points: mt.points },
    });
  }
  if (!anchors.length) { console.log('  Sin anclajes con mediana de 30 d completa.'); return null; }
  const n = anchors.length;

  // ── M1.1 · ¿Cuánto se estira la ventana posicional? ────────────────────────
  const spans = anchors.map((a) => a.pos.spanH).sort((x, y) => x - y);
  const over = anchors.filter((a) => a.pos.spanH > WINDOW_H).length;
  console.log(`\n1 · ALCANCE REAL de la ventana posicional   n=${n} anclajes`);
  console.log(`   >24 h: ${pctS(over, n)}   ·  mediana ${q(spans, 0.5)} h  ·  p90 ${q(spans, 0.9)} h  ·  máx ${q(spans, 1)} h`);

  // ── M1.2 · Numerador, mediana y magnitud ───────────────────────────────────
  const rTot = anchors.map((a) => a.pos.total / a.tmp.total).sort((x, y) => x - y);
  const rMed = anchors.map((a) => a.pos.med / a.tmp.med).sort((x, y) => x - y);
  const rMag = anchors.map((a) => a.pos.mag / a.tmp.mag).sort((x, y) => x - y);
  const line = (name, r) => console.log(`   ${name.padEnd(26)} mediana ${q(r, 0.5).toFixed(4)}`
    + `  ·  p10 ${q(r, 0.1).toFixed(4)}  ·  p90 ${q(r, 0.9).toFixed(4)}  ·  máx ${q(r, 1).toFixed(3)}`);
  console.log(`\n2 · COCIENTE posicional ÷ temporal  (1,000 = la ventana no cambia nada)`);
  line('numerador (total 24 h)', rTot);
  line('mediana de 30 d', rMed);
  line('MAGNITUD (lo que decide)', rMag);

  // ── M1.3 · ¿Cambia el veredicto de la cascada? ─────────────────────────────
  const fires = (x) => x.skew <= SKEW_CUT && x.mag >= MAG_CUT;
  const fp = anchors.filter((a) => fires(a.pos)).length;
  const ft = anchors.filter((a) => fires(a.tmp)).length;
  const onlyPos = anchors.filter((a) => fires(a.pos) && !fires(a.tmp)).length;
  const onlyTmp = anchors.filter((a) => !fires(a.pos) && fires(a.tmp)).length;
  console.log(`\n3 · CASCADA (skew <= ${SKEW_CUT} Y magnitud >= ${MAG_CUT}×) — el veredicto`);
  console.log(`   posicional (producción hoy)  ${pctS(fp, n)}  (${fp})`);
  console.log(`   temporal   (corregida)       ${pctS(ft, n)}  (${ft})`);
  console.log(`   discrepan: sólo posicional ${onlyPos}  ·  sólo temporal ${onlyTmp}`
    + `  →  ${pctS(onlyPos + onlyTmp, n)} de los anclajes`);

  // ── M1.4 · El guard de puntos ──────────────────────────────────────────────
  const belowP = anchors.filter((a) => a.pos.points < MIN_POINTS).length;
  const belowT = anchors.filter((a) => a.tmp.points < MIN_POINTS).length;
  console.log(`\n4 · GUARD cascade_min_points = ${MIN_POINTS}  (por debajo, la cascada se ABSTIENE)`);
  console.log(`   posicional  ${pctS(belowP, n)} por debajo  ·  mediana de puntos ${median(anchors.map((a) => a.pos.points))}`);
  console.log(`   temporal    ${pctS(belowT, n)} por debajo  ·  mediana de puntos ${median(anchors.map((a) => a.tmp.points))}`);

  // ── M5 · Los cortes sobre la ventana corregida ─────────────────────────────
  console.log(`\n5 · M5 · LOS CORTES sobre la ventana TEMPORAL  (frente a la posicional)`);
  const skT = anchors.map((a) => a.tmp.skew).sort((x, y) => x - y);
  const skP = anchors.map((a) => a.pos.skew).sort((x, y) => x - y);
  const mgT = anchors.map((a) => a.tmp.mag).sort((x, y) => x - y);
  const mgP = anchors.map((a) => a.pos.mag).sort((x, y) => x - y);
  console.log(`   skew      p10 ${q(skT, 0.1).toFixed(2)} / mediana ${q(skT, 0.5).toFixed(2)} / p90 ${q(skT, 0.9).toFixed(2)}`
    + `      (posicional ${q(skP, 0.1).toFixed(2)} / ${q(skP, 0.5).toFixed(2)} / ${q(skP, 0.9).toFixed(2)})`);
  console.log(`   magnitud  p10 ${q(mgT, 0.1).toFixed(2)}× / mediana ${q(mgT, 0.5).toFixed(2)}× / p90 ${q(mgT, 0.9).toFixed(2)}×`
    + `   (posicional ${q(mgP, 0.1).toFixed(2)}× / ${q(mgP, 0.5).toFixed(2)}× / ${q(mgP, 0.9).toFixed(2)}×)`);
  console.log('');
  for (const sc of [0.3, 0.5, 0.7]) {
    const kT = anchors.filter((a) => a.tmp.skew <= -sc).length;
    const kP = anchors.filter((a) => a.pos.skew <= -sc).length;
    const p = (kT / n) * 100;
    console.log(`   skew <= -${sc.toFixed(1)}   temporal ${pctS(kT, n)}   posicional ${pctS(kP, n)}   ${verdict(p)}`);
  }
  console.log('');
  for (const mc of [1.5, 2, 3, 5]) {
    const kT = anchors.filter((a) => a.tmp.mag >= mc).length;
    const kP = anchors.filter((a) => a.pos.mag >= mc).length;
    const p = (kT / n) * 100;
    console.log(`   magnitud >= ${String(mc).padStart(3)}×  temporal ${pctS(kT, n)}   posicional ${pctS(kP, n)}   ${verdict(p)}`);
  }
  console.log(`\n   CONJUNCIÓN sobre la ventana temporal (% de anclajes que dispararían):`);
  console.log('              mag>=1.5×   mag>=2×    mag>=3×');
  for (const sc of [0.3, 0.5, 0.7]) {
    const row = [1.5, 2, 3].map((mc) => pctS(anchors.filter((a) => a.tmp.skew <= -sc && a.tmp.mag >= mc).length, n)).join('  ');
    console.log(`   skew<=-${sc}  ${row}`);
  }

  return {
    coin, n,
    overPct: (over / n) * 100,
    medRatio: q(rMed, 0.5),
    firePos: (fp / n) * 100,
    fireTmp: (ft / n) * 100,
    disagree: ((onlyPos + onlyTmp) / n) * 100,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

console.log('\nM1 + M5 · VENTANA RODANTE DE 24 h: ¿POSICIÓN O TIEMPO?');
console.log(`Fuente: ${DB_PATH} (solo lectura) · serie de archivo liquidations_1h`);

let db;
try { db = new Database(DB_PATH, { readonly: true, fileMustExist: true }); }
catch (e) { console.error(`No se puede abrir la BBDD: ${e.message}`); process.exit(1); }

const results = [];
for (const coin of COINS) {
  const r = auditCoin(db, coin);
  if (r) results.push(r);
}

if (results.length) {
  console.log(`\n${'═'.repeat(90)}\nRESUMEN\n${'═'.repeat(90)}`);
  console.log('  moneda   ventanas >24h   mediana pos÷tmp   cascada pos   cascada tmp   discrepan');
  for (const r of results) {
    console.log(`  ${r.coin.padEnd(8)} ${r.overPct.toFixed(1).padStart(11)}%`
      + ` ${r.medRatio.toFixed(4).padStart(17)}`
      + ` ${r.firePos.toFixed(1).padStart(13)}%`
      + ` ${r.fireTmp.toFixed(1).padStart(13)}%`
      + ` ${r.disagree.toFixed(1).padStart(11)}%`);
  }
  console.log('\n  P1 (inflación minoritaria y mayor en SOL) · P2 (la mediana SUBE con la posicional)');
  console.log('  · P3 (la temporal dispara la cascada al menos tan a menudo) — contrastar arriba.\n');
}
db.close();
