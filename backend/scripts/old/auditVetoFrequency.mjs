/**
 * auditVetoFrequency.mjs — ¿con qué frecuencia dispararía el veto, y discriminan los
 * umbrales de derivados?
 *
 * Dos preguntas que la fase de recogida tardaría semanas en responder y que se contestan
 * midiendo el código contra su propio histórico:
 *
 *  1. FRECUENCIA DEL VETO (revisión 2026-07-26). Al recalibrar `cvd_strength` por terciles,
 *     la pata CVD 1D del veto pasó de estar disponible el ~32 % del tiempo al ~67 %. El veto
 *     saltó en el primer payload tras desplegar. ¿Se aflojó demasiado? Aquí se reconstruye la
 *     conjunción COMPLETA (CVD 1D + OI + nivel fuerte cercano) sobre 90 días reales.
 *
 *  2. GRUPO 2 de la auditoría de umbrales: funding `severity` (0,05/0,2/0,5 %), LSR contrarian
 *     (60/40) y el peso implícito de ambos en `expected_scores.derivatives`. No se pudieron
 *     medir con klines porque necesitan histórico de derivados.
 *
 * Datos: Binance klines (gratis) + Coinalyze (necesita COINALYZE_API_KEY del .env). Coinalyze
 * sirve 90 días en 4h — suficiente para frecuencias, corto para colas.
 *
 * SOLO LECTURA: no toca la BBDD ni producción.
 *
 * Uso:  node scripts/auditVetoFrequency.mjs  [COIN=SOL]
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateCVD, calculateSupportResistance, calculateATR, detectMarketRegime } from '../src/utils/indicators.js';
import { computeVetos, computeGating } from '../src/utils/gating.js';
import { computeFirstPassage } from '../src/utils/pathMetrics.js';
import { classifyPathOutcome } from '../src/utils/stats.js';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';
import { SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT } from '../src/config/constants.js';

const COIN = process.env.COIN ?? 'SOL';
const PRIMARY_TF = '4h';
const N_4H = 180, N_1D = 90;   // ventanas de producción

const here = path.dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(path.join(here, '../../.env'), 'utf8');
const API_KEY = envRaw.match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();

const pct = (n, t) => t === 0 ? '  —  ' : `${(n / t * 100).toFixed(1).padStart(5)}%`;

async function klines(interval, limit = 1000) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${COIN}USDT&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`Binance ${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: Math.floor(x[0] / 1000), open: +x[1], high: +x[2], low: +x[3],
    close: +x[4], volume: +x[5], taker_buy_base: +x[9],
  }));
}

async function coinalyze(endpoint, interval, days = 90) {
  if (!API_KEY) return [];
  const to = Math.floor(Date.now() / 1000), from = to - days * 86400;
  const url = `https://api.coinalyze.net/v1/${endpoint}?symbols=${COIN}USDT_PERP.A`
    + `&interval=${interval}&from=${from}&to=${to}&api_key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.log(`  (${endpoint}: HTTP ${r.status})`); return []; }
  return (await r.json())?.[0]?.history ?? [];
}

// ── 1 · Frecuencia del veto ──────────────────────────────────────────────────

async function vetoFrequency() {
  console.log(`\n${'═'.repeat(76)}\n1 · FRECUENCIA DEL VETO — conjunción completa sobre 90 días (${COIN} ${PRIMARY_TF})\n`);

  const [k4h, k1d, oiHist] = await Promise.all([
    klines('4h'), klines('1d'), coinalyze('open-interest-history', '4hour'),
  ]);
  if (oiHist.length === 0) { console.log('  Sin datos de OI — no se puede reconstruir el veto.'); return; }

  // change_24h_pct del OI: 6 velas de 4h atrás. Es como lo calcula el servicio.
  const oiByT = new Map();
  for (let i = 6; i < oiHist.length; i++) {
    const prev = oiHist[i - 6].c, cur = oiHist[i].c;
    if (prev > 0) oiByT.set(oiHist[i].t, (cur - prev) / prev * 100);
  }

  const stats = {
    n: 0, veto: 0, vetoLong: 0, vetoShort: 0,
    cvdLeg: 0, oiLeg: 0, levelLeg: 0, dataInsufficient: 0,
  };
  // Se guardan los anclajes para que §3 mida el FUTURO de cada uno sin repetir el bucle: dos
  // reconstrucciones del mismo estado en el mismo fichero acabarían divergiendo.
  const anchors = [];
  // Rachas: un veto que dura 30 velas seguidas es UN episodio, no 30 señales.
  const episodes = []; let run = 0;

  for (let i = N_4H; i <= k4h.length; i++) {
    const w4 = k4h.slice(i - N_4H, i);
    const tNow = w4.at(-1).t;
    const oiChange = oiByT.get(tNow);
    if (oiChange == null) continue;

    // Ventana 1D alineada temporalmente con el final de la ventana 4h.
    const end1d = k1d.findIndex((c) => c.t > tNow);
    const idx1d = end1d === -1 ? k1d.length : end1d;
    if (idx1d < N_1D) continue;
    const w1d = k1d.slice(idx1d - N_1D, idx1d);

    const price = w4.at(-1).close;
    const atr = calculateATR(w4);
    const technical = {
      [PRIMARY_TF]: {
        support_resistance: calculateSupportResistance(w4, SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT),
        atr: { pct: atr && price ? atr / price * 100 : null },
      },
      '1D': { cvd: calculateCVD(w1d) },
    };

    const v = computeVetos({
      technical, openInterest: { change_24h_pct: oiChange }, currentPrice: price, primaryTf: PRIMARY_TF,
    });

    stats.n++;
    const active = v.veto_long || v.veto_short;
    if (active) { stats.veto++; run++; } else { if (run > 0) episodes.push(run); run = 0; }
    if (v.veto_long) stats.vetoLong++;
    if (v.veto_short) stats.vetoShort++;
    if (v.data_insufficient) stats.dataInsufficient++;

    // Patas por separado: identifica cuál es el cuello de botella real.
    const c = v.conditions ?? {};
    if (c.long?.cvd_1d_bearish || c.short?.cvd_1d_bullish) stats.cvdLeg++;
    if (c.long?.oi_not_expanding) stats.oiLeg++;
    if (c.long?.near_resistance_3plus_touches || c.short?.near_support_3plus_touches) stats.levelLeg++;

    anchors.push({
      t: tNow,
      price,
      atrPct: atr && price ? (atr / price) * 100 : null,
      vetoLong: !!v.veto_long,
      vetoShort: !!v.veto_short,
    });
  }
  if (run > 0) episodes.push(run);

  console.log(`  ventanas evaluadas: ${stats.n}  (una por vela de 4h con OI disponible)\n`);
  console.log(`  VETO ACTIVO            ${pct(stats.veto, stats.n)}   (long ${pct(stats.vetoLong, stats.n)} · short ${pct(stats.vetoShort, stats.n)})`);
  console.log(`  data_insufficient      ${pct(stats.dataInsufficient, stats.n)}`);
  console.log(`\n  Patas por separado (cuál es el cuello de botella):`);
  console.log(`    CVD 1D direccional   ${pct(stats.cvdLeg, stats.n)}`);
  console.log(`    OI sin expandir      ${pct(stats.oiLeg, stats.n)}`);
  console.log(`    nivel fuerte cercano ${pct(stats.levelLeg, stats.n)}`);

  if (episodes.length) {
    const total = episodes.reduce((a, b) => a + b, 0);
    const max = Math.max(...episodes);
    console.log(`\n  Episodios: ${episodes.length} rachas · media ${(total / episodes.length).toFixed(1)} velas `
      + `· máxima ${max} velas (${(max * 4 / 24).toFixed(1)} días)`);
    console.log(`  → con el disparador por TRANSICIÓN, el cron B dispararía ~${episodes.length} veces en 90 días`);
    console.log(`    (con el de persistencia habrían sido ~${stats.veto} chequeos con condición activa)`);
  }

  const p = stats.veto / stats.n * 100;
  console.log(`\n  VEREDICTO: ${
    p > 50 ? '⚠️  DEMASIADO LAXO — el veto sería el estado normal, no una excepción'
    : p > 25 ? '⚠️  frecuente; vigilar si domina la muestra'
    : p < 2 ? '⚠️  casi inalcanzable — el problema anterior sin resolver'
    : '✅ razonable: excepción, no norma'}`);

  return anchors;
}

// ── 4 · ¿Precede el veto a lo que prohíbe? (C3) ──────────────────────────────

/**
 * LA PREGUNTA. El veto es la única pieza de la ruta de decisión que PROHÍBE una dirección
 * entera, y nunca se comprobó que prohíba la dirección equivocada. C3 lo sospecha con un
 * argumento geométrico: *"precio pegado a un soporte probado"* —la pata de S/R del
 * `veto_short`— es también la geometría exacta de una ROTURA. Si eso es cierto, el veto
 * estaría cerrando la puerta justo cuando el corto funciona.
 *
 * CÓMO SE MIDE. Para cada anclaje se mira el FUTURO de 24h con las funciones REALES de
 * producción (`computeFirstPassage` + `classifyPathOutcome`), no con una reimplementación:
 * un corto "gana" si el precio recorre `targetK`×ATR a la baja antes que `adverseK`×ATR al
 * alza, que es la misma definición con la que se puntúa el sistema en vivo. Los parámetros
 * salen de `opportunityParamsFor(24)` — no se inventa ningún umbral aquí.
 *
 * CONTRA QUÉ SE COMPARA. Contra el COMPLEMENTO (los anclajes sin veto), nunca contra la base
 * global: la base contiene al subconjunto y sus intervalos comparten observaciones.
 *
 * ⚠️ `opts.now = null` DESACTIVA la censura por horizonte de `classifyPathOutcome`. Aquí es
 * correcto y obligatorio: se replica historia YA CERRADA con filas sin `timestamp`, y la
 * cobertura la garantiza el propio recorte de la ventana de klines de 1h.
 *
 * ⚠️ ATR: se usa el de DECISIÓN (180 velas de 4h), el mismo con el que el veto normaliza sus
 * umbrales en este bucle. No es el `atr_pct_at_analysis` de 19 velas del job de outcome —son
 * números distintos y mezclarlos es el error que B1 quiere hacer imposible.
 */
