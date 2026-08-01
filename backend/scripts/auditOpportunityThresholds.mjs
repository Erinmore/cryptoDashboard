/**
 * auditOpportunityThresholds.mjs — ¿discrimina algo la métrica de coste de oportunidad?
 *
 * Motivación: el par de múltiplos (target/adverse) se introdujo en la Fase 5 como CONVENCIÓN
 * declarada, no como umbral calibrado. Este script hace con ella lo que
 * `auditThresholds.mjs` hizo con los cortes de la ruta de decisión, y añade lo que allí no
 * hacía falta: la TASA BASE.
 *
 * Mide dos cosas distintas:
 *
 *  1. DEGENERACIÓN — para cada par (target, adverse) de la rejilla, con qué frecuencia el
 *     mercado ofreció un movimiento limpio. Una celda al 2 % o al 95 % no distingue un
 *     `Esperar` acertado de uno equivocado: es una constante disfrazada, el mismo fallo que
 *     `high_volatility` al 0,0 % en 12/12 combinaciones (T1).
 *
 *  2. TASA BASE INCONDICIONAL — la frecuencia medida sobre TODOS los cierres de vela del
 *     periodo, sin mirar qué decidió el sistema. Es la referencia que le falta a
 *     `opportunity_cost`: si los `Esperar` de CRYPTEX ofrecen oportunidad al mismo ritmo
 *     que un instante cualquiera, la abstención NO aporta información, por bueno que
 *     parezca el porcentaje en términos absolutos. La cifra sola no significa nada; la
 *     diferencia contra esta línea base sí.
 *
 * IMPORTANTE — el criterio se fija ANTES de mirar las decisiones del sistema, y sobre
 * historia de mercado, no sobre sus outcomes. Elegir el múltiplo que deja a CRYPTEX en buen
 * (o mal) lugar reintroduciría la circularidad de validación que señaló la 1ª auditoría
 * red-team. Por eso este script NO abre la BBDD.
 *
 * Método: anclas = cada cierre de vela del TF primario; ATR% del TF primario en ese
 * instante; recorrido posterior sobre velas de 1h, con las MISMAS funciones que usa el job
 * (`computeFirstPassage`, `classifyOpportunity`) — no reimplementaciones.
 *
 * Es SOLO LECTURA: no toca la BBDD ni producción. No requiere API keys (Binance público).
 *
 * Uso:
 *   node scripts/auditOpportunityThresholds.mjs              # SOL, BTC, ETH · 4h · 90 días
 *   COINS=SOL TF=1h DAYS=60 node scripts/auditOpportunityThresholds.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { computeFirstPassage, ATR_MULTIPLES } from '../src/utils/pathMetrics.js';
import { classifyOpportunity, opportunityParamsFor } from '../src/utils/stats.js';

const HOUR_MS = 3600 * 1000;
const TF_MS = { '1h': HOUR_MS, '4h': 4 * HOUR_MS, '1D': 24 * HOUR_MS };
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d' };

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const TF = process.env.TF ?? '4h';          // TF primario del protocolo de recogida
const DAYS = Number(process.env.DAYS ?? 90);
const ATR_PERIOD = 14;

// Rejilla auditada. Todos los valores deben existir en ATR_MULTIPLES (es la rejilla que se
// persiste en `path_first_passage`): auditar un múltiplo que no se guarda no serviría de
// nada, porque luego no se podría reevaluar sobre los análisis reales.
const TARGETS = [1, 1.5, 2, 3, 4];
const ADVERSES = [0.5, 1, 1.5, 2];
const HORIZONS = [['24h', 24], ['7d', 168]];

// ── datos ────────────────────────────────────────────────────────────────────

/** Klines paginadas hacia atrás (Binance devuelve máx. 1000 por petición). */
async function fetchKlines(symbol, interval, sinceMs) {
  const out = [];
  let start = sinceMs;
  for (let guard = 0; guard < 20; guard++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT`
      + `&interval=${interval}&startTime=${start}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${res.status}`);
    const batch = (await res.json()).map((r) => ({
      t: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    }));
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 1000) break;
    start = batch[batch.length - 1].t + 1;
  }
  return out;
}

// ── medición ─────────────────────────────────────────────────────────────────

/**
 * Evalúa cada cierre de vela del TF primario como si allí se hubiera hecho un análisis.
 * Devuelve, por horizonte y por par de la rejilla, cuántas anclas ofrecieron movimiento.
 */
function measure(anchors, hourly, tfMs) {
  // Índice de la primera vela 1h >= t, para no re-filtrar el array entero por ancla.
  const byTime = hourly.map((c) => c.t);
  const idxFrom = (t) => {
    let lo = 0, hi = byTime.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (byTime[m] < t) lo = m + 1; else hi = m; }
    return lo;
  };

  const results = {};
  for (const [hLabel] of HORIZONS) {
    results[hLabel] = { n: 0, grid: {}, hoursTo: [], excursions: [] };
    for (const tk of TARGETS) for (const ak of ADVERSES) results[hLabel].grid[`${tk}|${ak}`] = 0;
  }

  const lastHourly = hourly.length ? hourly[hourly.length - 1].t : 0;

  for (const a of anchors) {
    const tMs = a.t + tfMs;              // el análisis ocurre al CIERRE de la vela
    const from = idxFrom(tMs);
    const path = hourly.slice(from, from + 7 * 24 + 2);
    if (!path.length) continue;

    const fp = computeFirstPassage(path, a.close, a.atrPct, tMs, 7 * 24 * HOUR_MS);
    if (!fp) continue;
    const row = { path_first_passage: fp };

    for (const [hLabel, hH] of HORIZONS) {
      // Cobertura: sin recorrido completo, "no ofreció" sería indistinguible de "no se
      // pudo ver". Se excluye el ancla de ESE horizonte en vez de contarla como negativa.
      if (lastHourly < tMs + hH * HOUR_MS) continue;
      const r = results[hLabel];
      r.n++;
      for (const tk of TARGETS) {
        for (const ak of ADVERSES) {
          const op = classifyOpportunity(row, { horizonH: hH, targetK: tk, adverseK: ak, now: null });
          if (op.offered) r.grid[`${tk}|${ak}`]++;
        }
      }
      const cal = opportunityParamsFor(hH);
      const def = classifyOpportunity(row, {
        horizonH: hH, targetK: cal.targetK, adverseK: cal.adverseK, now: null,
      });
      if (def.offered) r.hoursTo.push(def.hours_to);
      const win = path.filter((c) => c.t <= tMs + hH * HOUR_MS);
      if (win.length && a.atrPct > 0) {
        const up = Math.max(...win.map((c) => c.high)), dn = Math.min(...win.map((c) => c.low));
        const exc = Math.max(Math.abs(up - a.close), Math.abs(a.close - dn)) / a.close * 100;
        r.excursions.push(exc / a.atrPct);
      }
    }
  }
  return results;
}

async function auditCoin(coin) {
  const tfMs = TF_MS[TF];
  const sinceMs = Date.now() - (DAYS + 10) * 24 * HOUR_MS; // margen para el ATR inicial
  const tfCandles = await fetchKlines(coin, BINANCE_TF[TF], sinceMs);
  const hourly = await fetchKlines(coin, '1h', sinceMs);
  if (tfCandles.length < ATR_PERIOD + 5 || !hourly.length) return null;

  // Ancla = cada vela del TF primario con ATR reconstruible con velas ya cerradas.
  const anchors = [];
  for (let i = ATR_PERIOD + 1; i < tfCandles.length; i++) {
    const prev = tfCandles.slice(Math.max(0, i - ATR_PERIOD - 5), i + 1);
    const atr = calculateATR(prev, ATR_PERIOD);
    const c = tfCandles[i];
    if (!Number.isFinite(atr) || !c.close) continue;
    anchors.push({ ...c, atrPct: (atr / c.close) * 100 });
  }
  return { anchors, results: measure(anchors, hourly, tfMs) };
}

// ── reporte ──────────────────────────────────────────────────────────────────

const fmtPct = (n, total) => total === 0 ? '  —  ' : `${(n / total * 100).toFixed(1).padStart(5)}%`;

/** Una celda al 5 % o menos / al 95 % o más no separa nada: es una constante disfrazada. */
function cellFlag(rate) {
  if (rate == null) return ' ';
  if (rate <= 5) return '▼';   // casi nunca ofrece → la métrica no vería una mala espera
  if (rate >= 95) return '▲';  // casi siempre ofrece → toda espera parecería un error
  return ' ';
}

function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function reportCoin(coin, data) {
  console.log(`\n${'═'.repeat(78)}\n${coin} · TF ${TF} · ${data.anchors.length} anclas`);

  for (const [hLabel, hH] of HORIZONS) {
    const r = data.results[hLabel];
    if (!r.n) { console.log(`  ${hLabel}: sin anclas con recorrido completo`); continue; }

    console.log(`\n  ── Horizonte ${hLabel} · n=${r.n} anclas con recorrido completo ──`);
    console.log('  TASA BASE INCONDICIONAL: % de instantes CUALESQUIERA que ofrecieron movimiento limpio.');
    console.log(`    ${'target\\adverse'.padEnd(15)}${ADVERSES.map((a) => `${a}×`.padStart(8)).join('')}`);
    for (const tk of TARGETS) {
      const cells = ADVERSES.map((ak) => {
        const hits = r.grid[`${tk}|${ak}`];
        const rate = (hits / r.n) * 100;
        return `${fmtPct(hits, r.n)}${cellFlag(rate)}`.padStart(8);
      });
      const mark = tk === opportunityParamsFor(hH).targetK ? ' ←' : '';
      console.log(`    ${`${tk}× ATR`.padEnd(15)}${cells.join('')}${mark}`);
    }

    const cal = opportunityParamsFor(hH);
    const def = r.grid[`${cal.targetK}|${cal.adverseK}`];
    const defRate = (def / r.n) * 100;
    console.log(`    Par calibrado (${cal.targetK}×/${cal.adverseK}×): `
      + `${defRate.toFixed(1)}% · mediana hasta objetivo ${median(r.hoursTo)?.toFixed(1) ?? '—'} h`
      + ` · excursión media ${(r.excursions.reduce((a, b) => a + b, 0) / (r.excursions.length || 1)).toFixed(2)}×ATR`);
    console.log(`    → Un \`Esperar\` de CRYPTEX solo informa si su offered_pct se APARTA de ${defRate.toFixed(1)}%.`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log('AUDITORÍA DE LA MÉTRICA DE OPORTUNIDAD (Fase 5) — degeneración + tasa base');
console.log(`Funciones importadas del backend. TF ${TF} · ${DAYS} días · rejilla ${ATR_MULTIPLES.join('/')}`);
console.log(`Pares calibrados: 24h ${opportunityParamsFor(24).targetK}×/${opportunityParamsFor(24).adverseK}× · `
  + `7d ${opportunityParamsFor(168).targetK}×/${opportunityParamsFor(168).adverseK}× ATR`);

for (const coin of COINS) {
  try {
    const data = await auditCoin(coin);
    if (data) reportCoin(coin, data);
    else console.log(`\n${coin}: histórico insuficiente`);
  } catch (e) {
    console.log(`\n${coin}: ERROR ${e.message}`);
  }
}

console.log('\nLeyenda: ▼ ≤5% (la métrica nunca vería una espera mala) · ▲ ≥95% (toda espera parecería error).');
console.log('         La tasa base es la referencia de opportunity_cost: sin ella, el % absoluto no dice nada.');
console.log('         El criterio se fija sobre historia de mercado, NUNCA ajustándolo a los outcomes de CRYPTEX.');
