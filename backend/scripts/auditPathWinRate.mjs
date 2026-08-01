/**
 * auditPathWinRate.mjs — ¿es plausible el win-rate PATH-AWARE?
 *
 * `classifyPathOutcome` es el win-rate que el checkpoint va a leer, y NUNCA se ha probado
 * contra datos masivos. Lo que sí se probó (2026-08-01, 50,6/49,4 %) fue `classifyOutcome`,
 * que es OTRA función: aquella compara precio inicial contra precio al horizonte, así que
 * invertir la dirección es un cambio de signo y el ancla de 50/50 es trivialmente correcta.
 * Ésta mira el CAMINO con dos barreras ASIMÉTRICAS (2×ATR a favor, 1×ATR en contra), y por
 * eso **el ancla de 50 % NO aplica**. Las anclas correctas, fijadas ANTES de ejecutar:
 *
 *  A1 · IDENTIDAD CON LA OPORTUNIDAD (descomposición, ancla exacta — vale 0 o falla).
 *       Con los mismos múltiplos, `classifyOpportunity(row).offered` con `direction='up'`
 *       es la MISMA condición booleana que `classifyPathOutcome('Comprar')==='win'`.
 *       Además a lo sumo una de las dos direcciones puede ser limpia: si el objetivo al
 *       alza (2×) llega antes que el adverso a la baja (1×), entonces t_up(1) <= t_up(2) <
 *       t_down(1) <= t_down(2), que contradice la condición simétrica. Por tanto:
 *         wins(Comprar) + wins(Vender)  ==  nº de anclas con `offered=true`
 *       exactamente, ancla por ancla. Un descuadre es un bug en una de las dos.
 *
 *  A2 · RUINA DEL JUGADOR (valor teórico). Para un paseo sin deriva con barreras +2 y −1
 *       la probabilidad de tocar la de arriba primero es 1/(1+2) = **33,3 %** (martingala,
 *       parada opcional). Con horizonte finito el sesgo es hacia la barrera CERCANA —el
 *       stop— porque resolverse a 2× exige más tiempo, así que el valor esperado es
 *       **≤ 33,3 %**. Para el par de 7d (4×/1×) el equivalente es 1/5 = **20 %**.
 *       No es una predicción exacta (cripto no es un browniano: colas gordas y
 *       agrupamiento de volatilidad), pero sí fija el orden de magnitud: un 50 % sería
 *       un bug de denominador y un 10 % un problema de censura.
 *
 *  A3 · SIMETRÍA (b). Sin deriva, win-rate(Comprar) == win-rate(Vender) sobre los MISMOS
 *       anclajes. La diferencia mide deriva del periodo + asimetría de forma de las
 *       caídas cripto; es la misma magnitud que dio 38,7/61,3 en `classifyOpportunity`.
 *       El win-rate con dirección al azar es exactamente la MEZCLA de ambas, así que se
 *       reporta agregando las dos y no con un RNG: sortear añadiría ruido de muestreo a
 *       un número que se puede calcular exacto.
 *
 *  A4 · CONTRA-PERIODO (d). `OFFSET_DAYS` repite todo en una ventana anterior. Si las
 *       tres monedas y los dos periodos caen en la misma banda, la cifra es propiedad del
 *       recorrido normalizado por ATR y no del régimen.
 *
 * DE PROPINA — pendiente nº3 de la lista: **frecuencia del empate**. Los cruces se
 * reportan con resolución de vela de 1h, así que "objetivo y stop en la misma hora" es un
 * empate real cuyo orden interno no es resoluble; el convenio es "adverso primero"
 * ([stats.js:336](../src/utils/stats.js#L336)). Si esa fracción fuera alta, el convenio
 * estaría decidiendo resultados en silencio. Se cuenta aquí porque sale del mismo barrido.
 *
 * SOLO LECTURA: no abre la BBDD, no toca producción, no requiere API keys (Binance
 * público). Importa las funciones REALES del backend — no reimplementa ninguna regla.
 *
 * Uso:
 *   node scripts/auditPathWinRate.mjs
 *   COINS=SOL TF=4h DAYS=90 OFFSET_DAYS=270 node scripts/auditPathWinRate.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { computeFirstPassage } from '../src/utils/pathMetrics.js';
import { classifyOpportunity, classifyPathOutcome, opportunityParamsFor, wilsonInterval } from '../src/utils/stats.js';

const HOUR_MS = 3600 * 1000;
const TF_MS = { '1h': HOUR_MS, '4h': 4 * HOUR_MS, '1D': 24 * HOUR_MS };
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d' };

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const TF = process.env.TF ?? '4h';
const DAYS = Number(process.env.DAYS ?? 90);
const OFFSET_DAYS = Number(process.env.OFFSET_DAYS ?? 0);   // contra-periodo (A4)
const ATR_PERIOD = 14;
const HORIZONS = [['24h', 24], ['7d', 168]];
// Pares del control de empate, de barreras muy juntas a muy separadas. La rejilla
// persistida (`ATR_MULTIPLES`) solo contiene 0.5/1/1.5/2/3/4, así que el par más estrecho
// medible es 0.5×/0.5× — un empate ahí exige 1×ATR de rango en una hora, que sí ocurre.
const TIE_CONTROL = [[0.5, 0.5], [1, 0.5], [1, 1], [1.5, 1], [2, 1], [3, 1]];

async function fetchKlines(symbol, interval, startMs, endMs) {
  const out = [];
  let start = startMs;
  for (let guard = 0; guard < 25; guard++) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT`
      + `&interval=${interval}&startTime=${start}&endTime=${endMs}&limit=1000`;
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

function blank() {
  return {
    n: 0,
    up: { win: 0, loss: 0, flat: 0 },
    down: { win: 0, loss: 0, flat: 0 },
    offered: 0,                 // A1: debe igualar up.win + down.win
    ties: 0,                    // objetivo y stop en la MISMA vela de 1h
    tiesResolvedBoth: 0,        // anclas donde ambas barreras se tocaron (denominador del empate)
    // CONTROL DE RAMA MUERTA: un empate en el par calibrado exige que UNA vela de 1h cubra
    // target+adverse (3×ATR en 24h). Si sale 0, hay que demostrar que el contador PUEDE
    // dispararse — si no, un 0 por bug y un 0 por rareza son indistinguibles (fallo T1).
    tieGrid: {},                // "tk|ak" → { both, tie }
    driftPct: [],               // deriva realizada del propio horizonte (contexto de A3)
  };
}

function measure(anchors, hourly, tfMs) {
  const byTime = hourly.map((c) => c.t);
  const idxFrom = (t) => {
    let lo = 0, hi = byTime.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (byTime[m] < t) lo = m + 1; else hi = m; }
    return lo;
  };
  const lastHourly = hourly.length ? hourly[hourly.length - 1].t : 0;

  const res = {};
  for (const [hLabel] of HORIZONS) res[hLabel] = blank();

  for (const a of anchors) {
    const tMs = a.t + tfMs;                       // el análisis ocurre al CIERRE de la vela
    const from = idxFrom(tMs);
    const path = hourly.slice(from, from + 7 * 24 + 2);
    if (!path.length) continue;

    const fp = computeFirstPassage(path, a.close, a.atrPct, tMs, 7 * 24 * HOUR_MS);
    if (!fp) continue;
    const row = { path_first_passage: fp };

    for (const [hLabel, hH] of HORIZONS) {
      if (lastHourly < tMs + hH * HOUR_MS) continue;   // sin recorrido completo → fuera
      const r = res[hLabel];
      r.n++;

      const cUp = classifyPathOutcome('Comprar', row, { horizonH: hH });
      const cDn = classifyPathOutcome('Vender', row, { horizonH: hH });
      if (cUp) r.up[cUp]++;
      if (cDn) r.down[cDn]++;

      const op = classifyOpportunity(row, { horizonH: hH });
      if (op.offered) r.offered++;

      // Empate: ambas barreras cruzadas en la misma hora reportada. Se mira en las dos
      // direcciones porque el convenio actúa en las dos.
      const { targetK, adverseK } = opportunityParamsFor(hH);
      const at = (side, k) => {
        const h = fp[side]?.[String(k)];
        return Number.isFinite(h) && h <= hH ? h : null;
      };
      for (const [dir, opp] of [['up', 'down'], ['down', 'up']]) {
        const tT = at(dir, targetK), tS = at(opp, adverseK);
        if (tT != null && tS != null) {
          r.tiesResolvedBoth++;
          if (tT === tS) r.ties++;
        }
      }

      for (const [tk, ak] of TIE_CONTROL) {
        const key = `${tk}|${ak}`;
        r.tieGrid[key] ??= { both: 0, tie: 0 };
        for (const [dir, opp] of [['up', 'down'], ['down', 'up']]) {
          const tT = at(dir, tk), tS = at(opp, ak);
          if (tT != null && tS != null) {
            r.tieGrid[key].both++;
            if (tT === tS) r.tieGrid[key].tie++;
          }
        }
      }

      const end = path.filter((c) => c.t <= tMs + hH * HOUR_MS).at(-1);
      if (end) r.driftPct.push((end.close - a.close) / a.close * 100);
    }
  }
  return res;
}

async function auditCoin(coin) {
  const tfMs = TF_MS[TF];
  const endMs = Date.now() - OFFSET_DAYS * 24 * HOUR_MS;
  const startMs = endMs - (DAYS + 10) * 24 * HOUR_MS;      // margen para el ATR inicial
  const tfCandles = await fetchKlines(coin, BINANCE_TF[TF], startMs, endMs);
  const hourly = await fetchKlines(coin, '1h', startMs, endMs);
  if (tfCandles.length < ATR_PERIOD + 5 || !hourly.length) return null;

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

const pct = (x, n) => (n ? `${(x / n * 100).toFixed(1)}%` : '—');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const totals = {};
for (const [hLabel] of HORIZONS) totals[hLabel] = blank();

console.log('AUDITORÍA DEL WIN-RATE PATH-AWARE (`classifyPathOutcome`)');
console.log(`TF ${TF} · ${DAYS} días · offset ${OFFSET_DAYS} d · funciones reales del backend`);
console.log('ANCLAS DECLARADAS ANTES DE EJECUTAR:');
console.log('  A1 wins(Comprar)+wins(Vender) == anclas con oportunidad ofrecida  → EXACTO');
console.log(`  A2 ruina del jugador: 24h (2×/1×) ≤ 33,3 %  ·  7d (4×/1×) ≈ 20 %`);
console.log('  A3 win-rate(Comprar) ≈ win-rate(Vender) salvo deriva del periodo');
console.log('  A4 el contra-periodo (OFFSET_DAYS) debe caer en la misma banda\n');

for (const coin of COINS) {
  let data;
  try { data = await auditCoin(coin); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (!data) { console.log(`${coin}: sin datos`); continue; }

  console.log(`${'═'.repeat(78)}\n${coin} · ${data.anchors.length} anclas`);
  for (const [hLabel, hH] of HORIZONS) {
    const r = data.results[hLabel];
    if (!r.n) { console.log(`  ${hLabel}: sin recorrido completo`); continue; }
    const T = totals[hLabel];
    T.n += r.n; T.offered += r.offered; T.ties += r.ties; T.tiesResolvedBoth += r.tiesResolvedBoth;
    for (const d of ['up', 'down']) for (const k of ['win', 'loss', 'flat']) T[d][k] += r[d][k];
    T.driftPct.push(...r.driftPct);
    for (const [k, v] of Object.entries(r.tieGrid)) {
      T.tieGrid[k] ??= { both: 0, tie: 0 };
      T.tieGrid[k].both += v.both; T.tieGrid[k].tie += v.tie;
    }

    const cal = opportunityParamsFor(hH);
    const dU = r.up.win + r.up.loss, dD = r.down.win + r.down.loss;
    const pool = wilsonInterval(r.up.win + r.down.win, dU + dD);
    const a1 = r.up.win + r.down.win;
    console.log(`\n  ── ${hLabel} (${cal.targetK}×/${cal.adverseK}×) · n=${r.n} anclas ──`);
    console.log(`    Comprar: win ${r.up.win} / loss ${r.up.loss} / flat ${r.up.flat}`
      + `   → win-rate ${pct(r.up.win, dU)} (n=${dU})`);
    console.log(`    Vender : win ${r.down.win} / loss ${r.down.loss} / flat ${r.down.flat}`
      + `   → win-rate ${pct(r.down.win, dD)} (n=${dD})`);
    console.log(`    DIRECCIÓN AL AZAR (mezcla exacta): ${pool.point}% `
      + `[${pool.low}–${pool.high}] n=${pool.n}   ← A2: esperado ≤ ${(100 / (1 + cal.targetK / cal.adverseK)).toFixed(1)}%`);
    console.log(`    A1 identidad: wins(C)+wins(V)=${a1} vs offered=${r.offered}  `
      + `${a1 === r.offered ? '✅ EXACTO' : `❌ DESCUADRE de ${a1 - r.offered}`}`);
    console.log(`    A3 asimetría C−V: ${(r.up.win / (dU || 1) * 100 - r.down.win / (dD || 1) * 100).toFixed(1)} pt`
      + ` · deriva media del horizonte ${mean(r.driftPct)?.toFixed(2)}%`);
    console.log(`    Empate misma vela 1h: ${r.ties}/${r.tiesResolvedBoth} `
      + `(${pct(r.ties, r.tiesResolvedBoth)} de los casos con AMBAS barreras tocadas`
      + ` · ${pct(r.ties, r.n * 2)} de todas las evaluaciones)`);
  }
  console.log();
}

console.log(`${'═'.repeat(78)}\nAGREGADO (${COINS.join('+')})`);
for (const [hLabel, hH] of HORIZONS) {
  const T = totals[hLabel];
  if (!T.n) continue;
  const cal = opportunityParamsFor(hH);
  const dU = T.up.win + T.up.loss, dD = T.down.win + T.down.loss;
  const pool = wilsonInterval(T.up.win + T.down.win, dU + dD);
  const a1 = T.up.win + T.down.win;
  console.log(`  ${hLabel} (${cal.targetK}×/${cal.adverseK}×) n=${T.n}: `
    + `Comprar ${pct(T.up.win, dU)} · Vender ${pct(T.down.win, dD)} · `
    + `AZAR ${pool.point}% [${pool.low}–${pool.high}]  (teórico ≤ ${(100 / (1 + cal.targetK / cal.adverseK)).toFixed(1)}%)`);
  console.log('     control de empate (target|adverse → empates / dobles cruces):');
  console.log('       ' + TIE_CONTROL.map(([tk, ak]) => {
    const g = T.tieGrid[`${tk}|${ak}`] ?? { both: 0, tie: 0 };
    return `${tk}|${ak}: ${g.tie}/${g.both} (${pct(g.tie, g.both)})`;
  }).join('  '));
  console.log(`     flat: C ${pct(T.up.flat, T.n)} · V ${pct(T.down.flat, T.n)}`
    + ` · A1 ${a1 === T.offered ? '✅' : `❌ ${a1} vs ${T.offered}`}`
    + ` · empates ${pct(T.ties, T.tiesResolvedBoth)} de los dobles cruces`
    + ` · deriva media ${mean(T.driftPct)?.toFixed(2)}%`);
}