async function vetoPredictivity(anchors) {
  console.log(`\n${'═'.repeat(76)}\n4 · ¿PRECEDE EL VETO A LO QUE PROHÍBE? (C3) — ${COIN} ${PRIMARY_TF}, horizonte 24h\n`);
  if (!anchors?.length) { console.log('  Sin anclajes — §1 no pudo reconstruir el veto.'); return; }

  const k1h = await klines1hDeep();
  if (k1h.length < 500) { console.log('  Sin suficientes velas de 1h para medir el recorrido.'); return; }
  const lastT = k1h.at(-1).t;

  const HORIZON_H = 24;
  const HORIZON_SEC = HORIZON_H * 3600;
  const STRIDE = 6;                       // 24h / 4h = fases distintas de la rejilla

  const rows = [];
  for (const a of anchors) {
    if (!Number.isFinite(a.atrPct) || a.atrPct <= 0) continue;
    // Sin ventana completa no se clasifica: un 'flat' por falta de datos se leería como
    // "no pasó nada" y sesgaría a la baja las dos tasas por igual, pero sin decirlo.
    if (a.t + HORIZON_SEC > lastT) continue;
    const fp = computeFirstPassage(
      k1h.map((c) => ({ ...c, t: c.t * 1000 })), a.price, a.atrPct, a.t * 1000, HORIZON_SEC * 1000,
    );
    if (!fp) continue;
    const row = { path_first_passage: JSON.stringify(fp), timestamp: null };
    const shortOut = classifyPathOutcome('Vender', row, { horizonH: HORIZON_H, now: null });
    const longOut = classifyPathOutcome('Comprar', row, { horizonH: HORIZON_H, now: null });
    rows.push({ ...a, shortOut, longOut });
  }
  if (!rows.length) { console.log('  Ningún anclaje evaluable.'); return; }

  const line = (label, d) => console.log(`     ${label.padEnd(22)}`
    + (d ? `${d.point.toFixed(1).padStart(5)} % [${d.low.toFixed(1)}-${d.high.toFixed(1)}] n_ef=${String(d.n_eff).padStart(3)}`
      + (d.spread ? ` · arranques ${d.spread[0].toFixed(0)}-${d.spread[1].toFixed(0)}` : '')
      : 'n insuficiente'));

  for (const [name, flag, outKey, dirName] of [
    ['VETO SHORT (prohíbe VENDER)', 'vetoShort', 'shortOut', 'un CORTO'],
    ['VETO LONG (prohíbe COMPRAR)', 'vetoLong', 'longOut', 'un LARGO'],
  ]) {
    // Solo desenlaces resueltos: es el mismo `directional_n` del win-rate de producción.
    const resolved = rows.filter((r) => r[outKey] === 'win' || r[outKey] === 'loss');
    const withVeto = resolved.filter((r) => r[flag]);
    const without = resolved.filter((r) => !r[flag]);
    const hit = (r) => r[outKey] === 'win';

    console.log(`  ${name} — ¿habría ganado ${dirName} en las 24h siguientes?`);
    console.log(`     población resuelta: ${resolved.length} anclajes  (con veto ${withVeto.length} · sin veto ${without.length})`);
    if (withVeto.length < 2) { console.log('     el veto no dispara lo suficiente para medirlo.\n'); continue; }

    const a = disjointRate(withVeto, hit, { horizonSec: HORIZON_SEC, stride: STRIDE });
    const b = disjointRate(without, hit, { horizonSec: HORIZON_SEC, stride: STRIDE });
    line('con veto activo', a);
    line('complemento', b);
    const v = verdictCI(a, b);
    const rawA = withVeto.filter(hit).length / withVeto.length * 100;
    const rawB = without.filter(hit).length / without.length * 100;
    console.log(`     Δ puntual ${(rawA - rawB) >= 0 ? '+' : ''}${(rawA - rawB).toFixed(1)} pt `
      + `(solapados: ${rawA.toFixed(1)} % vs ${rawB.toFixed(1)} %)`);
    console.log(`     veredicto  ${
      v.separated === null ? 'n insuficiente'
      : !v.separated ? '— solapa: NO DEMOSTRADO (ni a favor ni en contra)'
      : v.side === 'above' ? '⚠️  SEPARA ARRIBA — el veto prohíbe la dirección que gana'
      : '✅ SEPARA ABAJO — el veto protege: prohíbe la dirección que pierde'}\n`);
  }

  console.log('  Lectura: "solapa" NO es "no hay efecto" — el no-solape de dos IC es más estricto');
  console.log('  que un contraste de proporciones. Y el Δ puntual va sobre anclajes SOLAPADOS,');
  console.log('  así que es el mejor estimador disponible, no una medida con incertidumbre honesta.');
}

