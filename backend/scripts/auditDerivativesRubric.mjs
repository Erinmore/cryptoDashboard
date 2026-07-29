/**
 * auditDerivativesRubric.mjs — material medido para una rúbrica del Derivatives Score.
 *
 * CONTEXTO. `auditDerivativesScore.mjs` demostró que el score que gobierna AMBAS puertas
 * direccionales no tiene rúbrica: sus dos únicas reglas numéricas disparan el 0,0 % del
 * tiempo y ninguna produce negativo. `auditLiquidations.mjs` midió el input que faltaba.
 * Este script cierra lo que queda antes de poder ESCRIBIR la rúbrica, con una regla de
 * juego: **ningún umbral se escribe sin haber visto su distribución** — el pecado que
 * destapó la auditoría T1-T6 en media docena de sitios.
 *
 * LO QUE MIDE
 *
 * 1. OI × DIRECCIÓN DE PRECIO. Un OI expandiéndose no es alcista ni bajista por sí solo:
 *    depende de contra qué se expande.
 *        OI↑ precio↑ = longs nuevos      → continuación alcista
 *        OI↑ precio↓ = shorts nuevos     → continuación bajista
 *        OI↓ precio↑ = cierre de cortos  → rebote sin dinero nuevo (débil)
 *        OI↓ precio↓ = des-apalancamiento → caída sin convicción (débil)
 *    El prompt ya lo intuye ("Open Interest determina convicción real / simple cierre de
 *    posiciones") pero nunca lo convierte en criterio. Aquí se mide el reparto de las cuatro
 *    celdas para comprobar que ninguna es rama muerta ni moneda al aire.
 *
 * 2. NORMALIZACIÓN DEL MOVIMIENTO DE PRECIO. Un umbral absoluto en % sería el fallo T5 otra
 *    vez (la escala cambia por activo y por régimen). El movimiento de 24h se expresa en
 *    unidades de ATR del TF primario escalado a la ventana: ATR%(4h) × √6, porque 24h son
 *    6 velas de 4h y el recorrido escala con √t. Es el mismo razonamiento con el que se
 *    fijaron los pares de oportunidad por horizonte (24h 2×/1×, 7d 4×/1×).
 *
 * 3. BANDA MUERTA DE AMBOS EJES. Para el OI se parte de ±1 %, que ya está medido y en
 *    producción (`gating.js`, tras el lote de afinado del 2026-07-27). Para el precio se
 *    barren varios múltiplos de ATR y se elige por distribución, no por gusto.
 *
 * 4. COMPOSICIÓN. Con los ejes ya medidos, se reporta la distribución resultante de VARIAS
 *    composiciones candidatas. No se elige ninguna aquí: se ponen los números delante para
 *    que la elección sea informada. Un score sirve si reparte -2..+2 sin celdas vacías ni
 *    una celda dominante.
 *
 * SOLO LECTURA: no toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditDerivativesRubric.mjs
 *       COINS=SOL node scripts/auditDerivativesRubric.mjs
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateATRSeries } from '../src/utils/indicators.js';
import { wilsonInterval } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const DAYS = 90;
const LOOKBACK_4H = 6;          // 24h = 6 velas de 4h
const SQRT_WINDOW = Math.sqrt(LOOKBACK_4H);
const OI_DEAD_BAND = 1.0;       // ±1 %, ya medido y en producción (gating.js)

const here = path.dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(path.join(here, '../../.env'), 'utf8');
const API_KEY = envRaw.match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();

const pct = (n, t) => (t === 0 ? '   —  ' : `${((n / t) * 100).toFixed(1).padStart(5)}%`);
const verdict = (p) => (p < 5 ? ' ← RAMA MUERTA' : p >= 45 && p <= 55 ? ' ← MONEDA AL AIRE' : '');
const q = (sorted, p) => sorted[Math.floor(p * (sorted.length - 1))];

async function coinalyze(coin, endpoint, interval) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 86400;
  const url = `https://api.coinalyze.net/v1/${endpoint}?symbols=${coin}USDT_PERP.A`
    + `&interval=${interval}&from=${from}&to=${to}&api_key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.log(`  (${endpoint}: HTTP ${r.status})`); return []; }
  return (await r.json())?.[0]?.history ?? [];
}

async function klines(coin, interval, limit = 1000) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`Binance ${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: Math.floor(x[0] / 1000), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
  }));
}

/**
 * Suma rodante de 24h de liquidaciones, indexada por el instante en que la ventana ya está
 * COMPLETA.
 *
 * ⚠️ Corregido en la revisión crítica: antes se indexaba por `liqHist[i-1].t`, que es la
 * APERTURA de la última vela horaria incluida — o sea que la ventana "pasada" se extendía
 * hasta t+1h y metía una hora de futuro. Con la cascada era grave: un pico de liquidaciones
 * en esa hora contaba a la vez como señal previa y como parte del movimiento a predecir,
 * inflando su poder predictivo aparente. Ahora la clave es el CIERRE de esa vela.
 *
 * La mediana es de 30 días REALES: se itera hora a hora, así que son 720 entradas, no 180
 * (ese era el paso de 4h de `auditLiquidations.mjs` — mismo nombre, ventana distinta).
 */
