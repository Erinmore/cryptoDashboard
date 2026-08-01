/**
 * auditGateConjunction.mjs — ¿pueden las puertas direccionales abrirse alguna vez?
 *
 * LA PREGUNTA. Tras 7 análisis consecutivos en `Esperar` (2026-08-01), la duda no es si el
 * sistema *quiere* operar: es si su conjunción de condiciones es alcanzable. `auditDerivatives
 * Score.mjs` ya demostró que una condición AISLADA puede disparar el 0,0 % del tiempo y nadie
 * se entera. `Comprar` y `Vender` exigen CINCO condiciones a la vez, y las puertas en serie
 * multiplican: nunca se ha medido la conjunción.
 *
 * Esto NO necesita muestra en vivo. Es una propiedad del código medible contra histórico,
 * exactamente como la medición que levantó la congelación.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ SE REPRODUCE Y QUÉ NO — leer antes que cualquier número
 *
 * `VENDER` exige (anthropicService.js §ACCIONES):
 *   1. Derivatives <= -1      ✅ determinista  → computeDerivativesScore()
 *   2. Volume <= -1           ⚠️  PROXY        → expectedVolumeScore() sobre el CVD del TF primario
 *   3. estructura confirma debilidad  ❌ juicio del LLM — NO reproducible
 *   4. ningún veto activo     ✅ determinista  → computeVetos()
 *   5. setup ejecutable       ❌ juicio del LLM — NO reproducible
 * `COMPRAR` es el espejo (>= +1, >= +1, trigger de reversión, sin veto, setup).
 *
 * Por eso el resultado es una **COTA SUPERIOR**: mide con qué frecuencia se alinean las tres
 * condiciones deterministas. Las dos que faltan solo pueden BAJAR esa cifra, nunca subirla.
 * Si la cota sale ~0 %, ninguna cantidad de recogida producirá un direccional y el problema
 * es de diseño, no de muestra. Si sale alta, el cuello de botella está en las dos que el
 * LLM juzga — y ahí sí hace falta observación.
 *
 * ⚠️ EL PROXY DE VOLUMEN NO ES EL SCORE DEL LLM. `expectedVolumeScore` es la guardia C2: se
 * ABSTIENE (0) ante divergencia CVD y ante `cvd_strength=marginal`, así que es CONSERVADORA —
 * tiende a subestimar |volume|. Contraste con los 7 análisis reales de producción (LLM vs
 * proxy): (0,0) (−1,−1) (−1,−1) (−1,0) (−1,−1) (−1,−2) (−2,−2) → coincide exacto en 5/7 y
 * difiere en 1 punto en 2/7, siempre con el proxy igual o MÁS conservador salvo un caso.
 * Se reporta también la cota con la condición de volumen RELAJADA para acotar ese sesgo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * FIDELIDAD A PRODUCCIÓN — cada decisión verificada contra el código, no contra la doc
 *
 *  · Ventanas de velas idénticas a producción: 4h→180, 1D→90 (`TF_LIMIT`, coingeckoService.js:63).
 *    Importa: `cvd_strength` se calcula por TERCILES DE LA PROPIA SERIE (T3), así que una
 *    ventana de otro tamaño produce otra etiqueta.
 *  · `taker_buy_base` extraído de las klines (índice 9). Sin él `calculateCVD` cae al proxy
 *    heurístico, que **da signo distinto** — el fallo que documenta CLAUDE.md.
 *  · Cambio de precio 24h: cierre a cierre del TF primario, NUNCA el `price_change_24h_pct`
 *    de CoinGecko (otra fuente, rolling). ⚠️ La referencia es la vela **i-5**, no la i-6:
 *    `priceChange24hFromCandles` cuenta 6 velas atrás desde la última del array y en
 *    producción esa última es la vela EN CURSO. Validado contra los 7 análisis reales — con
 *    i-6 el error llegaba a 1,28 pt y volteaba una celda; con i-5 el residuo es <=0,07 pt.
 *  · ⚠️ `atr_pct_at_analysis` (tabla `analysis_outcome`) NO sirve de referencia: lo reconstruye
 *    el outcome job sobre **19 velas** (`ATR_PERIOD+5`, outcomeService.js:56) mientras que el
 *    ATR que alimenta la decisión sale de la ventana de **180** (indicatorService). El ATR de
 *    Wilder es recursivo, así que son dos números distintos con nombres casi iguales. Aquí se
 *    usa el de 180, que es el que consume `computeDerivativesScore` (analysisController:624).
 *  · Liquidaciones: ventana horaria de 30 DÍAS terminada en el anclaje, con `median_window_
 *    points` calculado como en `coinalyzeService` (rolling24h.length). Los anclajes sin 30d
 *    completos SE DESCARTAN: con la mediana a medio formar la cascada se abstiene por el guard
 *    `cascade_min_points: 620` y la señal se diluye a la mitad (bug ya documentado).
 *  · `atr.pct` redondeado con `toFixed(2)` como en indicatorService.js:101 — la banda del OI es
 *    exactamente ±1,0 y el umbral de niveles sale de ese número: redondear distinto lo mueve.
 *  · Sin lookahead en ningún eje: toda ventana termina en el anclaje.
 *
 * ⚠️ DOS APROXIMACIONES CONOCIDAS, ambas declaradas:
 *  (a) `currentPrice` = cierre de la vela del anclaje. Producción usa el spot en vivo 5 min
 *      después del cierre; con el cron anclado a los cierres de vela la diferencia es de
 *      minutos, pero no es cero.
 *  (b) OI 24h: producción compara el valor VIVO contra `hist.slice(-6)[0].o` (coinalyzeService
 *      .js:172) — apertura de la vela 6 atrás. Aquí se usa `open` de la vela i-5 → `close` de
 *      la vela i, que es el mismo tramo de 24h cuando el histórico termina en la vela recién
 *      cerrada. Se mide TAMBIÉN la variante cierre-a-cierre para comprobar que la cifra de
 *      cabecera no es un artefacto de esta elección.
 *
 * SOLO LECTURA: no toca BBDD, ni producción, ni la ruta de decisión.
 *
 * Uso:  node scripts/auditGateConjunction.mjs
 *       COINS=SOL node scripts/auditGateConjunction.mjs
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateATR, calculateCVD, calculateSupportResistance } from '../src/utils/indicators.js';
import { computeDerivativesScore } from '../src/utils/derivativesScore.js';
import { expectedVolumeScore } from '../src/utils/expectedScores.js';
import { computeVetos } from '../src/utils/gating.js';
import { wilsonInterval } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const DAYS = 90;
const PRIMARY_TF = '4h';
const WIN_4H = 180;            // TF_LIMIT['4h'] — coingeckoService.js:63
const WIN_1D = 90;             // TF_LIMIT['1D']
const LIQ_WINDOW_H = 30 * 24;  // coinalyzeService fetcha 30 días de liquidaciones horarias
const H4 = 4 * 3600;

const here = path.dirname(fileURLToPath(import.meta.url));
const envRaw = readFileSync(path.join(here, '../../.env'), 'utf8');
const API_KEY = envRaw.match(/COINALYZE_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) { console.error('Falta COINALYZE_API_KEY en .env'); process.exit(1); }

const pct = (n, t) => (t === 0 ? '    — ' : `${((n / t) * 100).toFixed(1).padStart(5)}%`);
const dead = (n, t) => (t > 0 && (n / t) * 100 < 1 ? '  ← RAMA MUERTA' : '');

async function coinalyze(coin, endpoint, interval) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 86400;
  const url = `https://api.coinalyze.net/v1/${endpoint}?symbols=${coin}USDT_PERP.A`
    + `&interval=${interval}&from=${from}&to=${to}&api_key=${API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.log(`  (${endpoint} ${interval}: HTTP ${r.status})`); return []; }
  return (await r.json())?.[0]?.history ?? [];
}

/** Klines CON `taker_buy_base` (índice 9) — sin él el CVD cae al heurístico y cambia de signo. */
async function klines(coin, interval, limit) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`Binance ${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: Math.floor(x[0] / 1000),     // apertura, en segundos (misma convención que Coinalyze)
    open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5],
    taker_buy_base: +x[9],
  }));
}

/** severity / severity_negative exactamente como coinalyzeService.js:85-91. */
function fundingSeverity(ratePct) {
  if (!Number.isFinite(ratePct)) return null;
  return {
    severity: ratePct >= 0
      ? (ratePct > 0.5 ? 'extreme' : ratePct > 0.2 ? 'high' : ratePct > 0.05 ? 'elevated' : 'normal')
      : 'normal',
    severity_negative: ratePct < 0
      ? (ratePct < -0.5 ? 'extreme_short_overload' : ratePct < -0.2 ? 'high_short_overload'
        : ratePct < -0.05 ? 'elevated_short_overload' : null)
      : null,
  };
}

/**
 * Reproduce `fetchLiquidations` sobre la ventana de 30d que terminaría en `endIdx`
 * (índice EXCLUSIVO en el array horario). Devuelve el objeto que consume `liquidationCascade`.
 */
function liquidationsAt(liqHist, endIdx) {
  const startIdx = endIdx - LIQ_WINDOW_H;
  if (startIdx < 0) return null;                    // sin 30d completos → se descarta el anclaje
  const hist = liqHist.slice(startIdx, endIdx);
  const last24h = hist.slice(-24);
  if (last24h.length < 24) return null;
  const longs = last24h.reduce((a, h) => a + (h.l ?? 0), 0);
  const shorts = last24h.reduce((a, h) => a + (h.s ?? 0), 0);
  const total = longs + shorts;

  const rolling24h = [];
  for (let i = 24; i <= hist.length; i++) {
    const s = hist.slice(i - 24, i).reduce((a, h) => a + (h.l ?? 0) + (h.s ?? 0), 0);
    if (s > 0) rolling24h.push(s);
  }
  const sorted = rolling24h.slice().sort((a, b) => a - b);
  const median30d = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

  return {
    skew: total > 0 ? parseFloat(((shorts - longs) / total).toFixed(4)) : null,
    magnitude_vs_median_30d: median30d > 0 ? parseFloat((total / median30d).toFixed(2)) : null,
    median_window_points: rolling24h.length,
  };
}

async function auditCoin(coin) {
  console.log(`\n${'═'.repeat(84)}`);
  console.log(`${coin} — conjunción de puertas direccionales (${DAYS}d · TF ${PRIMARY_TF})`);
  console.log('═'.repeat(84));

  const [k4h, k1d, oiHist, liqHist, frHist] = await Promise.all([
    klines(coin, '4h', 1000),
    klines(coin, '1d', 400),
    coinalyze(coin, 'open-interest-history', '4hour'),
    coinalyze(coin, 'liquidation-history', '1hour'),
    coinalyze(coin, 'funding-rate-history', '4hour'),
  ]);
  if (!oiHist.length) { console.log('  Sin OI — se omite.'); return null; }
  console.log(`  datos: klines4h=${k4h.length} klines1d=${k1d.length} oi4h=${oiHist.length}`
    + ` liq1h=${liqHist.length} fr4h=${frHist.length}`);

  const idx4hByT = new Map(k4h.map((c, i) => [c.t, i]));
  const oiByT = new Map(oiHist.map((h, i) => [h.t, i]));
  const frByT = new Map(frHist.map((h) => [h.t, h.c]));
  // Primer índice horario de liquidaciones con apertura > t (⇒ ventana que termina EN t).
  const liqEndIdxAt = (closeSec) => {
    let lo = 0, hi = liqHist.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (liqHist[m].t < closeSec) lo = m + 1; else hi = m; }
    return lo;
  };

  const rows = [];
  let skippedLiq = 0;
  for (let i = WIN_4H - 1; i < k4h.length; i++) {
    const t = k4h[i].t;                    // apertura de la vela del anclaje
    const anchorClose = t + H4;            // instante del cierre = momento del análisis
    const oiIdx = oiByT.get(t);
    if (oiIdx == null || oiIdx < 5) continue;

    // ── Ventanas idénticas a producción, sin lookahead ────────────────────
    const w4h = k4h.slice(i - WIN_4H + 1, i + 1);
    const currentPrice = w4h.at(-1).close;
    const w1d = k1d.filter((c) => c.t + 86400 <= anchorClose).slice(-WIN_1D);
    if (w1d.length < WIN_1D) continue;

    const atrValue = calculateATR(w4h);
    if (!Number.isFinite(atrValue) || !(currentPrice > 0)) continue;
    const atrPct = parseFloat((atrValue / currentPrice * 100).toFixed(2));  // indicatorService.js:101

    const cvd4h = calculateCVD(w4h);
    const cvd1d = calculateCVD(w1d);
    const sr4h = calculateSupportResistance(w4h);

    // OI 24h: apertura de la vela i-5 → cierre de la vela i (tramo de 24h; ver cabecera).
    const oiOpen = oiHist[oiIdx - 5].o;
    const oiClose = oiHist[oiIdx].c;
    if (!(Math.abs(oiOpen) > 0)) continue;
    const oiChange = parseFloat(((oiClose - oiOpen) / Math.abs(oiOpen) * 100).toFixed(2));
    // Variante de sensibilidad: cierre a cierre (la que usa auditDerivativesRubric).
    const oiPrevClose = oiHist[oiIdx - 6]?.c;
    const oiChangeCC = Number.isFinite(oiPrevClose) && Math.abs(oiPrevClose) > 0
      ? parseFloat(((oiClose - oiPrevClose) / Math.abs(oiPrevClose) * 100).toFixed(2)) : null;

    // NO_LIQ_GUARD=1 amplía la muestra a los 90 días completos dejando que la cascada se
    // abstenga (como haría producción sin datos). Sirve para separar "la ventana de 58 días
    // es más tranquila" de "el replay está mal": las celdas OI×precio no dependen de esto.
    let liq = liquidationsAt(liqHist, liqEndIdxAt(anchorClose));
    if (!liq) {
      if (process.env.NO_LIQ_GUARD !== '1') { skippedLiq++; continue; }
      liq = {};
    }
    const funding = fundingSeverity(frByT.get(t));

    // ⚠️ REFERENCIA DE 24h — corregido tras validar contra los 7 análisis reales.
    // `priceChange24hFromCandles` mira 6 velas atrás desde la ÚLTIMA del array, y en
    // producción esa última es la vela EN CURSO (lo dice su propio docstring). Contando
    // desde la última vela CERRADA la referencia es por tanto `i-5`, no `i-6`.
    // Medido: con i-5 el residuo frente a producción es <=0,07 pt (una coincidencia exacta
    // a 3 decimales); con i-6 llegaba a 1,28 pt y cambiaba una celda de `no_signal` a
    // `failed_rally`. El resto (0,07) es que producción usa el spot 5 min dentro de la vela
    // siguiente y aquí se usa el cierre de la vela del anclaje.
    const pxPrev = k4h[i - 5].close;
    const priceChange24hPct = ((currentPrice - pxPrev) / pxPrev) * 100;

    const deriv = computeDerivativesScore({
      oiChange24hPct: oiChange, priceChange24hPct,
      atrPct, primaryTf: PRIMARY_TF, liquidations: liq, funding,
    });
    const derivCC = oiChangeCC == null ? null : computeDerivativesScore({
      oiChange24hPct: oiChangeCC, priceChange24hPct,
      atrPct, primaryTf: PRIMARY_TF, liquidations: liq, funding,
    });

    const vol = expectedVolumeScore(cvd4h);
    const technical = {
      '1D': { cvd: cvd1d },
      [PRIMARY_TF]: { cvd: cvd4h, support_resistance: sr4h, atr: { pct: atrPct } },
    };
    const gating = computeVetos({
      technical, openInterest: { change_24h_pct: oiChange }, currentPrice, primaryTf: PRIMARY_TF,
    });

    rows.push({
      t, deriv: deriv.score, derivCC: derivCC?.score ?? null, cell: deriv.components.oi_price_cell,
      vol: vol.score, cvdStrength: cvd4h?.cvd_strength ?? null, cvdDiv: cvd4h?.divergence ?? null,
      cvdSource: cvd4h?.source ?? null,
      vetoLong: gating.veto_long, vetoShort: gating.veto_short,
      dataInsufficient: gating.data_insufficient,
    });
  }

  const n = rows.length;
  if (!n) { console.log('  Sin anclajes utilizables.'); return null; }
  console.log(`  anclajes: ${n}  (descartados por <30d de liquidaciones: ${skippedLiq})`);
  const src = new Set(rows.map((r) => r.cvdSource));
  console.log(`  CVD source: ${[...src].join(',')}${src.has('heuristic') ? '  ⚠️ HEURÍSTICO — el signo puede diferir' : ''}`);

  // ── 1 · Frecuencias marginales ────────────────────────────────────────────
  const c = (f) => rows.filter(f).length;
  const dBuy = c((r) => r.deriv >= 1), dSell = c((r) => r.deriv <= -1);
  const vBuy = c((r) => r.vol >= 1), vSell = c((r) => r.vol <= -1);
  const anyVeto = c((r) => r.vetoLong || r.vetoShort);
  console.log('\n1 · CONDICIONES POR SEPARADO');
  console.log(`   Derivatives >= +1            ${pct(dBuy, n)}${dead(dBuy, n)}`);
  console.log(`   Derivatives <= -1            ${pct(dSell, n)}${dead(dSell, n)}`);
  console.log(`   Volume(proxy) >= +1          ${pct(vBuy, n)}${dead(vBuy, n)}`);
  console.log(`   Volume(proxy) <= -1          ${pct(vSell, n)}${dead(vSell, n)}`);
  console.log(`   Algún veto activo            ${pct(anyVeto, n)}`);
  console.log(`   data_insufficient            ${pct(c((r) => r.dataInsufficient), n)}`);

  // ── 2 · La conjunción (cota superior) ─────────────────────────────────────
  // vetoActive = veto_long || veto_short fuerza Esperar en CUALQUIER dirección
  // (decisionGates.js:54) — no basta con que no haya veto del lado contrario.
  const clean = (r) => !r.vetoLong && !r.vetoShort && !r.dataInsufficient;
  const buy = c((r) => r.deriv >= 1 && r.vol >= 1 && clean(r));
  const sell = c((r) => r.deriv <= -1 && r.vol <= -1 && clean(r));
  const ci = (k) => { const w = wilsonInterval(k, n); return w ? `[${w.low.toFixed(1)}-${w.high.toFixed(1)}]` : '—'; };
  console.log('\n2 · CONJUNCIÓN DETERMINISTA  ← COTA SUPERIOR (faltan estructura y setup)');
  console.log(`   COMPRAR  deriv>=+1 & vol>=+1 & sin veto   ${pct(buy, n)}  IC95 ${ci(buy)}   n=${buy}`);
  console.log(`   VENDER   deriv<=-1 & vol<=-1 & sin veto   ${pct(sell, n)}  IC95 ${ci(sell)}   n=${sell}`);

  // Sensibilidad al proxy de volumen: ¿cuánto sube si el volumen no bloquea?
  const buyNoVol = c((r) => r.deriv >= 1 && clean(r));
  const sellNoVol = c((r) => r.deriv <= -1 && clean(r));
  console.log(`   (sin exigir volumen)  COMPRAR ${pct(buyNoVol, n)} · VENDER ${pct(sellNoVol, n)}`);

  // ── 3 · Quién bloquea ─────────────────────────────────────────────────────
  console.log('\n3 · QUIÉN BLOQUEA CADA DIRECCIÓN  (% de anclajes donde esa condición falla)');
  for (const [label, dOk, vOk] of [
    ['COMPRAR', (r) => r.deriv >= 1, (r) => r.vol >= 1],
    ['VENDER ', (r) => r.deriv <= -1, (r) => r.vol <= -1],
  ]) {
    const fd = c((r) => !dOk(r)), fv = c((r) => !vOk(r)), fg = c((r) => !clean(r));
    const only = (fail, others) => c((r) => fail(r) && others.every((o) => !o(r)));
    console.log(`   ${label}: falla derivatives ${pct(fd, n)} · volumen ${pct(fv, n)} · gating ${pct(fg, n)}`);
    console.log(`            ÚNICO bloqueo derivatives ${pct(only((r) => !dOk(r), [(r) => !vOk(r), (r) => !clean(r)]), n)}`
      + ` · volumen ${pct(only((r) => !vOk(r), [(r) => !dOk(r), (r) => !clean(r)]), n)}`
      + ` · gating ${pct(only((r) => !clean(r), [(r) => !dOk(r), (r) => !vOk(r)]), n)}`);
  }

  // ── 4 · Sensibilidad a la definición del OI 24h ───────────────────────────
  const withCC = rows.filter((r) => r.derivCC != null);
  if (withCC.length) {
    const sellCC = withCC.filter((r) => r.derivCC <= -1 && r.vol <= -1 && clean(r)).length;
    const buyCC = withCC.filter((r) => r.derivCC >= 1 && r.vol >= 1 && clean(r)).length;
    const agree = withCC.filter((r) => r.deriv === r.derivCC).length;
    console.log('\n4 · SENSIBILIDAD · OI 24h cierre-a-cierre en vez de apertura-a-cierre');
    console.log(`   scores idénticos ${pct(agree, withCC.length)} · COMPRAR ${pct(buyCC, withCC.length)}`
      + ` · VENDER ${pct(sellCC, withCC.length)}`);
  }

  // ── 5 · Reparto de la celda OI×precio (contexto del score) ────────────────
  const cells = {};
  for (const r of rows) cells[r.cell] = (cells[r.cell] ?? 0) + 1;
  console.log('\n5 · CELDA OI×PRECIO');
  for (const [k, v] of Object.entries(cells).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(18)} ${pct(v, n)}`);
  }

  return { coin, n, buy, sell, buyNoVol, sellNoVol, dBuy, dSell, vBuy, vSell, anyVeto };
}

