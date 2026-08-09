#!/usr/bin/env node
/**
 * auditAdxRegimeFilterSignal.mjs — B7 (SESSION_STATE.md §10.1): ¿el RÉGIMEN de mercado
 * (`technical[tf].regime`, de `detectMarketRegime` — terciles de ADX calibrados en T2, no los
 * cortes fijos 25/20) cambia la fiabilidad del trend-following, o la magnitud del movimiento,
 * en las 24h siguientes? Nunca se ha medido como FILTRO.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * DISEÑO — misma estructura de dos hipótesis que B6 (`auditHtfConflictSignal.mjs`)
 *
 *  H1 (¿el régimen filtra la fiabilidad del trend-following?) · en anclas donde `computeTrend`
 *     da una dirección clara (bull/bear), ¿acierta más la continuación a 24h cuando el
 *     régimen es `trending` que cuando es `ranging`? Comparación DIRECTA entre los dos grupos
 *     (no contra una base de mercado global).
 *
 *  H2 (¿el régimen predice la MAGNITUD del movimiento?) · tasa de "movimiento grande"
 *     (|fwdAtr|>0.5) en `trending` vs `ranging` — más una confirmación de que el régimen mide
 *     lo que dice medir que una hipótesis nueva (ADX por definición captura fuerza
 *     direccional), pero nunca verificada con el régimen YA CALIBRADO (T2) sobre klines años.
 *
 * Se usa `detectMarketRegime` (función real, calibrada T2 — terciles de la propia serie de
 * ADX con el corte de Wilder como suelo absoluto) y `computeTrend` (servicio real) — sin
 * reimplementar ninguna lógica de umbral.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * PREDICCIONES FIJADAS ANTES DE EJECUTAR
 *
 *  P1 · H1: el acierto de "dirección de computeTrend → movimiento 24h" es MAYOR en
 *       `trending` que en `ranging` (IC separados, trending por encima).
 *  P2 · H2: la tasa de movimiento grande es MAYOR en `trending` que en `ranging`.
 *  P3 · Debe replicar en las 3 monedas con n_ef>=30 por grupo.
 *
 * CONTROL DE CÓDIGO: mismo argumento que B6, extendido, con UN matiz encontrado al ejecutar.
 * ADX/DI+/DI− dependen de `|high-low|`/`|high-prevClose|`/`|low-prevClose|` (invariantes bajo
 * la reflexión, ver cabecera de `auditHtfConflictSignal.mjs`) y de `Math.abs(plusDI-minusDI)`
 * (magnitud) — la parte `trending`/`ranging`/`weak_trend` de `detectMarketRegime` debe ser
 * IDÉNTICA bajo reflexión. ⚠️ Pero `detectMarketRegime` decide PRIMERO `high_volatility`
 * comparando `atrPctNow = ATR/price×100` contra percentiles de esa misma serie — y `ATR` es
 * invariante (magnitud) mientras que `price` NO lo es bajo un ancla de reflexión fija (mismo
 * motivo que B4/B5: un cociente con denominador afín, no un valor lineal). Medido: el
 * 100% de los desacuerdos observados son transiciones DESDE `high_volatility` (17/19
 * `high_volatility→trending`, 2/19 `→ranging`) — nunca al revés y nunca entre
 * `trending`/`ranging`/`weak_trend`. Se reporta el match AGREGADO y, por separado, el match
 * EXCLUYENDO `high_volatility` de ambos lados (que sí debe salir 100% exacto, y es la parte
 * que usan H1/H2).
 *
 * MÉTODO: ventana de 180 velas de 4h (igual que producción). Horizonte 6 velas (24h).
 * Anclajes DISJUNTOS vía `lib/disjointAnchors.mjs`.
 *
 * SOLO LECTURA: Binance público, sin API key. No toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditAdxRegimeFilterSignal.mjs
 *       COINS=SOL DAYS=1000 node scripts/auditAdxRegimeFilterSignal.mjs
 */

import {
  calculateATRSeries, calculateRSI, calculateMACD, calculateADX, calculateSuperTrend,
  calculateWaveTrend, calculateStochRSI, calculateVolumeDelta, detectMarketRegime,
} from '../src/utils/indicators.js';
import { computeTrend } from '../src/services/indicatorService.js';
import { fetchKlines, mirrorCandles } from './lib/binanceKlines.mjs';
import { disjointRate, verdictCI } from './lib/disjointAnchors.mjs';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 1000);
const WIN = 180;                  // ventana de producción (4h)
const LOOKBACK = 6;                // 24h en velas de 4h
const SQRT_WINDOW = Math.sqrt(LOOKBACK);
const HORIZON_SEC = LOOKBACK * 4 * 3600;
const STRIDE = 6;
const FWD_BAND = 0.5;
const MIN_N = 30;

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

