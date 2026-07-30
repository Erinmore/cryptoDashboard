/**
 * auditLiquidations.mjs — ¿sirven las liquidaciones para una rúbrica del Derivatives Score?
 *
 * CONTEXTO (2026-07-29). `auditDerivativesScore.mjs` demostró que las dos únicas reglas
 * numéricas del Derivatives Score disparan el 0,0 % del tiempo sobre 90 días × 3 monedas, y
 * que no existe ninguna que produzca score negativo. Como ese score gobierna AMBAS puertas
 * direccionales, el sistema no puede emitir `Comprar` ni `Vender`.
 *
 * De los cuatro inputs que el prompt dice evaluar, tres NO tienen regla de score: OI, LSR y
 * liquidaciones. El OI ya está medido (|cambio 24h| > 1 % el 64 %, > 3 % el 23 %, > 5 % el
 * 8,4 %, consistente en las tres monedas). Las liquidaciones son el ÚLTIMO input sin auditar
 * — el prompt pide "detectar liquidation cascade" sin dar un solo criterio operativo.
 *
 * QUÉ MIDE. Dos señales candidatas, y para cada una lo único que importa antes de escribir
 * un umbral: ¿discrimina, o es rama muerta / moneda al aire?
 *
 *   1. SKEW — quién está siendo liquidado.
 *        skew = (shorts_liq - longs_liq) / (shorts_liq + longs_liq)   ∈ [-1, +1]
 *      Positivo = shorts liquidados (squeeze al alza). Negativo = longs liquidados (cascada
 *      bajista). Es adimensional, así que compara entre monedas sin normalizar.
 *
 *   2. MAGNITUD — ¿es una cascada o es ruido de fondo? En USD no compara entre monedas
 *      (BTC >> SOL), así que se normaliza de dos formas:
 *        · ratio contra la MEDIANA DE 30 DÍAS DEL PROPIO ACTIVO — self-normalizing, sin
 *          introducir constante nueva. Es el mismo truco de `cvd_strength` y de
 *          `volume_vs_30d_median`, y evita el fallo T5 (umbral absoluto sobre una magnitud
 *          cuya escala cambia por activo y por régimen).
 *        · como % del Open Interest — económicamente interpretable: qué fracción del
 *          posicionamiento abierto se ha liquidado en 24h.
 *
 * ⚠️ UNIDADES (descubierto al escribir este script, 2026-07-29): `liquidation-history`
 * devuelve `l`/`s` en **MONEDAS BASE, no en USD** — el mismo error que se destapó con el
 * Open Interest el 2026-07-12. Evidencia: BTC suma 296 en 24h; si fueran dólares, Binance
 * habría liquidado 296 USD de BTC en un día entero. Son 296 BTC (~$19M). CLAUDE.md lo
 * documentaba como USD y las columnas `liq_*_24h_usd` de `analyses` llevan el sufijo
 * equivocado. VENTAJA COLATERAL para este script: liquidaciones y OI comparten unidad, así
 * que su cociente es adimensional y no hace falta el precio.
 *
 * Los anclajes son cada vela de 4h (el TF primario de producción) y la ventana es la suma de
 * 24h, que es exactamente como lo consume `coinalyzeService.fetchLiquidations`.
 *
 * CRITERIO DE LECTURA (el de la auditoría de umbrales T1-T6): un corte sirve si cae en una
 * banda que discrimina. Se marcan los dos fallos conocidos:
 *   · < 5 %  → RAMA MUERTA (como `severity_negative`, o el F&G > 85 al 1,0 %)
 *   · 45-55 % → MONEDA AL AIRE (como el ADX=25 en el percentil 50, o el OI cortando por 0)
 *
 * SOLO LECTURA: no toca BBDD, producción ni la ruta de decisión. Permitido durante la
 * congelación de §0 (mide, no decide). NO propone aplicar nada: el material va al checkpoint.
 *
 * Uso:  node scripts/auditLiquidations.mjs             # SOL, BTC y ETH
 *       COINS=SOL node scripts/auditLiquidations.mjs
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const DAYS = 90;
const WINDOW_H = 24;   // ventana de agregación, como fetchLiquidations
const STEP_H = 4;      // un anclaje por vela del TF primario

const here = path.dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(path.join(here, '../../.env'), 'utf8');
const API_KEY = envRaw.match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();

const pct = (n, t) => (t === 0 ? '   —  ' : `${((n / t) * 100).toFixed(1).padStart(5)}%`);
const bar = (p) => '█'.repeat(Math.round(p / 2.5));

/** Etiqueta el fallo conocido de un corte: rama muerta o moneda al aire. */
function verdict(p) {
  if (p < 5) return '← RAMA MUERTA';
  if (p >= 45 && p <= 55) return '← MONEDA AL AIRE';
  return '';
}

