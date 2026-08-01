/**
 * auditOpportunityRegimeCurve.mjs — produce la tabla de `OPPORTUNITY_BASE_RATE` por régimen.
 *
 * POR QUÉ. `OPPORTUNITY_BASE_RATE` es hoy un ESCALAR (34,8 % a 24h) y se midió el 2026-08-01
 * que la magnitud varía **45,6 → 25,8 %** entre cuartiles de ATR%
 * (`auditBaseRateConditioning.mjs`). Un número único para algo que se mueve 20 puntos con el
 * régimen es la misma familia de fallo que un umbral escrito sin ver su distribución, solo
 * que en la REFERENCIA en vez de en el corte — y `offered_pct` es la cifra del checkpoint.
 *
 * LA DECISIÓN QUE ESTE SCRIPT RESUELVE ANTES DE ESCRIBIR NINGÚN NÚMERO: ¿con qué se indexa
 * la tabla? Hay dos candidatas y **elegir mal confunde MONEDA con RÉGIMEN**:
 *
 *   (a) **ATR% ABSOLUTO.** Cortes comunes a las tres monedas. Pero SOL es estructuralmente
 *       más volátil que BTC, así que BTC viviría en Q1 y SOL en Q4 por lo que SON, no por el
 *       régimen en que están. La "tasa por régimen" sería una tasa por moneda disfrazada.
 *
 *   (b) **PERCENTIL DEL ATR% DENTRO DE SU PROPIA VENTANA.** Definición relativa, libre de la
 *       escala del activo.
 *
 * ⚠️ NO se presupone que (b) sea la buena "porque es la convención del proyecto". Revisado el
 * código: de las cuatro magnitudes auto-normalizadas, **tres emparejan el percentil con un
 * criterio ABSOLUTO** — `high_volatility` exige percentil 90 Y ≥1,5× la mediana,
 * `adx.regime` lleva `absoluteFloor: ADX_RANGING_THRESHOLD` y `cvd_strength`
 * `absoluteFloor: 0.25`; sólo `volatility_state` va con percentil pelado. Y T1 es
 * precisamente el caso donde el percentil PURO se probó y se RECHAZÓ (en un mercado plano el
 * decil superior sigue siendo casi-nada). Así que la convención real es "percentil propio +
 * criterio absoluto cuando «pequeño» tiene significado físico", y cuál toca aquí es una
 * pregunta empírica, no una que se resuelva citando precedentes.
 *
 * ANCLA PARA DECIDIR, fijada antes de ejecutar: **la clave correcta es aquella con la que las
 * tres monedas dan la MISMA curva.** Si con percentil propio las tres se superponen y con
 * ATR% absoluto se separan, la conditioning variable es (b) — y a la inversa. Si ninguna
 * superpone, no hay tabla que escribir y hay que decirlo.
 *
 * Ancla secundaria: la tabla debe REPRODUCIR el 34,8 % publicado al promediar sobre todos los
 * anclajes (es la misma medición, solo que desagregada). Una discrepancia grande significaría
 * que este script no está midiendo lo mismo que `auditOpportunityThresholds`.
 *
 * SOLO LECTURA. Binance público, sin API keys. No abre la BBDD.
 *
 * Uso: node scripts/auditOpportunityRegimeCurve.mjs   ·   DAYS=200 node scripts/...
 */

import { calculateATR, calculateATRSeries } from '../src/utils/indicators.js';
import { percentileRank } from '../src/utils/percentiles.js';
import { computeFirstPassage } from '../src/utils/pathMetrics.js';
import { classifyOpportunity, wilsonInterval } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const DAYS = Number(process.env.DAYS ?? 200);
const HOUR_MS = 3600 * 1000;
const H4_MS = 4 * HOUR_MS;
const ATR_PERIOD = 14;
const REGIME_WIN = 180;          // ventana de producción del TF 4h — la misma con la que el
                                 // backend sitúa cualquier magnitud en su propia distribución
const HORIZONS = [['24h', 24], ['7d', 168]];

async function klines(symbol, interval, limit = 1000, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
  }));
}
async function deep(symbol, interval, want) {
  const out = []; let endTime;
  for (let i = 0; i < 10 && out.length < want; i++) {
    const b = await klines(symbol, interval, 1000, endTime);
    if (!b.length) break;
    out.unshift(...b); endTime = b[0].t - 1;
    if (b.length < 1000) break;
  }
  return out;
}

