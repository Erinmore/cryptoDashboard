/**
 * auditDerivativesScore.mjs — ¿es alcanzable el Derivatives Score?
 *
 * MOTIVACIÓN (2026-07-29, con n=6 en la muestra de producción). `score_derivatives` ha sido
 * **0 en las seis observaciones**. No es un score cualquiera: es la cima de la jerarquía
 * (Derivatives > Volume > Structure > Execution) y lo exigen LAS DOS puertas direccionales
 * —`Comprar` necesita >= +1 y `Vender` necesita <= -1—, así que mientras se quede en 0
 * ninguna puede abrirse por bien que estén estructura y volumen.
 *
 * Es el único score que nunca se auditó contra su propia distribución: §6.3 lo dejó en el
 * "grupo 2" porque necesita histórico de derivados (Coinalyze), no klines. Y las cuatro
 * constantes que SÍ se midieron salieron mal calibradas (F&G inerte el 87,8 %,
 * `cvd_strength=strong` al 0 %, `high_volatility` al 0 %, ADX en el percentil 50).
 *
 * QUÉ MIDE, y por qué así. El inventario de reglas NUMÉRICAS explícitas del Derivatives
 * Score en el system prompt (sección A) es exactamente:
 *
 *    severity_negative = "high_short_overload"     (fr < -0,2 %)  ->  +1
 *    severity_negative = "extreme_short_overload"  (fr < -0,5 %)  ->  +2
 *    FUNDING PERSISTENCE FILTER                                   ->  -1 nivel,
 *        pero solo aplica sobre un funding YA extremo, así que no puede
 *        llevar a negativo un score que parte de 0.
 *
 * Todo lo demás de esa sección es filtro de riesgo ("reducir tamaño de posición"),
 * modulador de convicción ("si el OI cae, reducir convicción") o advertencia de frescura
 * del dato: ninguno suma ni resta al score. El OI no tiene regla de score. El LSR NO SE
 * MENCIONA en el prompt (el `contrarian_bull/bear` existe en el backend y lo usa
 * `expectedDerivativesScore`, pero el modelo nunca lo ve como regla).
 *
 * De modo que las dos únicas vías explícitas son POSITIVAS y dependen del mismo dato. Este
 * script cuantifica cuánto están disponibles, y de paso mide los inputs que hoy no tienen
 * regla (OI, LSR, liquidaciones) para saber con qué se podría escribir una.
 *
 * SOLO LECTURA: no toca la BBDD, ni producción, ni la ruta de decisión. Permitido durante
 * la congelación de §0 (mide, no decide).
 *
 * Uso:  node scripts/auditDerivativesScore.mjs            # SOL, BTC y ETH
 *       COINS=SOL node scripts/auditDerivativesScore.mjs  # solo una
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { expectedDerivativesScore } from '../src/utils/expectedScores.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const DAYS = 90;

const here = path.dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(path.join(here, '../../.env'), 'utf8');
const API_KEY = envRaw.match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();

const pct = (n, t) => (t === 0 ? '   —  ' : `${((n / t) * 100).toFixed(1).padStart(5)}%`);
const bar = (p) => '█'.repeat(Math.round(p / 2.5)); // 40 chars = 100 %

async function coinalyze(coin, endpoint, interval) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 86400;
  const url = `https://api.coinalyze.net/v1/${endpoint}?symbols=${coin}USDT_PERP.A`
    + `&interval=${interval}&from=${from}&to=${to}&api_key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.log(`  (${endpoint}: HTTP ${r.status})`); return []; }
  return (await r.json())?.[0]?.history ?? [];
}

/**
 * Clasificadores COPIADOS de coinalyzeService.fetchFundingRate. Se replican a propósito en
 * vez de importar el servicio: ese hace I/O en vivo con cache, y aquí necesitamos aplicar el
 * mismo corte a un histórico. Si los umbrales cambian allí, este script queda desfasado —
 * por eso van juntos y con los números a la vista.
 */
const severityOf = (fr) => (fr >= 0
  ? (fr > 0.5 ? 'extreme' : fr > 0.2 ? 'high' : fr > 0.05 ? 'elevated' : 'normal')
  : 'normal');