const quantile = (sorted, p) => sorted[Math.floor(p * (sorted.length - 1))];
const median = (arr) => {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? quantile(s, 0.5) : null;
};

async function coinalyze(coin, endpoint, interval) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 86400;
  const url = `https://api.coinalyze.net/v1/${endpoint}?symbols=${coin}USDT_PERP.A`
    + `&interval=${interval}&from=${from}&to=${to}&api_key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.log(`  (${endpoint}: HTTP ${r.status})`); return []; }
  return (await r.json())?.[0]?.history ?? [];
}


async function auditCoin(coin) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`${coin} — liquidaciones, ${DAYS} días (Coinalyze)`);
  console.log('═'.repeat(78));

  const [liqHist, oiHist] = await Promise.all([
    coinalyze(coin, 'liquidation-history', '1hour'),
    coinalyze(coin, 'open-interest-history', '4hour'),
  ]);
  if (liqHist.length < WINDOW_H * 2) {
    console.log(`  Histórico insuficiente (${liqHist.length} puntos horarios) — se omite.`);
    return null;
  }
  console.log(`  n=${liqHist.length} puntos horarios · ${(liqHist.length / 24).toFixed(0)} días reales\n`);

  // OI indexado por timestamp. Misma unidad que las liquidaciones (monedas base), así que
  // el cociente liq/OI es adimensional — no hace falta el precio.
  const oiByT = new Map(oiHist.map((h) => [h.t, h.c]));
  const nearest = (map, t) => {
    let best = null, bestD = Infinity;
    for (const [k, v] of map) { const d = Math.abs(k - t); if (d < bestD) { bestD = d; best = v; } }
    return bestD <= 6 * 3600 ? best : null;
  };

  // ── Anclajes cada 4h con ventana rodante de 24h ────────────────────────────
  const anchors = [];
  for (let i = WINDOW_H; i < liqHist.length; i += STEP_H) {
    const w = liqHist.slice(i - WINDOW_H, i);
    const longs = w.reduce((a, h) => a + (Number.isFinite(h.l) ? h.l : 0), 0);
    const shorts = w.reduce((a, h) => a + (Number.isFinite(h.s) ? h.s : 0), 0);
    const total = longs + shorts;
    if (total <= 0) continue;
    const t = liqHist[i - 1].t;
    anchors.push({
      t, longs, shorts, total,
      skew: (shorts - longs) / total,
      oiCoins: nearest(oiByT, t),
    });
  }
  if (!anchors.length) { console.log('  Sin anclajes utilizables.'); return null; }

  // Mediana rodante de 30 días del total (self-normalizing, sin constante nueva).
  // ⚠️ CALENTAMIENTO (corregido 2026-07-30): `Math.max(0, i - per30d)` deja los primeros 30
  // días con una mediana sobre menos puntos que la de producción, que siempre usa 30 días
  // completos (guard `cascade_min_points: 620`). Es el mismo defecto que hubo que corregir en
  // `auditDerivativesRubric`, donde diluía el lift de la cascada casi a la mitad
  // (+14,5 → +31,3). Aquí el anclaje se MARCA en vez de descartarse, para poder reportar la
  // cifra con y sin calentamiento y ver cuánto se movía.
  const per30d = Math.floor((30 * 24) / STEP_H);
  for (let i = 0; i < anchors.length; i++) {
    const from = Math.max(0, i - per30d);
    anchors[i].warm = i >= per30d;
    const med = median(anchors.slice(from, i + 1).map((a) => a.total));
    anchors[i].vsMedian = med > 0 ? anchors[i].total / med : null;
    anchors[i].pctOi = anchors[i].oiCoins > 0 ? (anchors[i].total / anchors[i].oiCoins) * 100 : null;
  }
  const n = anchors.length;

  // ── 1 · SKEW ───────────────────────────────────────────────────────────────
  const skews = anchors.map((a) => a.skew).sort((x, y) => x - y);
  console.log(`1 · SKEW  (shorts−longs)/(shorts+longs)   n=${n} anclajes\n`);
  console.log(`   min ${quantile(skews, 0).toFixed(2)} · p10 ${quantile(skews, 0.1).toFixed(2)}`
    + ` · mediana ${quantile(skews, 0.5).toFixed(2)} · p90 ${quantile(skews, 0.9).toFixed(2)}`
    + ` · max ${quantile(skews, 1).toFixed(2)}`);
  console.log('');
  for (const c of [0.3, 0.5, 0.7]) {
    const bull = anchors.filter((a) => a.skew >= c).length;   // shorts liquidados
    const bear = anchors.filter((a) => a.skew <= -c).length;  // longs liquidados
    console.log(`   skew >= +${c.toFixed(1)}  (squeeze alcista)  ${pct(bull, n)} ${bar((bull / n) * 100)} ${verdict((bull / n) * 100)}`);
    console.log(`   skew <= -${c.toFixed(1)}  (cascada bajista)  ${pct(bear, n)} ${bar((bear / n) * 100)} ${verdict((bear / n) * 100)}`);
  }

  // ── 2 · MAGNITUD ───────────────────────────────────────────────────────────
  const vsMed = anchors.map((a) => a.vsMedian).filter(Number.isFinite).sort((x, y) => x - y);
  console.log(`\n2 · MAGNITUD vs mediana 30d del propio activo   n=${vsMed.length}\n`);
  console.log(`   p10 ${quantile(vsMed, 0.1).toFixed(2)}× · mediana ${quantile(vsMed, 0.5).toFixed(2)}×`
    + ` · p90 ${quantile(vsMed, 0.9).toFixed(2)}× · max ${quantile(vsMed, 1).toFixed(1)}×`);
  console.log('');
  for (const c of [1.5, 2, 3, 5]) {
    const k = vsMed.filter((v) => v >= c).length;
    console.log(`   >= ${String(c).padStart(3)}× mediana   ${pct(k, vsMed.length)} ${bar((k / vsMed.length) * 100)} ${verdict((k / vsMed.length) * 100)}`);
  }

  const pctOi = anchors.map((a) => a.pctOi).filter(Number.isFinite).sort((x, y) => x - y);
  if (pctOi.length) {
    console.log(`\n   Como % del Open Interest (misma unidad, monedas base) (n=${pctOi.length}):`);
    console.log(`     p10 ${quantile(pctOi, 0.1).toFixed(3)}% · mediana ${quantile(pctOi, 0.5).toFixed(3)}%`
      + ` · p90 ${quantile(pctOi, 0.9).toFixed(3)}% · max ${quantile(pctOi, 1).toFixed(2)}%`);
  }

  // ── 3 · CONJUNCIÓN (lo que sería una regla de verdad) ──────────────────────
  // Una cascada útil no es "hubo liquidaciones": es magnitud ANORMAL con un lado claro.
  console.log(`\n3 · CONJUNCIÓN skew × magnitud — % de anclajes que dispararían la regla\n`);
  // Se reportan las DOS cifras: con todos los anclajes y solo con los que tienen la mediana
  // de 30 días COMPLETA — que es el régimen en el que opera producción. Si difieren mucho, la
  // cifra "todos" no describe lo que hará el sistema.
  const warm = anchors.filter((a) => a.warm);
  for (const [etiqueta, set] of [['TODOS los anclajes', anchors], [`mediana 30d COMPLETA (n=${warm.length})`, warm]]) {
    console.log(`   ── ${etiqueta} ──`);
    console.log('              mag>=1.5×   mag>=2×    mag>=3×');
    for (const sc of [0.3, 0.5, 0.7]) {
      const row = (sign) => [1.5, 2, 3].map((mc) => {
        const k = set.filter((a) => Number.isFinite(a.vsMedian) && a.vsMedian >= mc
          && (sign > 0 ? a.skew >= sc : a.skew <= -sc)).length;
        return pct(k, set.length);
      }).join('  ');
      console.log(`   skew>=+${sc}  ${row(1)}`);
      console.log(`   skew<=-${sc}  ${row(-1)}`);
    }
    console.log('');
  }

  return {
    coin, n,
    skewMed: quantile(skews, 0.5),
    bear05: (anchors.filter((a) => a.skew <= -0.5).length / n) * 100,
    bull05: (anchors.filter((a) => a.skew >= 0.5).length / n) * 100,
    mag2: (vsMed.filter((v) => v >= 2).length / vsMed.length) * 100,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error('Falta COINALYZE_API_KEY en el .env de la raíz.');
  process.exit(1);
}

console.log('\nAUDITORÍA DE LIQUIDACIONES — ¿material para una rúbrica del Derivatives Score?');
console.log('Es el último de los tres inputs que el prompt dice evaluar y no puntúa.');

const results = [];
for (const c of COINS) {
  const r = await auditCoin(c);
  if (r) results.push(r);
  await new Promise((res) => setTimeout(res, 1200));
}

console.log(`\n${'═'.repeat(78)}\nRESUMEN\n${'═'.repeat(78)}`);
console.log('  moneda   n     skew mediana   skew<=-0.5   skew>=+0.5   mag>=2×');
for (const r of results) {
  console.log(`  ${r.coin.padEnd(7)} ${String(r.n).padStart(4)}   ${r.skewMed.toFixed(2).padStart(11)}   `
    + `${r.bear05.toFixed(1).padStart(9)}%   ${r.bull05.toFixed(1).padStart(9)}%   ${r.mag2.toFixed(1).padStart(6)}%`);
}
console.log('\n  Un corte sirve si NO es rama muerta (<5 %) ni moneda al aire (45-55 %), y si');
console.log('  las tres monedas coinciden — igual que en la auditoría T1-T6. La consistencia');
console.log('  entre monedas indica propiedad del mercado cripto, no idiosincrasia de SOL.\n');