const rows = [];
for (const coin of COINS) {
  const k4 = await deep(coin, '4h', Math.ceil((DAYS * 24) / 4) + REGIME_WIN + 40);
  const k1 = await deep(coin, '1h', DAYS * 24 + 500);
  if (!k4.length || !k1.length) { console.log(`${coin}: sin datos`); continue; }

  // Serie completa de ATR% en una pasada (evita el O(n²) de re-slicing).
  const atrByIdx = new Map((calculateATRSeries(k4, ATR_PERIOD) ?? []).map((e) => [e.idx, e.atr]));
  const atrPct = k4.map((c, i) => {
    const a = atrByIdx.get(i);
    return Number.isFinite(a) && c.close > 0 ? (a / c.close) * 100 : null;
  });

  const times = k1.map((c) => c.t);
  const idxFrom = (t) => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; } return lo; };
  const last = k1.at(-1)?.t ?? 0;

  for (let i = REGIME_WIN; i < k4.length; i++) {
    const a = atrPct[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    // Percentil del ATR% actual DENTRO DE SU PROPIA ventana de 180 velas — misma
    // construcción que `volatility_state` y `adx.regime`.
    const win = atrPct.slice(i - REGIME_WIN + 1, i + 1).filter(Number.isFinite);
    if (win.length < 60) continue;
    const pctile = percentileRank(win, a);
    if (pctile == null) continue;

    const c = k4[i];
    const tMs = c.t + H4_MS;
    const from = idxFrom(tMs);
    const path = k1.slice(from, from + 7 * 24 + 2);
    const fp = computeFirstPassage(path, c.close, a, tMs, 7 * 24 * HOUR_MS);
    if (!fp) continue;

    const rec = { coin, atrPct: a, pctile };
    for (const [label, hH] of HORIZONS) {
      if (last < tMs + hH * HOUR_MS) { rec[label] = null; continue; }
      // `now: null` = sin censura por horizonte: la cobertura ya la garantiza el `continue`
      // de arriba, y estas filas sintéticas no llevan `timestamp`. Sin él, el gate de
      // producción las dejaría `pending` y aquí se filtra por `evaluable` → todo `offered`.
      const op = classifyOpportunity({ path_first_passage: fp }, { horizonH: hH, now: null });
      rec[label] = op.evaluable ? op.offered : null;
    }
    rows.push(rec);
  }
}

// ── reporte ──────────────────────────────────────────────────────────────────

const pctf = (k, n) => (n ? (k / n) * 100 : null);
const fmt = (x, d = 1) => (x == null ? '  —  ' : x.toFixed(d));
const cutsOf = (xs, ps) => { const s = [...xs].sort((a, b) => a - b); return ps.map((p) => s[Math.floor((s.length - 1) * p)]); };

console.log('CURVA DE `OPPORTUNITY_BASE_RATE` POR RÉGIMEN — ¿con qué se indexa?');
console.log(`${DAYS} d · ${COINS.join('+')} · n=${rows.length} anclas 4h · ventana de régimen ${REGIME_WIN}`);
console.log('ANCLA: la clave correcta es aquella con la que las 3 MONEDAS dan la MISMA curva.\n');