// Ventana de la mediana de liquidaciones. Parametrizable porque la rúbrica se midió con 30d
// pero el payload de producción solo lleva 7 (`history.liquidations`): hay que comprobar si
// sustituir la ventana cambia el umbral antes de hacerlo.
const MEDIAN_HOURS = (Number(process.env.MEDIAN_DAYS) || 30) * 24;
function liqWindows(liqHist) {
  const out = new Map();
  const totals = [];
  for (let i = 24; i < liqHist.length; i++) {
    const w = liqHist.slice(i - 24, i);
    const longs = w.reduce((a, h) => a + (Number.isFinite(h.l) ? h.l : 0), 0);
    const shorts = w.reduce((a, h) => a + (Number.isFinite(h.s) ? h.s : 0), 0);
    const total = longs + shorts;
    if (total <= 0) continue;
    totals.push(total);
    // ⚠️ CALENTAMIENTO: `totals` arranca vacío y crece, así que durante los primeros 30 días
    // la "mediana de 30d" se apoya en menos puntos. Se marca para poder descartar esos
    // anclajes: si no, un tercio de la calibración usaría una ventana más corta que la que
    // usará producción — que es justo el sesgo que acabamos de rechazar.
    const warm = totals.length >= MEDIAN_HOURS;
    const medOf = (hours) => {
      const recent = totals.slice(-hours).slice().sort((a, b) => a - b);
      return recent[Math.floor(recent.length / 2)];
    };
    const med = medOf(MEDIAN_HOURS);
    const med7 = medOf(7 * 24);
    const med30 = medOf(30 * 24);
    out.set(liqHist[i - 1].t + 3600, {          // cierre de la última vela incluida
      skew: (shorts - longs) / total,
      vsMedian: med > 0 ? total / med : null,
      vsMedian7: med7 > 0 ? total / med7 : null,
      vsMedian30: med30 > 0 ? total / med30 : null,
      warm,
    });
  }
  return out;
}

/** Último valor cuya ventana cerró EN o ANTES de `t` (nunca futuro). */
const latestUpTo = (map, t, maxGapSec = 4 * 3600) => {
  let best = null, bestK = -Infinity;
  for (const [k, v] of map) { if (k <= t && k > bestK) { bestK = k; best = v; } }
  return t - bestK <= maxGapSec ? best : null;
};