function trendDir(t) {
  if (!t) return null;
  if (t.includes('bull')) return 'bull';
  if (t.includes('bear')) return 'bear';
  return 'neutral';
}

function build(candles) {
  const atrByIdx = new Map((calculateATRSeries(candles, 14) ?? []).map((e) => [e.idx, e.atr]));
  const rows = [];
  let mirrorTotal = 0, mirrorMatch = 0, mirrorTotalNoVol = 0, mirrorMatchNoVol = 0;
  // Muestreo del control de reflexión: recorrer TODAS las anclas duplicaría el coste ya
  // pesado de detectMarketRegime (O(win²) por llamada); 1 de cada 5 basta para el 100%/no-100%.
  const MIRROR_SAMPLE_EVERY = 5;

  for (let i = WIN; i + LOOKBACK < candles.length; i++) {
    const atr = atrByIdx.get(i);
    const price = candles[i].close;
    if (!Number.isFinite(atr) || !(price > 0)) continue;
    const atrPct = (atr / price) * 100;
    if (!(atrPct > 0)) continue;

    const window = candles.slice(i - WIN + 1, i + 1);
    const closes = window.map((c) => c.close);
    const regime = detectMarketRegime(window, closes);
    const dir = trendDir(trendAt(window));
    if (regime === 'unknown' || dir === null) continue;

    const pxFwd = candles[i + LOOKBACK].close;
    const fwdAtr = (((pxFwd - price) / price) * 100) / (atrPct * SQRT_WINDOW);
    const t = Math.floor(candles[i].t / 1000);
    rows.push({ t, regime, dir, fwdAtr });

    if (i % MIRROR_SAMPLE_EVERY === 0) {
      const lo = i - WIN + 1;
      if (lo >= 0) {
        const mLocal = mirrorCandles(candles.slice(lo, i + 1), candles[lo].close);
        const mCloses = mLocal.map((c) => c.close);
        const mRegime = detectMarketRegime(mLocal, mCloses);
        if (mRegime !== 'unknown') {
          mirrorTotal++;
          if (mRegime === regime) mirrorMatch++;
          if (regime !== 'high_volatility' && mRegime !== 'high_volatility') {
            mirrorTotalNoVol++;
            if (mRegime === regime) mirrorMatchNoVol++;
          }
        }
      }
    }
  }
  return { rows, mirrorTotal, mirrorMatch, mirrorTotalNoVol, mirrorMatchNoVol };
}

console.log('═'.repeat(96));
console.log('B7 · ¿ES EL RÉGIMEN ADX (T2) UN FILTRO DE FIABILIDAD/MAGNITUD A 24H? — señal AISLADA');
console.log(`${DAYS} d objetivo · TF 4h · detectMarketRegime + computeTrend sobre ventana ${WIN} · horizonte ${LOOKBACK} velas`);
console.log('H1: trending acierta MÁS que ranging (trend-following) · H2: trending tiene MÁS movimiento grande');
console.log('P3: replica en 3 monedas, IC separado, n_ef>=30 por grupo · CONTROL: régimen IDÉNTICO bajo reflejo');
console.log('═'.repeat(96));

const results = [];
let mirrorTotalAll = 0, mirrorMatchAll = 0, mirrorTotalNoVolAll = 0, mirrorMatchNoVolAll = 0;