/** 90 días de velas de 1h (2.160) — Binance sirve 1.000 por petición, así que se pagina. */
async function klines1hDeep(days = 90) {
  const need = Math.ceil(days * 24);
  const out = [];
  let endTime = Date.now();
  while (out.length < need) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${COIN}USDT&interval=1h&limit=1000&endTime=${endTime}`);
    if (!r.ok) break;
    const batch = (await r.json()).map((x) => ({
      t: Math.floor(x[0] / 1000), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
    }));
    if (!batch.length) break;
    out.unshift(...batch);
    endTime = batch[0].t * 1000 - 1;
    if (batch.length < 1000) break;
  }
  // Dedupe defensivo por si dos páginas se tocan en el borde.
  const seen = new Set();
  return out.filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true))).sort((a, b) => a.t - b.t);
}

// ── 2 · Grupo 2: umbrales de derivados ───────────────────────────────────────

async function derivativeThresholds() {
  console.log(`\n${'═'.repeat(76)}\n2 · UMBRALES DE DERIVADOS (grupo 2 de la auditoría) — 90 días\n`);

  const [fr, lsr] = await Promise.all([
    coinalyze('funding-rate-history', '4hour'),
    coinalyze('long-short-ratio-history', '4hour'),
  ]);

  if (fr.length) {
    // El servicio expone `value` en % por periodo; el histórico da candles OHLC del rate.
    const rates = fr.map((c) => c.c).filter(Number.isFinite);
    const b = { normal: 0, elevated: 0, high: 0, extreme: 0 };
    const bn = { normal: 0, elevated: 0, high: 0, extreme: 0 };
    for (const r of rates) {
      if (r >= 0) b[r > 0.5 ? 'extreme' : r > 0.2 ? 'high' : r > 0.05 ? 'elevated' : 'normal']++;
      else bn[r < -0.5 ? 'extreme' : r < -0.2 ? 'high' : r < -0.05 ? 'elevated' : 'normal']++;
    }
    const n = rates.length;
    const srt = [...rates].sort((a, x) => a - x);
    const q = (p) => srt[Math.floor((srt.length - 1) * p)];
    console.log(`  funding rate (${n} velas 4h) · mediana ${q(0.5).toFixed(4)} % · p5 ${q(0.05).toFixed(4)} · p95 ${q(0.95).toFixed(4)}`);
    console.log(`    severity  (positivo): normal ${pct(b.normal, n)} · elevated ${pct(b.elevated, n)} · high ${pct(b.high, n)} · extreme ${pct(b.extreme, n)}`);
    console.log(`    severity_negative:    normal ${pct(bn.normal, n)} · elevated ${pct(bn.elevated, n)} · high ${pct(bn.high, n)} · extreme ${pct(bn.extreme, n)}`);
    const vivos = [...Object.entries(b), ...Object.entries(bn)].filter(([, v]) => v > 0).length;
    console.log(`    → ${vivos} de 8 buckets con masa. Los vacíos son reglas del prompt que nunca se aplican.`);
  }

  if (lsr.length) {
    const longs = lsr.map((c) => c.l).filter(Number.isFinite);
    const n = longs.length;
    const bull = longs.filter((l) => l < 40).length;   // shorts_dominant_contrarian_bull
    const bear = longs.filter((l) => l > 60).length;   // longs_dominant_contrarian_bear
    const srt = [...longs].sort((a, x) => a - x);
    const q = (p) => srt[Math.floor((srt.length - 1) * p)];
    console.log(`\n  long % (${n} velas 4h) · mediana ${q(0.5).toFixed(1)} % · p10 ${q(0.10).toFixed(1)} · p90 ${q(0.90).toFixed(1)}`);
    console.log(`    contrarian_bear (>60): ${pct(bear, n)} · neutral: ${pct(n - bear - bull, n)} · contrarian_bull (<40): ${pct(bull, n)}`);
    console.log(`    → es el ÚNICO input de expected_scores.derivatives cuando el funding es normal.`);
    if (bear / n > 0.6 || bull / n > 0.6) {
      console.log(`    ⚠️  un lado domina >60 % del tiempo: el flag no discrimina, sesga.`);
    } else if (bear === 0 || bull === 0) {
      console.log(`    ⚠️  un lado NUNCA se activa: la regla correspondiente es código muerto.`);
    }
    console.log(`    percentiles que sí separarían por terciles: <${q(0.33).toFixed(1)} % / >${q(0.67).toFixed(1)} %`);
  }
}

// ── 3 · C2: ¿es alcanzable la puerta de CONVICTION DECAY? ────────────────────

async function decayGate() {
  console.log(`\n${'═'.repeat(76)}\n3 · CONVICTION DECAY — ¿es alcanzable el umbral de >=3 bloques? (${COIN})\n`);

  const [k1h, k4h, k1d, k1w, oiHist] = await Promise.all([
    klines('1h'), klines('4h'), klines('1d'), klines('1w'),
    coinalyze('open-interest-history', '4hour'),
  ]);
  if (!oiHist.length) { console.log('  Sin OI.'); return; }

  const oiByT = new Map();
  for (let i = 6; i < oiHist.length; i++) {
    const prev = oiHist[i - 6].c;
    if (prev > 0) oiByT.set(oiHist[i].t, (oiHist[i].c - prev) / prev * 100);
  }

  const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const codeFreq = {};
  const trendDist = {};
  const regimeDist = {};
  let n = 0;

  for (let i = N_4H; i <= k4h.length; i++) {
    const w4 = k4h.slice(i - N_4H, i);
    const tNow = w4.at(-1).t;
    const oiChange = oiByT.get(tNow);
    if (oiChange == null) continue;

    const sliceTo = (arr, size) => {
      const end = arr.findIndex((c) => c.t > tNow);
      const idx = end === -1 ? arr.length : end;
      return idx < size ? null : arr.slice(idx - size, idx);
    };
    const w1d = sliceTo(k1d, N_1D), w1w = sliceTo(k1w, 52), w1h = sliceTo(k1h, 168);
    if (!w1d || !w1w || !w1h) continue;

    const price = w4.at(-1).close;
    const atr = calculateATR(w4);
    const mk = (w) => ({ trend: trendOf(w), cvd: calculateCVD(w) });
    const technical = {
      '1h': mk(w1h),
      [PRIMARY_TF]: {
        ...mk(w4),
        support_resistance: calculateSupportResistance(w4, SR_LOOKBACK, SR_MIN_TOUCHES, SR_TOLERANCE_PCT),
        atr: { pct: atr && price ? atr / price * 100 : null },
        smc: null,
      },
      '1D': mk(w1d),
      '1W': mk(w1w),
    };

    const g = computeGating({
      technical, openInterest: { change_24h_pct: oiChange }, currentPrice: price, primaryTf: PRIMARY_TF,
    });
    n++;
    counts[Math.min(g.contradiction_count, 3)]++;
    for (const c of g.contradictions) codeFreq[c.code] = (codeFreq[c.code] ?? 0) + 1;

    const reg = detectMarketRegime(w4, w4.map((c) => c.close));
    regimeDist[reg] = (regimeDist[reg] ?? 0) + 1;
    trendDist[technical[PRIMARY_TF].trend] = (trendDist[technical[PRIMARY_TF].trend] ?? 0) + 1;
  }

  console.log(`  ventanas: ${n}\n  contradiction_count (bloques, tras ambos dedupes):`);
  for (const [k, v] of Object.entries(counts)) {
    console.log(`    ${k === '3' ? '>=3' : `  ${k}`} bloques  ${pct(v, n)}  ${k === '3' ? '← la puerta exige esto' : ''}`);
  }
  console.log(`\n  frecuencia de cada código:`);
  for (const [c, v] of Object.entries(codeFreq).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(26)} ${pct(v, n)}`);
  }
  const reach = counts[3] / n * 100;
  console.log(`\n  VEREDICTO C2: ${
    reach < 1 ? '⚠️  la puerta es INALCANZABLE en la práctica — o baja a >=2, o se acepta que no actúa'
    : reach < 5 ? 'la puerta actúa en casos extremos (raro pero posible); decisión consciente'
    : '✅ alcanzable con regularidad'}`);

  console.log(`\n  Efecto colateral del régimen por percentil (computeTrend excluye ADX en 'ranging'):`);
  for (const [k, v] of Object.entries(regimeDist).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(18)} ${pct(v, n)}`);
  }
  console.log(`  distribución de trend del TF primario:`);
  for (const [k, v] of Object.entries(trendDist).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(18)} ${pct(v, n)}`);
  }
  const degenerate = Object.values(trendDist).some((v) => v / n > 0.8);
  console.log(`  → ${degenerate ? '⚠️  una categoría domina >80 %: computeTrend perdió capacidad de discriminar'
    : '✅ el trend sigue repartido; el cambio de régimen no lo ha degenerado'}`);
}

// trend real requiere computeTrend con todos los indicadores; para esta auditoría basta la
// dirección estructural (EMA rápida vs lenta), que es lo que consume htf_conflict_1w_1d.
function trendOf(w) {
  const c = w.map((x) => x.close);
  const ema = (p) => { const k = 2 / (p + 1); let e = c.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < c.length; i++) e = c[i] * k + e * (1 - k); return e; };
  const f = ema(20), s = ema(50);
  const d = (f - s) / s * 100;
  return d > 1 ? 'bullish' : d < -1 ? 'bearish' : 'neutral';
}

const anchors = await vetoFrequency();
await derivativeThresholds();
await decayGate();
await vetoPredictivity(anchors);
console.log('');