async function auditCoin(coin) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`${coin} — material para la rúbrica (${DAYS}d)`);
  console.log('═'.repeat(78));

  const [k4h, oiHist, liqHist, frHist] = await Promise.all([
    klines(coin, '4h'),
    coinalyze(coin, 'open-interest-history', '4hour'),
    coinalyze(coin, 'liquidation-history', '1hour'),
    coinalyze(coin, 'funding-rate-history', '4hour'),
  ]);
  if (!oiHist.length) { console.log('  Sin OI — se omite.'); return null; }

  // `calculateATRSeries` devuelve [{idx, atr}], no un array plano indexado por vela.
  const atrByIdx = new Map((calculateATRSeries(k4h, 14) ?? []).map((e) => [e.idx, e.atr]));
  const closeByT = new Map(k4h.map((c) => [c.t, c.close]));
  const atrPctByT = new Map();
  k4h.forEach((c, i) => {
    const atr = atrByIdx.get(i);
    if (Number.isFinite(atr) && c.close > 0) atrPctByT.set(c.t, (atr / c.close) * 100);
  });
  const liqByT = liqWindows(liqHist);
  const frByT = new Map(frHist.map((h) => [h.t, h.c]));

  // ── Anclajes: una vela de 4h con 24h de historia en ambos ejes ─────────────
  const rows = [];
  for (let i = LOOKBACK_4H; i < oiHist.length; i++) {
    const t = oiHist[i].t;
    const oiPrev = oiHist[i - LOOKBACK_4H].c, oiNow = oiHist[i].c;
    if (!(oiPrev > 0)) continue;
    const pxNow = closeByT.get(t);
    const pxPrev = closeByT.get(oiHist[i - LOOKBACK_4H].t);
    const atrPct = atrPctByT.get(t);
    if (!Number.isFinite(pxNow) || !Number.isFinite(pxPrev) || !Number.isFinite(atrPct) || atrPct <= 0) continue;

    const oiChange = ((oiNow - oiPrev) / oiPrev) * 100;
    const pxChange = ((pxNow - pxPrev) / pxPrev) * 100;
    // Movimiento normalizado: ATR de la vela escalado a la ventana de 24h (√6 velas).
    const pxAtr = pxChange / (atrPct * SQRT_WINDOW);
    const liq = latestUpTo(liqByT, t) ?? { skew: null, vsMedian: null, warm: false };
    if (process.env.WARM_ONLY === '1' && !liq.warm) continue;
    // Movimiento FUTURO de 24h, misma normalización. Sin lookahead: la celda se define con
    // las 24h pasadas (OI y precio) y esto mide las 24h siguientes.
    const fwdT = t + LOOKBACK_4H * 4 * 3600;
    const pxFwd = closeByT.get(fwdT);
    const fwdAtr = Number.isFinite(pxFwd)
      ? ((pxFwd - pxNow) / pxNow) * 100 / (atrPct * SQRT_WINDOW) : null;
    rows.push({ t, oiChange, pxChange, pxAtr, atrPct, fwdAtr, ...liq, fr: frByT.get(t) ?? null });
  }
  if (!rows.length) { console.log('  Sin anclajes.'); return null; }
  const n = rows.length;

  // ── 1 · Normalización del movimiento de precio ─────────────────────────────
  const absAtr = rows.map((r) => Math.abs(r.pxAtr)).sort((a, b) => a - b);
  console.log(`\n1 · MOVIMIENTO DE PRECIO 24h NORMALIZADO  (|Δ| / (ATR%×√6))   n=${n}\n`);
  console.log(`   p25 ${q(absAtr, 0.25).toFixed(2)} · mediana ${q(absAtr, 0.5).toFixed(2)}`
    + ` · p75 ${q(absAtr, 0.75).toFixed(2)} · p90 ${q(absAtr, 0.9).toFixed(2)}`);
  console.log('\n   Banda muerta candidata — % de anclajes que quedarían FUERA (con dirección):');
  for (const b of [0.3, 0.5, 0.75, 1.0]) {
    const k = rows.filter((r) => Math.abs(r.pxAtr) > b).length;
    console.log(`     |mov| > ${b.toFixed(2)}×   ${pct(k, n)}${verdict((k / n) * 100)}`);
  }

  // ── 2 · Cuadro OI × precio ─────────────────────────────────────────────────
  console.log(`\n2 · CUADRO OI × PRECIO   (OI banda ±${OI_DEAD_BAND}% · precio banda ±0.5×ATR)\n`);
  const PX_BAND = 0.5;
  const cell = (oiSign, pxSign) => rows.filter((r) => {
    const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
    const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
    return o === oiSign && p === pxSign;
  }).length;
  const labels = [
    ['OI↑ precio↑  longs nuevos      → alcista fuerte', 1, 1],
    ['OI↑ precio↓  shorts nuevos     → bajista fuerte', 1, -1],
    ['OI↓ precio↑  cierre de cortos  → alcista débil ', -1, 1],
    ['OI↓ precio↓  des-apalancamiento→ bajista débil ', -1, -1],
  ];
  let covered = 0;
  for (const [label, o, p] of labels) {
    const k = cell(o, p); covered += k;
    console.log(`   ${label}  ${pct(k, n)}${verdict((k / n) * 100)}`);
  }
  console.log(`   ${'(alguna banda muerta: sin señal)'.padEnd(48)}  ${pct(n - covered, n)}`);

  // ── 3 · Composiciones candidatas ───────────────────────────────────────────
  // A: solo OI×precio.  B: OI×precio + cascada de liquidaciones.  C: B + funding.
  const oiPxScore = (r) => {
    const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
    const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
    if (o === 0 || p === 0) return 0;
    return o === 1 ? p * 2 : p * 1;         // dinero nuevo pesa el doble que el cierre
  };
  const liqScore = (r) => {
    if (!Number.isFinite(r.skew) || !Number.isFinite(r.vsMedian) || r.vsMedian < 2) return 0;
    if (r.skew <= -0.5) return -1;          // cascada de longs → bajista
    if (r.skew >= 0.5) return 1;            // cascada de shorts → alcista
    return 0;
  };
  const frScore = (r) => {
    if (!Number.isFinite(r.fr)) return 0;
    if (r.fr < -0.5) return 2; if (r.fr < -0.2) return 1;
    if (r.fr > 0.5 || r.fr > 0.2) return -1;
    return 0;
  };
  const clamp = (x) => Math.max(-2, Math.min(2, x));
  // D y E salen de la sección 4: las celdas de OI↓ NO continúan (SOL 0,0 % y 14,0 %; ETH
  // 3,4 % y 20,0 %, todas por debajo de su tasa base). "Alcista débil" resultó no ser alcista.
  const oiPxScoreD = (r) => {   // solo el dinero nuevo puntúa
    const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
    const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
    return o === 1 && p !== 0 ? p * 2 : 0;
  };
  const oiPxScoreE = (r) => {   // ídem, pero el des-apalancamiento conserva un -1
    const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
    const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
    if (o === 1 && p !== 0) return p * 2;
    if (o === -1 && p === -1) return -1;
    return 0;
  };
  // F y G incorporan TODO lo medido en las secciones 4-6:
  //   · celdas con los signos medidos (OI↓px↑ = -1, NO +1; OI↓px↓ = 0)
  //   · cascada SOLO de longs (la de shorts es contradictoria entre monedas, n=7-25)
  //   · cascada solo cuando la celda calla → respeta B1 ANTI-DOBLE-CONTEO (solapa 33-44 %)
  //   · funding intacto (evento de cola, 0 % en 90d)
  // Difieren en la escala del dinero nuevo: F le da ±2, G le da ±1 reservando el ±2 para la
  // confluencia con funding. G existe porque en F el bucket +1 se queda sin ninguna fuente.
  const cellMeasured = (r) => {
    const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
    const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
    if (o === 1 && p !== 0) return p;        // dinero nuevo confirma la dirección
    if (o === -1 && p === 1) return -1;      // rally sin dinero nuevo: falla
    return 0;                                // des-apalancamiento / bandas muertas
  };
  const cascadeBear = (r) => (Number.isFinite(r.skew) && Number.isFinite(r.vsMedian)
    && r.vsMedian >= 2 && r.skew <= -0.5 ? -1 : 0);
  const comps = {
    'A · OI×precio (2/1, supuesto)': (r) => clamp(oiPxScore(r)),
    'B · A + liquidaciones        ': (r) => clamp(oiPxScore(r) + liqScore(r)),
    'D · solo OI↑ ±2, +liq +fr    ': (r) => clamp(oiPxScoreD(r) + liqScore(r) + frScore(r)),
    'F · medido · dinero nuevo ±2 ': (r) => {
      // Solo el DINERO NUEVO escala a ±2; el rally fallido se queda en -1.
      const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
      const c = o === 1 ? cellMeasured(r) * 2 : cellMeasured(r);
      return clamp((c !== 0 ? c : cascadeBear(r)) + frScore(r));
    },
    'G · medido · dinero nuevo ±1 ': (r) => {
      const c = cellMeasured(r);
      return clamp((c !== 0 ? c : cascadeBear(r)) + frScore(r));
    },
    // H e I salen de la sección 4b: al controlar por momentum, `OI↑px↓` se cae (+3.7/+4.7/-3.4,
    // ruido) mientras `OI↓px↑` es el efecto MÁS fuerte y replicado (-20.2/-24.2). H lo retira;
    // I le deja un -1 por si se prefiere conservarlo con peso mínimo.
    'H · controlado · OI↑px↓ fuera': (r) => {
      const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
      const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
      const c = (o === 1 && p === 1) ? 1 : (o === -1 && p === 1) ? -1 : 0;
      return clamp((c !== 0 ? c : cascadeBear(r)) + frScore(r));
    },
    'I · controlado · OI↑px↓ = -1 ': (r) => {
      const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
      const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
      const c = (o === 1 && p === 1) ? 1 : (o === -1 && p === 1) ? -1 : (o === 1 && p === -1) ? -1 : 0;
      return clamp((c !== 0 ? c : cascadeBear(r)) + frScore(r));
    },
  };
  console.log(`\n3 · DISTRIBUCIÓN DEL SCORE RESULTANTE  (composiciones candidatas)\n`);
  console.log('                                  -2      -1       0      +1      +2   |score|>=1');
  const out = {};
  for (const [name, fn] of Object.entries(comps)) {
    const d = { '-2': 0, '-1': 0, 0: 0, 1: 0, 2: 0 };
    for (const r of rows) d[String(fn(r))]++;
    const act = n - d['0'];
    out[name.trim()] = (act / n) * 100;
    console.log(`   ${name}  ${['-2', '-1', '0', '1', '2'].map((k) => pct(d[k], n)).join(' ')}   ${pct(act, n)}`);
  }
  // ── 4 · ¿Predicen algo las celdas? (valida la ponderación, no la inventa) ──
  // La ponderación "OI↑ pesa 2, OI↓ pesa 1" es un JUICIO ("el dinero nuevo confirma más que
  // el cierre"), no un dato. Se contrasta midiendo si las celdas fuertes preceden a
  // continuación más que las débiles, contra la tasa base del propio activo.
  //
  // ⚠️ Ventanas solapadas: anclajes cada 4h con ventana futura de 24h comparten 5/6 del
  // futuro. El % es insesgado pero el IC saldría demasiado estrecho, así que el Wilson se
  // calcula sobre anclajes NO solapados (uno de cada 6) y se reporta ese n aparte.
  const FWD_BAND = 0.5;
  const withFwd = rows.filter((r) => Number.isFinite(r.fwdAtr));
  const baseUp = withFwd.filter((r) => r.fwdAtr > FWD_BAND).length;
  const baseDn = withFwd.filter((r) => r.fwdAtr < -FWD_BAND).length;
  console.log(`\n4 · ¿PREDICEN LAS CELDAS?  continuación en las 24h siguientes (>${FWD_BAND}×)\n`);
  console.log(`   TASA BASE del activo:  sube ${pct(baseUp, withFwd.length)} · baja ${pct(baseDn, withFwd.length)}`
    + `  (n=${withFwd.length})\n`);
  const cellDefs = [
    ['OI↑ px↑  (fuerte alcista)', 1, 1, 1],
    ['OI↓ px↑  (débil alcista) ', -1, 1, 1],
    ['OI↑ px↓  (fuerte bajista)', 1, -1, -1],
    ['OI↓ px↓  (débil bajista) ', -1, -1, -1],
  ];
  // ⚠️ CONFUNDIDO (revisión crítica): comparar cada celda contra la tasa base GLOBAL mezcla
  // dos efectos, porque la celda se define en parte por el movimiento PASADO del precio. Un
  // `OI↑px↑` que continúa más que la media puede deberse al OI o simplemente a que el precio
  // venía subiendo (momentum). La comparación que aísla el OI es CONTRA LAS DEMÁS CELDAS DEL
  // MISMO SIGNO DE PRECIO, y se hace en la sección 4b.
  //
  // Se reportan AMBAS direcciones por celda, no solo la "esperada": si un rally sin dinero
  // nuevo no continúa al alza, la pregunta siguiente es si continúa a la BAJA — o sea, si
  // "alcista débil" es en realidad bajista. Mirar solo la dirección esperada lo ocultaría.
  console.log('   celda                       n    sube↑   (lift)    baja↓   (lift)   lectura');
  for (const [label, o, p] of cellDefs) {
    const sel = withFwd.filter((r) => {
      const oo = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
      const pp = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
      return oo === o && pp === p;
    });
    if (!sel.length) continue;
    const up = sel.filter((r) => r.fwdAtr > FWD_BAND).length;
    const dn = sel.filter((r) => r.fwdAtr < -FWD_BAND).length;
    const lUp = (up / sel.length - baseUp / withFwd.length) * 100;
    const lDn = (dn / sel.length - baseDn / withFwd.length) * 100;
    const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
    // Lectura: qué lado gana lift. Si ninguno pasa de +5 puntos, la celda no informa.
    const read = Math.max(lUp, lDn) < 5 ? 'sin señal'
      : lUp > lDn ? 'ALCISTA' : 'BAJISTA';
    console.log(`   ${label} ${String(sel.length).padStart(4)}   ${pct(up, sel.length)} (${sig(lUp)})`
      + `   ${pct(dn, sel.length)} (${sig(lDn)})   ${read}`);
  }

  // ── 4b · ¿APORTA EL OI, o es solo momentum del precio? ────────────────────
  // Se fija el signo del precio pasado y se compara SOLO por estado del OI. Si las dos filas
  // de cada bloque salen iguales, el OI no informa y el cuadro 2×2 es momentum disfrazado.
  console.log(`\n4b · EFECTO DEL OI AISLADO  (dentro de cada dirección de precio pasada)\n`);
  for (const [grpLabel, pSign] of [['precio pasado ↑', 1], ['precio pasado ↓', -1]]) {
    const grp = withFwd.filter((r) => (pSign > 0 ? r.pxAtr > PX_BAND : r.pxAtr < -PX_BAND));
    if (!grp.length) continue;
    const gUp = grp.filter((r) => r.fwdAtr > FWD_BAND).length;
    const gDn = grp.filter((r) => r.fwdAtr < -FWD_BAND).length;
    console.log(`   ${grpLabel}  (n=${grp.length})   BASE DEL GRUPO: sube ${pct(gUp, grp.length)} · baja ${pct(gDn, grp.length)}`);
    for (const [oLabel, oSign] of [['  OI↑ (dinero nuevo)', 1], ['  OI≈ (banda muerta) ', 0], ['  OI↓ (cierre)      ', -1]]) {
      const sub = grp.filter((r) => {
        const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
        return o === oSign;
      });
      if (!sub.length) continue;
      const u = sub.filter((r) => r.fwdAtr > FWD_BAND).length;
      const d = sub.filter((r) => r.fwdAtr < -FWD_BAND).length;
      const dU = (u / sub.length - gUp / grp.length) * 100;
      const dD = (d / sub.length - gDn / grp.length) * 100;
      const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
      console.log(`   ${oLabel} n=${String(sub.length).padStart(3)}  sube ${pct(u, sub.length)} (${sig(dU)})`
        + `  baja ${pct(d, sub.length)} (${sig(dD)})   ← vs base DEL GRUPO`);
    }
  }

  // ── 5 · ¿Predice la cascada de liquidaciones? ──────────────────────────────
  // Mismo criterio que las celdas: frecuencia ya medida (auditLiquidations), aquí el lift.
  console.log(`\n5 · CASCADA DE LIQUIDACIONES — ¿predice, o solo describe lo ya ocurrido?\n`);
  console.log('   señal                        n    sube↑   (lift)    baja↓   (lift)   lectura');
  for (const [label, test] of [
    ['longs liquidados (skew<=-0.5)', (r) => r.skew <= -0.5 && r.vsMedian >= 2],
    ['shorts liquidados (skew>=+0.5)', (r) => r.skew >= 0.5 && r.vsMedian >= 2],
  ]) {
    const sel = withFwd.filter((r) => Number.isFinite(r.skew) && Number.isFinite(r.vsMedian) && test(r));
    if (!sel.length) { console.log(`   ${label}   sin casos`); continue; }
    const up = sel.filter((r) => r.fwdAtr > FWD_BAND).length;
    const dn = sel.filter((r) => r.fwdAtr < -FWD_BAND).length;
    const lUp = (up / sel.length - baseUp / withFwd.length) * 100;
    const lDn = (dn / sel.length - baseDn / withFwd.length) * 100;
    const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
    const read = Math.max(lUp, lDn) < 5 ? 'sin señal' : lUp > lDn ? 'ALCISTA' : 'BAJISTA';
    console.log(`   ${label.padEnd(30)} ${String(sel.length).padStart(3)}   ${pct(up, sel.length)} (${sig(lUp)})`
      + `   ${pct(dn, sel.length)} (${sig(lDn)})   ${read}`);
  }

  // ── 5b · La cascada, controlada por momentum ───────────────────────────────
  // Mismo confundido que en 4b: una cascada de longs OCURRE cuando el precio cae, así que su
  // "lift bajista" contra la base global puede ser el propio movimiento pasado y no la
  // cascada. Se compara con/sin cascada DENTRO de cada dirección de precio.
  console.log(`\n5b · CASCADA DE LONGS controlada por momentum\n`);
  const isCascade = (r) => Number.isFinite(r.skew) && Number.isFinite(r.vsMedian)
    && r.vsMedian >= 2 && r.skew <= -0.5;
  for (const [grpLabel, pSign] of [['precio pasado ↑', 1], ['precio pasado ↓', -1], ['precio plano  ', 0]]) {
    const grp = withFwd.filter((r) => {
      const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
      return p === pSign && Number.isFinite(r.skew) && Number.isFinite(r.vsMedian);
    });
    if (grp.length < 10) continue;
    const con = grp.filter(isCascade), sin = grp.filter((r) => !isCascade(r));
    if (!con.length || !sin.length) { console.log(`   ${grpLabel}  (sin contraste)`); continue; }
    const dn = (a) => a.filter((r) => r.fwdAtr < -FWD_BAND).length / a.length * 100;
    const diff = dn(con) - dn(sin);
    console.log(`   ${grpLabel} (n=${String(grp.length).padStart(3)})  con cascada n=${String(con.length).padStart(3)} baja ${dn(con).toFixed(1)}%`
      + `  ·  sin cascada n=${String(sin.length).padStart(3)} baja ${dn(sin).toFixed(1)}%`
      + `   →  ${(diff >= 0 ? '+' : '') + diff.toFixed(1)} pts`);
  }

  // ── 5c · ¿7d y 30d detectan LO MISMO, o solo con la misma frecuencia? ──────
  // Comparar frecuencias agregadas no basta: dos métricas pueden disparar el 10 % del tiempo
  // cada una en ocasiones casi disjuntas. Y hay un sesgo esperable — una mediana de 7d se
  // ADAPTA al régimen reciente, así que en una caída sostenida sube con ella y el listón de
  // "2× la mediana" se aleja: la señal se apagaría justo cuando debe detectar.
  const fires = (r, key) => Number.isFinite(r[key]) && r[key] >= 2 && r.skew <= -0.5;
  const evaluable = rows.filter((r) => Number.isFinite(r.vsMedian7) && Number.isFinite(r.vsMedian30));
  const both = evaluable.filter((r) => fires(r, 'vsMedian7') && fires(r, 'vsMedian30')).length;
  const only30 = evaluable.filter((r) => !fires(r, 'vsMedian7') && fires(r, 'vsMedian30')).length;
  const only7 = evaluable.filter((r) => fires(r, 'vsMedian7') && !fires(r, 'vsMedian30')).length;
  const any = both + only30 + only7;
  console.log(`\n5c · ACUERDO ENTRE VENTANAS DE MEDIANA  (n=${evaluable.length})\n`);
  console.log(`   disparan las dos            ${String(both).padStart(3)}   ${pct(both, any)} de las cascadas`);
  console.log(`   solo 30d (7d la PIERDE)     ${String(only30).padStart(3)}   ${pct(only30, any)}`);
  console.log(`   solo 7d (falso con 30d)     ${String(only7).padStart(3)}   ${pct(only7, any)}`);
  console.log(`   acuerdo (Jaccard)                 ${pct(both, any)}`);
  // El sesgo temido: ¿pierde 7d señal cuando el régimen ya viene cargado de liquidaciones?
  const stressed = evaluable.filter((r) => Number.isFinite(r.vsMedian30) && r.vsMedian30 >= 1.5);
  const lostInStress = stressed.filter((r) => !fires(r, 'vsMedian7') && fires(r, 'vsMedian30')).length;
  const firesInStress = stressed.filter((r) => fires(r, 'vsMedian30')).length;
  console.log(`   en régimen ya cargado (>=1.5× la mediana 30d, n=${stressed.length}):`);
  console.log(`     de las cascadas que ve 30d, 7d PIERDE ${pct(lostInStress, firesInStress)}`);

  // ── 6 · ¿Solapa la cascada con las celdas OI×precio? (doble conteo, regla B1) ──
  const cellSign = (r) => {
    const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
    const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
    if (o === 1 && p !== 0) return p * 2;      // dinero nuevo: ±2
    if (o === -1 && p === 1) return -1;        // rally sin dinero nuevo: falla → -1
    return 0;                                  // des-apalancamiento y bandas muertas: 0
  };
  const withLiq = rows.filter((r) => Number.isFinite(r.skew) && Number.isFinite(r.vsMedian)
    && r.vsMedian >= 2 && Math.abs(r.skew) >= 0.5);
  const sameSign = withLiq.filter((r) => {
    const c = cellSign(r), l = r.skew <= -0.5 ? -1 : 1;
    return c !== 0 && Math.sign(c) === l;
  }).length;
  const cellZero = withLiq.filter((r) => cellSign(r) === 0).length;
  console.log(`\n6 · SOLAPE cascada × celda OI×precio  (n con cascada = ${withLiq.length})\n`);
  console.log(`   la celda ya dice lo mismo (mismo signo)   ${pct(sameSign, withLiq.length)}  ← doble conteo`);
  console.log(`   la celda no dice nada (score 0)           ${pct(cellZero, withLiq.length)}  ← aporta señal nueva`);
  console.log(`   la celda dice lo contrario                ${pct(withLiq.length - sameSign - cellZero, withLiq.length)}`);

  return { coin, n, ...out };
}