const severityNegOf = (fr) => (fr < 0
  ? (fr < -0.5 ? 'extreme_short_overload' : fr < -0.2 ? 'high_short_overload'
    : fr < -0.05 ? 'elevated_short_overload' : null)
  : null);

/** Terciles de una serie (el criterio con el que se recalibró el LSR en §8 · V3). */
function terciles(values) {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 3) return null;
  return [s[Math.floor(s.length / 3)], s[Math.floor((2 * s.length) / 3)]];
}

async function auditCoin(coin) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`${coin} — ${DAYS} días de derivados reales (Coinalyze)`);
  console.log('═'.repeat(78));

  const [frHist, oiHist, lsrHist] = await Promise.all([
    coinalyze(coin, 'funding-rate-history', '4hour'),
    coinalyze(coin, 'open-interest-history', '4hour'),
    coinalyze(coin, 'long-short-ratio-history', '4hour'),
  ]);
  if (!frHist.length) { console.log('  Sin histórico de funding — se omite.'); return null; }

  // ── 1 · Las DOS reglas explícitas del prompt ───────────────────────────────
  const frVals = frHist.map((h) => h.c).filter(Number.isFinite);
  const buckets = { extreme: 0, high: 0, elevated: 0, normal: 0 };
  const bucketsNeg = { extreme_short_overload: 0, high_short_overload: 0, elevated_short_overload: 0 };
  for (const fr of frVals) {
    const sn = severityNegOf(fr);
    if (sn) bucketsNeg[sn]++;
    else buckets[severityOf(fr)]++;
  }
  const n = frVals.length;
  const rulePlus1 = bucketsNeg.high_short_overload + bucketsNeg.extreme_short_overload;
  const rulePlus2 = bucketsNeg.extreme_short_overload;

  console.log(`\n1 · REGLAS EXPLÍCITAS DEL PROMPT (n=${n} velas 4h)\n`);
  console.log(`   +2  severity_negative=extreme  (fr < -0.5 %)   ${pct(rulePlus2, n)}  ${bar((rulePlus2 / n) * 100)}`);
  console.log(`   +1  severity_negative=high     (fr < -0.2 %)   ${pct(rulePlus1, n)}  ${bar((rulePlus1 / n) * 100)}`);
  console.log(`   ──────────────────────────────────────────────────────────`);
  console.log(`   ALGUNA regla numérica disponible               ${pct(rulePlus1, n)}`);
  console.log(`   Score NEGATIVO por regla explícita             ${pct(0, n)}  (no existe ninguna)`);

  console.log(`\n   Distribución completa del funding rate (%):`);
  for (const [k, v] of [...Object.entries(bucketsNeg), ...Object.entries(buckets)]) {
    if (v === 0 && k !== 'normal') { console.log(`     ${k.padEnd(24)} ${pct(v, n)}   ← RAMA MUERTA`); continue; }
    console.log(`     ${k.padEnd(24)} ${pct(v, n)}`);
  }
  const sorted = [...frVals].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))].toFixed(4);
  console.log(`     min ${q(0)} · p10 ${q(0.1)} · mediana ${q(0.5)} · p90 ${q(0.9)} · max ${q(1)}`);

  // ── 2 · La guardia determinista del backend (expectedDerivativesScore) ─────
  // Solo mira funding + LSR signal. Se evalúa con el LSR reconstruido por terciles.
  const lsrLongs = lsrHist.map((h) => h.l).filter(Number.isFinite);
  const lsrCuts = terciles(lsrLongs);
  const dist = { '-2': 0, '-1': 0, 0: 0, 1: 0, 2: 0 };
  for (let i = 0; i < frHist.length; i++) {
    const fr = frHist[i].c;
    if (!Number.isFinite(fr)) continue;
    const longPct = lsrHist[i]?.l;
    let signal = '';
    if (lsrCuts && Number.isFinite(longPct)) {
      signal = longPct >= lsrCuts[1] ? 'contrarian_bear' : longPct <= lsrCuts[0] ? 'contrarian_bull' : 'balanced';
    }
    const { score } = expectedDerivativesScore({
      funding_rate: { severity: severityOf(fr), severity_negative: severityNegOf(fr) },
      long_short_ratio: { signal },
    });
    dist[String(score)]++;
  }
  const nd = Object.values(dist).reduce((a, b) => a + b, 0);
  console.log(`\n2 · GUARDIA DETERMINISTA DEL BACKEND (expectedDerivativesScore)\n`);
  for (const k of ['-2', '-1', '0', '1', '2']) {
    console.log(`     score ${k.padStart(2)}   ${pct(dist[k], nd)}  ${bar((dist[k] / nd) * 100)}`);
  }
  console.log(`     |score| >= 1: ${pct(dist['-2'] + dist['-1'] + dist['1'] + dist['2'], nd)}`);

  // ── 3 · Inputs SIN regla de score (material para escribir una) ─────────────
  console.log(`\n3 · INPUTS QUE HOY NO PUNTÚAN (¿con qué se podría escribir una regla?)\n`);

  const oiChanges = [];
  for (let i = 6; i < oiHist.length; i++) {
    const prev = oiHist[i - 6].c, cur = oiHist[i].c;
    if (prev > 0) oiChanges.push(((cur - prev) / prev) * 100);
  }
  if (oiChanges.length) {
    const s = [...oiChanges].sort((a, b) => a - b);
    const qq = (p) => s[Math.floor(p * (s.length - 1))].toFixed(2);
    const over = (t) => oiChanges.filter((x) => Math.abs(x) > t).length;
    console.log(`   OI cambio 24h (n=${oiChanges.length}):  p10 ${qq(0.1)} · mediana ${qq(0.5)} · p90 ${qq(0.9)}`);
    console.log(`     |cambio| > 1 %  ${pct(over(1), oiChanges.length)}   `
      + `> 3 %  ${pct(over(3), oiChanges.length)}   > 5 %  ${pct(over(5), oiChanges.length)}`);
  }
  if (lsrCuts) {
    const s = [...lsrLongs].sort((a, b) => a - b);
    const qq = (p) => s[Math.floor(p * (s.length - 1))].toFixed(1);
    console.log(`   LSR long% (n=${lsrLongs.length}):  min ${qq(0)} · mediana ${qq(0.5)} · max ${qq(1)}`);
    console.log(`     terciles reales [${lsrCuts[0].toFixed(1)}, ${lsrCuts[1].toFixed(1)}]  ·  `
      + `corte fijo 60/40 → contrarian_bear ${pct(lsrLongs.filter((x) => x >= 60).length, lsrLongs.length)}`);
  }

  return { coin, n, rulePlus1: (rulePlus1 / n) * 100, guardActive: ((nd - dist['0']) / nd) * 100 };
}

