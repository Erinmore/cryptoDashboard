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
import { disjointRate as disjointRateShared, verdictCI as verdictCIShared } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const DAYS = 90;
const LOOKBACK_4H = 6;          // 24h = 6 velas de 4h
const SQRT_WINDOW = Math.sqrt(LOOKBACK_4H);
// Horizonte de la ventana FUTURA que se mide (24h). Un solo dueño: lo usan el cálculo de
// `fwdAtr` y el criterio de disjunción de `disjointChain` — si divergieran, el submuestreo
// diría "independientes" sobre ventanas que en realidad se solapan.
const FWD_HORIZON_SEC = LOOKBACK_4H * 4 * 3600;
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
    const fwdT = t + FWD_HORIZON_SEC;
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
  // futuro, así que NO son independientes y un IC calculado sobre los n crudos sale ~√6
  // veces demasiado estrecho (el mismo fallo de denominador que infló el "24-42 %" de
  // `volatility_state` y el 0,225R de la expectativa).
  //
  // ⚠️⚠️ ESTE COMENTARIO MINTIÓ HASTA EL 2026-08-02. Decía que "el Wilson se calcula sobre
  // anclajes NO solapados (uno de cada 6) y se reporta ese n aparte", y era FALSO:
  // `wilsonInterval` estaba IMPORTADO Y NUNCA LLAMADO en todo el fichero. O sea que las
  // cifras de §4/§5 se venían leyendo como porcentajes pelados, sin ningún intervalo, con
  // un comentario al lado asegurando lo contrario — que es peor que no tener nada, porque
  // invita a confiar. Corregido implementando `disjointRate()` de verdad (abajo), que es lo
  // que el comentario prometía. El IC llegó a §4 y §4b el 2026-08-03 (§4c y §4d).
  const FWD_BAND = 0.5;
  // Nº de chains alternativas que se recorren para comprobar que el resultado no depende de
  // por dónde se empiece a submuestrear. 6 = anclajes por horizonte (24h / 4h), o sea las
  // fases distintas que existen cuando los anclajes son consecutivos.
  const STRIDE = LOOKBACK_4H;

  /**
   * Anclajes independientes + Wilson. La implementación vive en `scripts/lib/disjointAnchors.mjs`
   * (dueño único, extraído el 2026-08-03 al necesitarla también `auditVetoFrequency`): dos
   * definiciones distintas de "qué es una muestra independiente" es justo el modo de fallo
   * que este proyecto acaba de pagar con las claves de los clusters.
   */
  const disjointRate = (sel, dir = -1) => disjointRateShared(
    sel,
    (r) => (dir < 0 ? r.fwdAtr < -FWD_BAND : r.fwdAtr > FWD_BAND),
    { horizonSec: FWD_HORIZON_SEC, stride: STRIDE },
  );

  const fmtCI = (d) => d
    ? `${d.point.toFixed(1).padStart(5)} % [${d.low.toFixed(1)}-${d.high.toFixed(1)}] n_ef=${String(d.n_eff).padStart(3)}`
      + (d.spread ? ` · arranques ${d.spread[0].toFixed(0)}-${d.spread[1].toFixed(0)}` : '')
    : 'n insuficiente';
  /** IC compacto, sin el rango de arranques (para las tablas de dos columnas de §4c/§4d). */
  const fmtCIshort = (d) => (d
    ? `${d.point.toFixed(1).padStart(5)} [${d.low.toFixed(1)}-${d.high.toFixed(1)}] n=${String(d.n_eff).padStart(3)}`
    : 'n insuficiente').padEnd(24);

  /**
   * Veredicto de una comparación subconjunto ↔ SU COMPLEMENTO.
   *
   * Por qué el complemento y no la base: la base CONTIENE al subconjunto, así que sus dos
   * intervalos no son comparables por solape (comparten observaciones). El complemento es
   * una muestra disjunta y la comparación sí se sostiene.
   *
   * Dos conservadurismos declarados, ambos en la dirección segura:
   *   · el no-solape de dos IC es un criterio MÁS ESTRICTO que un contraste de diferencia de
   *     proporciones, así que "solapa" NO significa "no hay efecto", significa NO DEMOSTRADO;
   *   · cada población se adelgaza por separado, luego un ancla del subconjunto y otra del
   *     complemento pueden distar 4h y compartir futuro. Esa correlación es POSITIVA, o sea
   *     que Var(p̂₁−p̂₂) real < la que implica tratarlas como independientes → el criterio
   *     peca de exigente, nunca de laxo.
   *
   * No hay umbral de n: un n_ef bajo ensancha el Wilson hasta solapar por sí solo, así que
   * el propio intervalo hace de guarda y no hace falta inventar una constante.
   *
   * La REGLA vive en `scripts/lib/disjointAnchors.mjs` (dueño único); aquí solo se formatea.
   */
  const verdictCI = (a, b) => {
    const v = verdictCIShared(a, b);
    if (v.separated === null) return 'n insuf.';
    return v.separated ? 'SEPARADO' : 'solapa  ';
  };
  /**
   * Diferencia de los estimadores PUNTUALES, al lado del veredicto.
   *
   * Sin ella, un "0 de 8 separan" se lee como "aquí no pasa nada", y no es lo mismo un solape
   * con Δ=+0,2 pt que uno con Δ=+28 pt: el segundo es un efecto grande que esta muestra no
   * puede resolver. No introduce ningún umbral — son los dos puntos que ya se imprimen.
   */
  const fmtDelta = (a, b) => (a && b
    ? `Δ=${(a.point - b.point >= 0 ? '+' : '') + (a.point - b.point).toFixed(1).padStart(5)} pt`
    : '');
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
  // Se guarda la selección de cada celda para que §4c mida EXACTAMENTE las mismas filas.
  // Recalcularla allí crearía un segundo dueño de la definición de celda — el patrón que
  // ya produjo el bug de `analysis_liquidation_snapshot`.
  const cellSelections = [];
  for (const [label, o, p] of cellDefs) {
    const sel = withFwd.filter((r) => {
      const oo = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
      const pp = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
      return oo === o && pp === p;
    });
    if (!sel.length) continue;
    cellSelections.push({ label, sel });
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
  // Mismo motivo que en §4: se guardan las selecciones para que §4d mida las mismas filas.
  const oiSelections = [];
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
      oiSelections.push({ grpLabel, oLabel, grp, sub });
      const u = sub.filter((r) => r.fwdAtr > FWD_BAND).length;
      const d = sub.filter((r) => r.fwdAtr < -FWD_BAND).length;
      const dU = (u / sub.length - gUp / grp.length) * 100;
      const dD = (d / sub.length - gDn / grp.length) * 100;
      const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
      console.log(`   ${oLabel} n=${String(sub.length).padStart(3)}  sube ${pct(u, sub.length)} (${sig(dU)})`
        + `  baja ${pct(d, sub.length)} (${sig(dD)})   ← vs base DEL GRUPO`);
    }
  }

  // ── 4c · §4 CON INTERVALO (A8, 2026-08-03) ────────────────────────────────
  // Los porcentajes de §4 y §4b son insesgados como PUNTO pero se leían sin ninguna medida
  // de incertidumbre, y sobre ellos descansa el argumento entero de por qué la rúbrica
  // puntúa dos celdas y enmudece las otras dos (composiciones F-I de §3, y con ellas el
  // `cellMeasured` que acabó en producción). Aquí van con IC sobre anclajes de ventana
  // futura DISJUNTA, contrastados contra su COMPLEMENTO (ver `verdictCI`).
  //
  // ⚠️ Leer con la expectativa puesta: cuando se encendió el IC en §5ter, el hallazgo que
  // sostenía ("el skew aporta sobre la magnitud") dejó de estar demostrado. Es perfectamente
  // posible que aquí pase lo mismo — saberlo antes del checkpoint es el objetivo, no un
  // efecto colateral.
  const complementOf = (universe, sel) => {
    // Por REFERENCIA, no por `t`: `sel` siempre sale de filtrar `universe`, así que los
    // objetos son los mismos y la resta es exacta sin suponer que `t` es único.
    const s = new Set(sel);
    return universe.filter((r) => !s.has(r));
  };
  console.log(`\n4c · §4 CON ANCLAJES INDEPENDIENTES  (ventanas futuras disjuntas, >=24 h)\n`);
  console.log('   Cada celda contra SU COMPLEMENTO (el resto de anclajes), no contra la base:');
  console.log('   la base la contiene, así que comparar sus intervalos no significaría nada.\n');
  console.log('   celda                     dir     celda                     resto                     veredicto  Δ puntual');
  let sepCells = 0, totCells = 0;
  for (const { label, sel } of cellSelections) {
    const rest = complementOf(withFwd, sel);
    for (const [dirLabel, dir] of [['sube↑', 1], ['baja↓', -1]]) {
      const a = disjointRate(sel, dir);
      const b = disjointRate(rest, dir);
      const v = verdictCI(a, b);
      totCells++; if (v === 'SEPARADO') sepCells++;
      console.log(`   ${label} ${dirLabel}  ${fmtCIshort(a)}  ${fmtCIshort(b)}  ${v}  ${fmtDelta(a, b)}`);
    }
  }
  console.log(`\n   → ${sepCells} de ${totCells} filas separan. Recordatorio de lo que NO dice un solape:`);
  console.log('     no dice "no hay efecto", dice que ESTOS datos no lo demuestran. Y no recoge la');
  console.log('     réplica ENTRE MONEDAS, que es la otra mitad del argumento original — pero esa');
  console.log('     réplica tampoco se puede juntar en un IC: las 3 comparten el factor mercado.');

  // ── 4d · §4b CON INTERVALO ────────────────────────────────────────────────
  // Aquí el complemento es DENTRO DEL GRUPO (los otros estados del OI con la misma dirección
  // de precio pasada), que es justo lo que aísla el OI del momentum. Es la comparación que
  // en §4b se hacía contra la base del grupo — y la base del grupo también contiene al
  // subconjunto, así que el complemento es además la versión comparable.
  console.log(`\n4d · §4b CON ANCLAJES INDEPENDIENTES  (OI contra el resto de SU grupo)\n`);
  console.log('   grupo · estado OI                    dir     subconjunto               resto del grupo           veredicto  Δ puntual');
  let sepOi = 0, totOi = 0;
  for (const { grpLabel, oLabel, grp, sub } of oiSelections) {
    const rest = complementOf(grp, sub);
    if (!rest.length) continue;
    for (const [dirLabel, dir] of [['sube↑', 1], ['baja↓', -1]]) {
      const a = disjointRate(sub, dir);
      const b = disjointRate(rest, dir);
      const v = verdictCI(a, b);
      totOi++; if (v === 'SEPARADO') sepOi++;
      console.log(`   ${grpLabel} ${oLabel.trim().padEnd(20)} ${dirLabel}  ${fmtCIshort(a)}  ${fmtCIshort(b)}  ${v}  ${fmtDelta(a, b)}`);
    }
  }
  console.log(`\n   → ${sepOi} de ${totOi} filas separan.`);

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

  // ── 5bis · ¿APORTA EL `skew`, o manda sólo la MAGNITUD? ────────────────────
  // Pregunta abierta el 2026-08-02 al reconstruir las 10 mediciones del periodo: el `skew`
  // pasaba 6 de 10 y la magnitud 1 de 10, y el ancla con el skew MÁS extremo de la serie
  // (−0,995) no disparó porque su magnitud se quedó en 1,8×. Si históricamente el `skew`
  // pasa casi siempre que la magnitud pasa, el corte de −0,50 es DECORATIVO: la regla sería
  // de una sola variable con una segunda condición que no separa nada. Es el patrón T1
  // (rama muerta), pero por el lado contrario — no una condición que nunca se cumple, sino
  // una que se cumple siempre que importa.
  //
  // ⚠️ Lo que YA estaba medido y no contesta esto: `auditLiquidations` reporta la frecuencia
  // MARGINAL de cada condición, y §5/§5b de aquí miden el lift de la CONJUNCIÓN. Ninguna de
  // las dos compara la conjunción contra "magnitud sola", que es la única comparación que
  // dice si el `skew` aporta.
  console.log(`\n5bis · ¿APORTA EL skew SOBRE LA MAGNITUD?  (¿o es un corte decorativo?)\n`);
  const evalRows = withFwd.filter((r) => Number.isFinite(r.skew) && Number.isFinite(r.vsMedian));
  const MAG = 2, SKEW = -0.5;
  if (evalRows.length < 30) {
    console.log('   muestra insuficiente');
  } else {
    // (a) REDUNDANCIA: ¿cuánto se solapan? Si P(skew|mag) ≈ 100 %, el corte no filtra nada.
    const mag = evalRows.filter((r) => r.vsMedian >= MAG);
    const skw = evalRows.filter((r) => r.skew <= SKEW);
    const bothC = evalRows.filter((r) => r.vsMedian >= MAG && r.skew <= SKEW);
    console.log(`   magnitud >= ${MAG}×          ${pct(mag.length, evalRows.length)}  (n=${mag.length})`);
    console.log(`   skew <= ${SKEW}             ${pct(skw.length, evalRows.length)}  (n=${skw.length})`);
    console.log(`   ambas (la regla)          ${pct(bothC.length, evalRows.length)}  (n=${bothC.length})`);
    console.log(`   → de las que pasan MAGNITUD, ¿cuántas pasan también skew?  ${pct(bothC.length, mag.length)}`);
    console.log(`   → de las que pasan SKEW,     ¿cuántas pasan también magnitud? ${pct(bothC.length, skw.length)}`);
    console.log('   (si la primera está cerca del 100 %, el skew no filtra: es decorativo)\n');

    // (b) CONTRIBUCIÓN MARGINAL: 2×2 con el lift bajista. La fila que decide es la segunda —
    // magnitud SIN skew. Si baja igual que la regla completa, el skew no aporta.
    const dnRate = (a) => (a.filter((r) => r.fwdAtr < -FWD_BAND).length / a.length) * 100;
    const base = (baseDn / withFwd.length) * 100;
    console.log(`   TASA BASE bajista del activo: ${base.toFixed(1)} %\n`);
    console.log('   celda                                 n    baja↓    lift');
    for (const [label, test] of [
      [`mag>=${MAG}× Y skew<=${SKEW}   (regla actual)`, (r) => r.vsMedian >= MAG && r.skew <= SKEW],
      [`mag>=${MAG}× y skew> ${SKEW}   (solo magnitud)`, (r) => r.vsMedian >= MAG && r.skew > SKEW],
      [`mag< ${MAG}× Y skew<=${SKEW}   (solo skew)    `, (r) => r.vsMedian < MAG && r.skew <= SKEW],
      [`mag< ${MAG}× y skew> ${SKEW}   (ninguna)      `, (r) => r.vsMedian < MAG && r.skew > SKEW],
    ]) {
      const sel = evalRows.filter(test);
      if (sel.length < 5) { console.log(`   ${label} ${String(sel.length).padStart(4)}   n<5, no se lee`); continue; }
      const d = dnRate(sel);
      const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
      console.log(`   ${label} ${String(sel.length).padStart(4)}   ${d.toFixed(1).padStart(5)} %  ${sig(d - base)}`);
    }

    // (c) BARRIDO del corte de skew DENTRO de magnitud>=2. Si el lift no se mueve al
    // endurecerlo, el corte concreto da igual y sobra. Mismo método que el barrido de
    // `auditConditionalRR`: un umbral que no cambia nada al moverse no está midiendo.
    console.log(`\n   Barrido del corte de skew, sólo dentro de magnitud >= ${MAG}×:`);
    console.log('     corte      n    baja↓    lift');
    for (const c of [0, -0.3, -0.5, -0.7, -0.9]) {
      const sel = evalRows.filter((r) => r.vsMedian >= MAG && r.skew <= c);
      if (sel.length < 5) { console.log(`     ${c.toFixed(1).padStart(5)}  ${String(sel.length).padStart(4)}   n<5`); continue; }
      const d = dnRate(sel);
      const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
      console.log(`     ${c.toFixed(1).padStart(5)}  ${String(sel.length).padStart(4)}   ${d.toFixed(1).padStart(5)} %  ${sig(d - base)}`);
    }

    // (d) CONTROL DE MOMENTUM. Una cascada de longs ocurre CUANDO el precio cae, así que el
    // lift bajista contra la base global puede ser el movimiento pasado (mismo confundido
    // que tumbó `OI↑px↓` en §4b). Se repite dentro de "precio pasado ↓".
    const dnGrp = evalRows.filter((r) => r.pxAtr < -PX_BAND);
    if (dnGrp.length >= 20) {
      const gBase = dnRate(dnGrp);
      console.log(`\n   Controlado por momentum — sólo precio pasado ↓ (n=${dnGrp.length}, base ${gBase.toFixed(1)} %):`);
      for (const [label, test] of [
        ['     con skew<=-0.5 y mag>=2×', (r) => r.vsMedian >= MAG && r.skew <= SKEW],
        ['     mag>=2× sin exigir skew  ', (r) => r.vsMedian >= MAG],
      ]) {
        const sel = dnGrp.filter(test);
        if (sel.length < 5) { console.log(`${label} n=${sel.length} (n<5)`); continue; }
        const d = dnRate(sel);
        const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
        console.log(`${label} n=${String(sel.length).padStart(3)}  baja ${d.toFixed(1).padStart(5)} %  ${sig(d - gBase)} vs base del grupo`);
      }
    }
  }

  // ── 5ter · LA POBLACIÓN QUE IMPORTA: sólo donde la celda OI×precio CALLA ───
  // La cascada sólo puntúa si el eje OI×precio no dijo nada (anti-doble-conteo B1), así que
  // su valor real no se mide sobre todos los anclajes sino sobre ésos. Es una condición
  // distinta de "el precio cayó" (el control de momentum de arriba) y es la que reproduce
  // lo que hace producción.
  {
    const cellScore = (r) => {
      const o = r.oiChange > OI_DEAD_BAND ? 1 : r.oiChange < -OI_DEAD_BAND ? -1 : 0;
      const p = r.pxAtr > PX_BAND ? 1 : r.pxAtr < -PX_BAND ? -1 : 0;
      return (o === 1 && p === 1) ? 1 : (o === -1 && p === 1) ? -1 : 0;
    };
    const mute = withFwd.filter((r) => Number.isFinite(r.skew) && Number.isFinite(r.vsMedian)
      && cellScore(r) === 0);
    console.log(`\n5ter · SÓLO DONDE LA CELDA CALLA  (es cuando la cascada puntúa)\n`);
    if (mute.length < 30) { console.log('   muestra insuficiente'); }
    else {
      const dnRate = (a) => (a.filter((r) => r.fwdAtr < -FWD_BAND).length / a.length) * 100;
      const mBase = dnRate(mute);
      console.log(`   n=${mute.length} · base bajista de esta población: ${mBase.toFixed(1)} %`);
      console.log('   celda                                 n    baja↓    lift');
      for (const [label, test] of [
        ['   mag>=2× Y skew<=-0.5 (regla)     ', (r) => r.vsMedian >= 2 && r.skew <= -0.5],
        ['   mag>=2× sin exigir skew          ', (r) => r.vsMedian >= 2],
        ['   skew<=-0.5 sin exigir magnitud   ', (r) => r.skew <= -0.5],
      ]) {
        const sel = mute.filter(test);
        if (sel.length < 5) { console.log(`${label} ${String(sel.length).padStart(4)}   n<5`); continue; }
        const d = dnRate(sel);
        const sig = (x) => (x >= 0 ? '+' : '') + x.toFixed(1).padStart(5);
        console.log(`${label} ${String(sel.length).padStart(4)}   ${d.toFixed(1).padStart(5)} %  ${sig(d - mBase)}`);
      }
      // Lo anterior son porcentajes sobre anclajes SOLAPADOS: insesgados como punto, pero sin
      // ninguna medida de incertidumbre. Aquí va lo que el comentario de §4 prometía y no
      // hacía — el mismo cálculo sobre ventanas futuras DISJUNTAS, que es el n que de verdad
      // hay. Si los intervalos de las dos primeras filas se solapan, "el skew aporta" NO está
      // demostrado por muchos puntos de lift que separe el estimador puntual.
      console.log('\n   Con anclajes INDEPENDIENTES (ventanas futuras disjuntas, >=24 h):');
      console.log(`     base de la población      ${fmtCI(disjointRate(mute))}`);
      console.log(`     regla (mag>=2 Y skew)     ${fmtCI(disjointRate(mute.filter((r) => r.vsMedian >= 2 && r.skew <= -0.5)))}`);
      console.log(`     mag>=2 sin exigir skew    ${fmtCI(disjointRate(mute.filter((r) => r.vsMedian >= 2)))}`);
    }
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

  return { coin, n, sepCells, totCells, sepOi, totOi, ...out };
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
console.log('  es un reparto que discrimine y que coincida en las tres monedas, no el máximo.');

console.log(`\n${'═'.repeat(78)}\nA8 — ¿SOBREVIVEN §4 y §4b AL IC DE ANCLAJES DISJUNTOS?\n${'═'.repeat(78)}`);
console.log('  moneda   §4c celdas separan   §4b/§4d OI aislado separa');
for (const r of results) {
  console.log(`  ${r.coin.padEnd(7)} ${String(r.sepCells ?? 0).padStart(6)} / ${String(r.totCells ?? 0).padEnd(12)}`
    + `${String(r.sepOi ?? 0).padStart(6)} / ${r.totOi ?? 0}`);
}
console.log('\n  Si estas columnas salen a cero, los lifts de §4/§4b siguen siendo el mejor');
console.log('  estimador puntual que hay, pero NO están demostrados sobre anclajes');
console.log('  independientes: se leen como material de trabajo, no como evidencia cerrada.\n');