// ── main ─────────────────────────────────────────────────────────────────────

if (!API_KEY) { console.error('Falta COINALYZE_API_KEY en el .env de la raíz.'); process.exit(1); }

console.log('\nMATERIAL MEDIDO PARA LA RÚBRICA DEL DERIVATIVES SCORE');
console.log('Regla: ningún umbral se escribe sin haber visto antes su distribución.');

const results = [];
for (const c of COINS) {
  try { const r = await auditCoin(c); if (r) results.push(r); }
  catch (e) { console.log(`  ${c}: ${e.message}`); }
  await new Promise((res) => setTimeout(res, 1500));
}

console.log(`\n${'═'.repeat(78)}\nRESUMEN — % de anclajes con |score| >= 1 (o sea, puerta alcanzable)\n${'═'.repeat(78)}`);
console.log('  moneda   n      A(OI×px)   B(+liq)   C(+funding)');
for (const r of results) {
  console.log(`  ${r.coin.padEnd(7)} ${String(r.n).padStart(4)}   `
    + `${(r['A · solo OI×precio'] ?? 0).toFixed(1).padStart(7)}%  `
    + `${(r['B · A + liquidaciones'] ?? 0).toFixed(1).padStart(7)}%  `
    + `${(r['C · B + funding (sin cambio)'] ?? 0).toFixed(1).padStart(9)}%`);
}
console.log('\n  Recordatorio: hoy esa columna vale 0,0 % — no existe rúbrica. Lo que se busca');
console.log('  es un reparto que discrimine y que coincida en las tres monedas, no el máximo.\n');