for (const coin of COINS) {
  let raw;
  try { raw = await fetchKlines(coin, DAYS); } catch (e) { console.log(`${coin}: ${e.message}`); continue; }
  if (raw.length < WIN + LOOKBACK + 20) { console.log(`${coin}: histórico insuficiente`); continue; }
  const spanDays = ((raw.at(-1).t - raw[0].t) / 86400e3).toFixed(0);
  const { rows, mirrorTotal, mirrorMatch, mirrorTotalNoVol, mirrorMatchNoVol } = build(raw);
  mirrorTotalAll += mirrorTotal; mirrorMatchAll += mirrorMatch;
  mirrorTotalNoVolAll += mirrorTotalNoVol; mirrorMatchNoVolAll += mirrorMatchNoVol;

  const trending = rows.filter((r) => r.regime === 'trending' && r.dir !== 'neutral');
  const ranging = rows.filter((r) => r.regime === 'ranging' && r.dir !== 'neutral');
  const hitDir = (r) => (r.dir === 'bull' ? r.fwdAtr > FWD_BAND : r.fwdAtr < -FWD_BAND);
  const bigMove = (r) => Math.abs(r.fwdAtr) > FWD_BAND;

  const byRegime = {};
  for (const r of rows) byRegime[r.regime] = (byRegime[r.regime] ?? 0) + 1;

  console.log(`\n${'─'.repeat(96)}\n${coin} — ${raw.length} velas de 4h (${spanDays} días) · n anclas=${rows.length}`);
  console.log(`  reparto de régimen: ${Object.entries(byRegime).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  con dirección definida (bull/bear): trending=${trending.length}  ranging=${ranging.length}`);

  const rTrendDir = disjointRate(trending, hitDir, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const rRangeDir = disjointRate(ranging, hitDir, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const rTrendBig = disjointRate(trending, bigMove, { horizonSec: HORIZON_SEC, stride: STRIDE });
  const rRangeBig = disjointRate(ranging, bigMove, { horizonSec: HORIZON_SEC, stride: STRIDE });

  const fmt = (r) => (r ? `n_ef=${r.n_eff} tasa=${r.point.toFixed(1)}% IC[${r.low.toFixed(1)}-${r.high.toFixed(1)}]` : 'sin anclas');
  console.log('  H1 · dirección de computeTrend acierta el movimiento a 24h:');
  console.log(`    trending: ${fmt(rTrendDir)}`);
  console.log(`    ranging:  ${fmt(rRangeDir)}`);
  const vDir = verdictCI(rTrendDir, rRangeDir);
  const h1Sig = rTrendDir?.n_eff >= MIN_N && rRangeDir?.n_eff >= MIN_N && vDir.separated && vDir.side === 'above';
  console.log(`    → ${vDir.separated ? `SEPARADOS (${vDir.side === 'above' ? 'trending > ranging: el régimen SÍ filtra' : 'ranging > trending: al revés de lo predicho'})` : 'IC se solapan — el régimen no cambia el acierto'}  ${h1Sig ? '✅' : '✗'}`);

  console.log('  H2 · tasa de movimiento grande (|fwdAtr|>0.5, cualquier signo):');
  console.log(`    trending: ${fmt(rTrendBig)}`);
  console.log(`    ranging:  ${fmt(rRangeBig)}`);
  const vBig = verdictCI(rTrendBig, rRangeBig);
  const h2Sig = rTrendBig?.n_eff >= MIN_N && rRangeBig?.n_eff >= MIN_N && vBig.separated && vBig.side === 'above';
  console.log(`    → ${vBig.separated ? `SEPARADOS (${vBig.side === 'above' ? 'trending > ranging: SÍ hay más magnitud en trending' : 'ranging > trending: al revés de lo predicho'})` : 'IC se solapan — el régimen no cambia la magnitud'}  ${h2Sig ? '✅' : '✗'}`);

  const noVolPct = mirrorTotalNoVol ? (mirrorMatchNoVol / mirrorTotalNoVol) * 100 : null;
  console.log(`  CONTROL DE CÓDIGO (reflejo local, muestreado 1/5): agregado ${mirrorMatch}/${mirrorTotal}`
    + ` (${mirrorTotal ? ((mirrorMatch / mirrorTotal) * 100).toFixed(2) : '—'}%)`
    + `  ·  excluyendo high_volatility (ambos lados): ${mirrorMatchNoVol}/${mirrorTotalNoVol}`
    + ` (${noVolPct != null ? noVolPct.toFixed(2) : '—'}%)`
    + `  ${mirrorTotalNoVol && mirrorMatchNoVol === mirrorTotalNoVol ? '✅' : '⚠️ revisar'}`);

  results.push({ coin, h1Sig, h2Sig });
}

console.log(`\n${'═'.repeat(96)}`);
console.log('VEREDICTO — ¿es el régimen ADX (T2) un filtro con potencia medible a 24h?');
let h1Count = 0, h2Count = 0;
for (const { coin, h1Sig, h2Sig } of results) {
  if (h1Sig) h1Count++;
  if (h2Sig) h2Count++;
  console.log(`  ${coin.padEnd(4)} H1 (filtra fiabilidad): ${h1Sig ? '✅' : '✗'}   H2 (filtra magnitud): ${h2Sig ? '✅' : '✗'}`);
}
console.log(`\n${h1Count} de ${results.length} monedas: H1 separado.`);
console.log(`${h2Count} de ${results.length} monedas: H2 separado.`);
console.log(`Control de reflexión global: agregado ${mirrorMatchAll}/${mirrorTotalAll}`
  + ` (${mirrorTotalAll ? ((mirrorMatchAll / mirrorTotalAll) * 100).toFixed(2) : '—'}%)`
  + `  ·  excluyendo high_volatility: ${mirrorMatchNoVolAll}/${mirrorTotalNoVolAll}`
  + ` (${mirrorTotalNoVolAll ? ((mirrorMatchNoVolAll / mirrorTotalNoVolAll) * 100).toFixed(2) : '—'}%).`);
console.log('\nLECTURA: si H1 o H2 replican en las 3 monedas, el régimen SÍ aporta información propia');
console.log('como filtro de trend-following o de magnitud. Si ninguna replica, es telemetría sin uso');
console.log('directivo medido — coherente con que ya está podado del dataset del LLM (v8_0).');