// ── main ─────────────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error('Falta COINALYZE_API_KEY en el .env de la raíz.');
  process.exit(1);
}

console.log('\nAUDITORÍA DEL DERIVATIVES SCORE — ¿puede salir de 0?');
console.log('Motivo: es la cima de la jerarquía y lo exigen AMBAS puertas direccionales,');
console.log('y en la muestra de producción lleva 6/6 clavado en 0.');

const results = [];
for (const c of COINS) {
  const r = await auditCoin(c);
  if (r) results.push(r);
  await new Promise((res) => setTimeout(res, 1200)); // cortesía con el rate limit
}

console.log(`\n${'═'.repeat(78)}\nRESUMEN\n${'═'.repeat(78)}`);
console.log('  moneda   n     regla +1/+2 disponible   guardia backend != 0');
for (const r of results) {
  console.log(`  ${r.coin.padEnd(7)} ${String(r.n).padStart(4)}   `
    + `${r.rulePlus1.toFixed(1).padStart(18)}%   ${r.guardActive.toFixed(1).padStart(17)}%`);
}
console.log('\n  Lectura: la columna 1 es el % del tiempo en que el prompt tiene ALGUNA regla');
console.log('  numérica que mover el Derivatives Score. No existe regla explícita que lo');
console.log('  lleve a negativo, que es justo lo que `Vender` exige (<= -1).\n');