for (const [hLabel] of HORIZONS) {
  const ev = rows.filter((r) => r[hLabel] != null);
  if (!ev.length) continue;
  const overall = pctf(ev.filter((r) => r[hLabel]).length, ev.length);
  console.log('═'.repeat(94));
  console.log(`HORIZONTE ${hLabel} · n=${ev.length} · tasa global ${fmt(overall)}%`
    + `   (referencia publicada: ${hLabel === '24h' ? '34,8' : '36,0'} %)`);

  for (const [keyLabel, keyOf, cuts] of [
    ['(a) ATR% ABSOLUTO', (r) => r.atrPct, cutsOf(ev.map((r) => r.atrPct), [0.2, 0.4, 0.6, 0.8])],
    ['(b) PERCENTIL propio', (r) => r.pctile, [20, 40, 60, 80]],
  ]) {
    console.log(`\n  ${keyLabel}   cortes ${cuts.map((c) => fmt(c, 2)).join(' · ')}`);
    const bucketOf = (r) => { const v = keyOf(r); let b = 0; for (const c of cuts) if (v > c) b++; return b; };
    const head = ['bucket', 'TODAS', ...COINS];
    console.log(`    ${head[0].padEnd(10)}${head.slice(1).map((h) => h.padStart(16)).join('')}`);
    let spread = 0;
    for (let b = 0; b < 5; b++) {
      const g = ev.filter((r) => bucketOf(r) === b);
      const cells = [null, ...COINS].map((c) => {
        const sel = c ? g.filter((r) => r.coin === c) : g;
        if (!sel.length) return '   —   '.padStart(16);
        const k = sel.filter((r) => r[hLabel]).length;
        return `${fmt(pctf(k, sel.length))}% (${sel.length})`.padStart(16);
      });
      // Dispersión entre monedas dentro del bucket: es LA cifra que decide la clave.
      const per = COINS.map((c) => {
        const sel = g.filter((r) => r.coin === c);
        return sel.length >= 30 ? pctf(sel.filter((r) => r[hLabel]).length, sel.length) : null;
      }).filter((x) => x != null);
      if (per.length >= 2) spread += Math.max(...per) - Math.min(...per);
      console.log(`    ${`Q${b + 1}`.padEnd(10)}${cells.join('')}`);
    }
    console.log(`    → dispersión ACUMULADA entre monedas (menor = mejor clave): ${fmt(spread)} pt`);
  }
}

// ── INDEPENDENCIA — sin esto la tabla se escribiría sobre ruido ──────────────
// Anclajes consecutivos van a 4h y el horizonte es de 24h (o 7d): comparten 5/6 (o 41/42)
// de su ventana futura, así que NO son independientes y el IC de Wilson sale ~√6 (o √42)
// veces demasiado estrecho. Es el mismo fallo de denominador que infló el "24-42 %" de
// `volatility_state`. Se rehace con anclajes SEPARADOS por el horizonte completo.
console.log(`\n${'═'.repeat(94)}\nCONTRASTE CON ANCLAJES INDEPENDIENTES (ventanas futuras disjuntas)\n`);
for (const [hLabel, hH] of HORIZONS) {
  const step = Math.max(1, Math.round(hH / 4));         // anclas de 4h que cubre el horizonte
  const ev = rows.filter((r) => r[hLabel] != null);
  const indep = [];
  for (const coin of COINS) {
    const g = ev.filter((r) => r.coin === coin);
    for (let i = 0; i < g.length; i += step) indep.push(g[i]);
  }
  console.log(`  ${hLabel} · paso ${step} anclas · n=${indep.length} (de ${ev.length})`);
  const cuts = [20, 40, 60, 80];
  const bucketOf = (r) => { let b = 0; for (const c of cuts) if (r.pctile > c) b++; return b; };
  for (let b = 0; b < 5; b++) {
    const g = indep.filter((r) => bucketOf(r) === b);
    if (!g.length) continue;
    const k = g.filter((r) => r[hLabel]).length;
    const ci = wilsonInterval(k, g.length);
    console.log(`    percentil Q${b + 1}  n=${String(g.length).padStart(4)}  ${fmt(pctf(k, g.length)).padStart(6)}%`
      + `  IC[${ci.low}-${ci.high}]`);
  }
  const all = wilsonInterval(indep.filter((r) => r[hLabel]).length, indep.length);
  console.log(`    GLOBAL      n=${String(indep.length).padStart(4)}  ${fmt(all.point).padStart(6)}%  IC[${all.low}-${all.high}]`);
}

// ── tabla propuesta, en el formato del código ────────────────────────────────
console.log(`\n${'═'.repeat(94)}\nTABLA PROPUESTA (percentil propio del ATR%, puntos para interpolar)\n`);
for (const [hLabel] of HORIZONS) {
  const ev = rows.filter((r) => r[hLabel] != null);
  if (!ev.length) continue;
  const pts = [10, 30, 50, 70, 90].map((p) => {
    const g = ev.filter((r) => Math.abs(r.pctile - p) <= 10);
    const k = g.filter((r) => r[hLabel]).length;
    const ci = wilsonInterval(k, g.length);
    return `    ${p}: ${fmt(pctf(k, g.length))},   // n=${g.length}  IC[${ci.low}-${ci.high}]`;
  });
  console.log(`  '${hLabel}': {\n${pts.join('\n')}\n  },`);
}
