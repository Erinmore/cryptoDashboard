/**
 * auditOrderlyDecline.mjs — ¿debe poder venderse una caída ordenada?
 *
 * EL PROBLEMA, PLANTEADO CON PRECISIÓN. `Vender` exige `derivatives <= −1` Y `volume <= −1`
 * ([analysisValidator.js:127](../src/services/analysisValidator.js#L127)), y el derivatives
 * del backend es autoritativo. Pero **toda la fila inferior del cuadro OI×precio vale cero**
 * ([derivativesScore.js:172-177](../src/utils/derivativesScore.js#L172-L177)): `new_money_short`
 * (precio↓ con OI↑) y `deleveraging` (precio↓ con OI↓) no puntúan. O sea que en la caída
 * ordinaria —lo más común que hace un mercado bajista— el score de la cima de la jerarquía
 * es MUDO, y su mudez bloquea la venta.
 *
 * LO QUE YA SE MIDIÓ Y NO HAY QUE VOLVER A PREGUNTAR. `OI↑px↓` se descartó porque su efecto
 * aparente DESAPARECE al controlar por momentum (+3,7/+4,7/−3,4 de lift: ruido). Eso está
 * bien medido y devolver la celda a la rúbrica sería meter momentum de precio en un score
 * que está POR ENCIMA de Structure — doble conteo. **Esta pregunta es otra.**
 *
 * LA PREGUNTA NUEVA, que es CONDICIONAL. El 0 de esa celda significa "he mirado y no añado
 * nada sobre lo que ya dice el precio". El gate lo lee como "no hay evidencia bajista, no
 * vendas" — convierte ausencia de evidencia en evidencia de ausencia, y con rango de veto.
 * Así que lo que hay que medir es:
 *
 *   En las anclas con celda `new_money_short`, ¿continúa la caída cuando ADEMÁS la
 *   estructura y el volumen son bajistas — por encima de lo que ya predice el momentum?
 *
 * ANCLAS, fijadas ANTES de ejecutar:
 *
 *  A1 · CONTROL DE MOMENTUM OBLIGATORIO. La comparación NUNCA es contra la base global sino
 *       contra **la base del grupo "precio pasado ↓"**. Sin eso se le acredita al derivatives
 *       lo que ya dice el precio, que es exactamente el error que la rúbrica evitó.
 *
 *  A2 · CONTROL DE ATRIBUCIÓN (el que decide dónde está el arreglo, si lo hay). Se mide el
 *       lift de estructura+volumen **con la celda fijada** Y el de la celda **con
 *       estructura+volumen fijados**. Si el lift viene de estructura+volumen y es el MISMO
 *       en `new_money_short` que en `deleveraging`, entonces el derivatives no aporta y lo
 *       que sobra es el GATE, no la rúbrica. Si el lift solo aparece en una celda concreta,
 *       la información sí está en el OI y sería la rúbrica la que se queda corta.
 *
 *  A3 · CONTROL SIMÉTRICO ALCISTA. Lo mismo en `new_money_long` (que sí puntúa +1). Si
 *       condicionar por estructura+volumen añade lo mismo en los dos lados, es señal de que
 *       el aporte es de estructura/volumen y no del cuadro de OI. Sin este control, un lift
 *       bajista se leería como "hallazgo bajista" cuando podría ser "estructura funciona".
 *
 *  A4 · UMBRAL DE DECISIÓN, declarado antes: un lift < 5 pt sobre la base del grupo es ruido
 *       (es el criterio con el que se descartó `OI↑px↓`). Se exige además n >= 30 y que el
 *       IC de Wilson no cruce la base del grupo. Y que **replique en las 3 monedas**: un
 *       efecto en una sola es lo que ya nos enseñó la cascada de shorts a descartar.
 *
 * PROXIES DETERMINISTAS. `structure` y `volume` son scores del LLM y no existen en histórico,
 * así que se usan los deterministas que el propio sistema calcula: `computeTrend` (estructura,
 * verificado simétrico al 100 % bajo reflexión el 2026-08-01) y `expectedVolumeScore` (la
 * guardia C2, el mismo proxy que usó `auditGateConjunction`). Ambos son CONSERVADORES respecto
 * al LLM y se declara como limitación, no se disimula.
 *
 * SOLO LECTURA. No abre la BBDD ni toca producción. Requiere COINALYZE_API_KEY del .env raíz.
 *
 * Uso: node scripts/auditOrderlyDecline.mjs   ·   DAYS=90 node scripts/auditOrderlyDecline.mjs
 */