const results = [];
for (const coin of COINS) {
  try { const r = await auditCoin(coin); if (r) results.push(r); }
  catch (e) { console.error(`\n${coin}: ${e.message}`); }
}

if (results.length) {
  console.log(`\n${'═'.repeat(84)}\nRESUMEN — cota superior de las puertas direccionales\n${'═'.repeat(84)}`);
  console.log('  moneda    n   COMPRAR   VENDER   (sin volumen: COMPRAR/VENDER)');
  for (const r of results) {
    console.log(`  ${r.coin.padEnd(6)} ${String(r.n).padStart(4)}  ${pct(r.buy, r.n)}  ${pct(r.sell, r.n)}`
      + `        ${pct(r.buyNoVol, r.n)} / ${pct(r.sellNoVol, r.n)}`);
  }
  const tn = results.reduce((a, r) => a + r.n, 0);
  const tb = results.reduce((a, r) => a + r.buy, 0);
  const ts = results.reduce((a, r) => a + r.sell, 0);
  const wb = wilsonInterval(tb, tn), ws = wilsonInterval(ts, tn);
  console.log(`\n  AGREGADO n=${tn}  COMPRAR ${pct(tb, tn)} IC95 [${wb?.low.toFixed(1)}-${wb?.high.toFixed(1)}]`
    + `  ·  VENDER ${pct(ts, tn)} IC95 [${ws?.low.toFixed(1)}-${ws?.high.toFixed(1)}]`);
  console.log('\n  ⚠️ COTA SUPERIOR: faltan "estructura confirma" y "setup ejecutable", ambas juicio');
  console.log('     del LLM. Solo pueden BAJAR estas cifras. En producción `has_executable_setup`');
  console.log('     lleva 0 de 7. Y el volumen es un PROXY conservador, no el score del modelo.');
}