import { readFileSync } from 'node:fs';
import { calculateATRSeries, calculateCVD } from '../src/utils/indicators.js';
import { computeTrend } from '../src/services/indicatorService.js';
import { expectedVolumeScore } from '../src/utils/expectedScores.js';
import { oiPriceCell } from '../src/utils/derivativesScore.js';
import { wilsonInterval } from '../src/utils/stats.js';
import {
  calculateRSI, calculateMACD, calculateADX, calculateSuperTrend,
  calculateWaveTrend, calculateStochRSI, calculateVolumeDelta,
} from '../src/utils/indicators.js';

const envRaw = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const API_KEY = envRaw.match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) { console.error('Falta COINALYZE_API_KEY en el .env de la raíz.'); process.exit(1); }

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const DAYS = Number(process.env.DAYS ?? 90);
const LOOKBACK_4H = 6;            // 24h en velas de 4h
const SQRT_WINDOW = Math.sqrt(LOOKBACK_4H);
const FWD_BAND = 0.5;             // continuación = |Δ futuro| > 0,5× la escala de 24h
const PX_BAND = 0.5;              // "precio pasado ↓" para el control de momentum
const TREND_WIN = 180;            // ventana de producción del TF 4h

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
  if (!r.ok) throw new Error(`Binance ${coin}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: Math.floor(x[0] / 1000), open: +x[1], high: +x[2], low: +x[3], close: +x[4],
    volume: +x[5], taker_buy_base: +x[9],
  }));
}

/** Estructura determinista: la MISMA etiqueta que el sistema envía como `technical[tf].trend`. */
function trendAt(candles) {
  const closes = candles.map((c) => c.close);
  return computeTrend({
    rsi: { value: calculateRSI(closes) },
    macd: calculateMACD(closes),
    adx: calculateADX(candles),
    superTrend: calculateSuperTrend(candles),
    waveTrend: calculateWaveTrend(candles),
    stochRsi: calculateStochRSI(closes),
    volumeDelta: calculateVolumeDelta(candles),
  });
}

const BEAR = new Set(['bearish', 'strongly_bearish']);
const BULL = new Set(['bullish', 'strongly_bullish']);

async function build(coin) {
  const [k4h, oiHist] = await Promise.all([
    klines(coin, '4h', 1000),
    coinalyze(coin, 'open-interest-history', '4hour'),
  ]);
  if (!oiHist.length) return [];

  const atrByIdx = new Map((calculateATRSeries(k4h, 14) ?? []).map((e) => [e.idx, e.atr]));
  const idxByT = new Map(k4h.map((c, i) => [c.t, i]));
  const closeByT = new Map(k4h.map((c) => [c.t, c.close]));
  const atrPctByT = new Map();
  k4h.forEach((c, i) => {
    const atr = atrByIdx.get(i);
    if (Number.isFinite(atr) && c.close > 0) atrPctByT.set(c.t, (atr / c.close) * 100);
  });

  const rows = [];
  for (let i = LOOKBACK_4H; i < oiHist.length; i++) {
    const t = oiHist[i].t;
    const oiPrev = oiHist[i - LOOKBACK_4H].c, oiNow = oiHist[i].c;
    const pxNow = closeByT.get(t);
    const pxPrev = closeByT.get(oiHist[i - LOOKBACK_4H].t);
    const atrPct = atrPctByT.get(t);
    const idx = idxByT.get(t);
    if (!(oiPrev > 0) || !Number.isFinite(pxNow) || !Number.isFinite(pxPrev)
        || !Number.isFinite(atrPct) || atrPct <= 0 || idx == null || idx < TREND_WIN) continue;

    const oiChange = ((oiNow - oiPrev) / oiPrev) * 100;
    const pxChange = ((pxNow - pxPrev) / pxPrev) * 100;
    const pxAtr = pxChange / (atrPct * SQRT_WINDOW);

    // Futuro 24h, misma normalización. Sin lookahead: la celda usa las 24h PASADAS.
    const fwdT = t + LOOKBACK_4H * 4 * 3600;
    const pxFwd = closeByT.get(fwdT);
    if (!Number.isFinite(pxFwd)) continue;
    const fwdAtr = ((pxFwd - pxNow) / pxNow) * 100 / (atrPct * SQRT_WINDOW);

    // Celda con la función REAL de producción.
    const { cell } = oiPriceCell({
      oiChange24hPct: oiChange, priceChange24hPct: pxChange, atrPct, primaryTf: '4h',
    });

    const win = k4h.slice(idx - TREND_WIN + 1, idx + 1);
    const trend = trendAt(win);
    const vol = expectedVolumeScore(calculateCVD(win)).score;

    rows.push({ coin, cell, pxAtr, fwdAtr, trend, vol });
  }
  return rows;
}

// ── medición ─────────────────────────────────────────────────────────────────

const all = [];
for (const coin of COINS) {
  try { all.push(...await build(coin)); } catch (e) { console.log(`${coin}: ${e.message}`); }
}

const pct = (n, t) => (t === 0 ? '  —  ' : `${((n / t) * 100).toFixed(1).padStart(5)}%`);
const dnRate = (a) => a.filter((r) => r.fwdAtr < -FWD_BAND).length / (a.length || 1) * 100;
const upRate = (a) => a.filter((r) => r.fwdAtr > FWD_BAND).length / (a.length || 1) * 100;
const sig = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1).padStart(5)}`;

console.log('¿DEBE PODER VENDERSE UNA CAÍDA ORDENADA? — medición condicional');
console.log(`${DAYS} d · ${COINS.join('+')} · n=${all.length} anclas 4h · continuación = |Δ24h futuro| > ${FWD_BAND}×`);
console.log('Proxies deterministas: estructura = `computeTrend`, volumen = `expectedVolumeScore` (C2).');
console.log('ANCLAS: lift < 5 pt = ruido · n >= 30 · IC de Wilson que no cruce la base · replicar en 3 monedas\n');

// Grupo de momentum: SOLO anclas donde el precio YA venía cayendo. Es la base honesta.
const down = all.filter((r) => r.pxAtr < -PX_BAND);
const baseDn = dnRate(down);
console.log(`${'═'.repeat(92)}`);
console.log(`BASE DEL GRUPO «precio pasado ↓»  n=${down.length}  →  sigue bajando ${baseDn.toFixed(1)}%`
  + `  · sube ${upRate(down).toFixed(1)}%`);
console.log('Todo lo de abajo se compara CONTRA ESTA CIFRA, nunca contra la base global.\n');

function line(label, sel, base) {
  if (!sel.length) return;
  const dn = sel.filter((r) => r.fwdAtr < -FWD_BAND).length;
  const ci = wilsonInterval(dn, sel.length);
  const lift = (dn / sel.length) * 100 - base;
  const flag = sel.length < 30 ? ' n<30'
    : (ci.low > base ? ' ✅ IC por encima de la base' : ci.high < base ? ' ⚠️ IC por debajo' : ' ✗ IC cruza la base');
  console.log(`  ${label.padEnd(46)} n=${String(sel.length).padStart(4)}`
    + `  baja ${pct(dn, sel.length)}  lift ${sig(lift)}  IC[${ci.low}-${ci.high}]${flag}`);
}

console.log('1 · A2 — ¿aporta ESTRUCTURA+VOLUMEN dentro de la celda `new_money_short`?');
const nms = down.filter((r) => r.cell === 'new_money_short');
line('new_money_short (toda)', nms, baseDn);
line('  + estructura bajista', nms.filter((r) => BEAR.has(r.trend)), baseDn);
line('  + estructura bajista Y volumen <= -1', nms.filter((r) => BEAR.has(r.trend) && r.vol <= -1), baseDn);

console.log('\n2 · A2 — el MISMO condicionamiento en la otra celda muda (`deleveraging`)');
console.log('    Si da el mismo lift, la información es de estructura+volumen y NO del OI →');
console.log('    entonces lo que sobra es el GATE, no la rúbrica.');
const dlv = down.filter((r) => r.cell === 'deleveraging');
line('deleveraging (toda)', dlv, baseDn);
line('  + estructura bajista', dlv.filter((r) => BEAR.has(r.trend)), baseDn);
line('  + estructura bajista Y volumen <= -1', dlv.filter((r) => BEAR.has(r.trend) && r.vol <= -1), baseDn);

console.log('\n3 · Referencia: el mismo condicionamiento SIN mirar el OI (todo «precio pasado ↓»)');
line('estructura bajista', down.filter((r) => BEAR.has(r.trend)), baseDn);
line('estructura bajista Y volumen <= -1', down.filter((r) => BEAR.has(r.trend) && r.vol <= -1), baseDn);

console.log('\n4 · A3 — CONTROL SIMÉTRICO ALCISTA (grupo «precio pasado ↑», celda que SÍ puntúa)');
const up = all.filter((r) => r.pxAtr > PX_BAND);
const baseUp = upRate(up);
console.log(`  BASE DEL GRUPO «precio pasado ↑»  n=${up.length}  →  sigue subiendo ${baseUp.toFixed(1)}%`);
const lineUp = (label, sel) => {
  if (!sel.length) return;
  const u = sel.filter((r) => r.fwdAtr > FWD_BAND).length;
  const ci = wilsonInterval(u, sel.length);
  console.log(`  ${label.padEnd(46)} n=${String(sel.length).padStart(4)}`
    + `  sube ${pct(u, sel.length)}  lift ${sig((u / sel.length) * 100 - baseUp)}  IC[${ci.low}-${ci.high}]`
    + (sel.length < 30 ? ' n<30' : ''));
};
lineUp('new_money_long (toda)', up.filter((r) => r.cell === 'new_money_long'));
lineUp('  + estructura alcista Y volumen >= +1',
  up.filter((r) => r.cell === 'new_money_long' && BULL.has(r.trend) && r.vol >= 1));
lineUp('estructura alcista Y volumen >= +1 (sin mirar OI)',
  up.filter((r) => BULL.has(r.trend) && r.vol >= 1));

console.log('\n5 · A4 — ¿REPLICA POR MONEDA?');
console.log('  BAJISTA — `new_money_short` + estructura + volumen:');
for (const c of COINS) {
  const g = all.filter((r) => r.coin === c && r.pxAtr < -PX_BAND);
  if (!g.length) continue;
  const b = dnRate(g);
  const sel = g.filter((r) => r.cell === 'new_money_short' && BEAR.has(r.trend) && r.vol <= -1);
  console.log(`    ${c.padEnd(5)} base ${b.toFixed(1)}%  →  condicionada n=${String(sel.length).padStart(3)}`
    + `  baja ${sel.length ? dnRate(sel).toFixed(1) : '—'}%  lift ${sel.length ? sig(dnRate(sel) - b) : '—'}`);
}
// El control alcista dio señal, así que se le aplica el MISMO listón de replicación: un
// efecto que solo aparece en una moneda es lo que la cascada de shorts enseñó a descartar.
console.log('  ALCISTA — `new_money_long` + estructura + volumen (el que SÍ dio lift):');
for (const c of COINS) {
  const g = all.filter((r) => r.coin === c && r.pxAtr > PX_BAND);
  if (!g.length) continue;
  const b = upRate(g);
  const sel = g.filter((r) => r.cell === 'new_money_long' && BULL.has(r.trend) && r.vol >= 1);
  const cellOnly = g.filter((r) => r.cell === 'new_money_long');
  console.log(`    ${c.padEnd(5)} base ${b.toFixed(1)}%  →  celda sola n=${String(cellOnly.length).padStart(3)}`
    + ` lift ${cellOnly.length ? sig(upRate(cellOnly) - b) : '  —  '}`
    + `  ·  condicionada n=${String(sel.length).padStart(3)}`
    + ` lift ${sel.length ? sig(upRate(sel) - b) : '  —  '}`);
}
