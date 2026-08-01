/**
 * auditComputeTrend.mjs — ¿es simétrico y descriptivo el `trend` ponderado?
 *
 * `computeTrend` resume 7 indicadores en una etiqueta con la jerarquía del prompt
 * (estructura 50 % / ejecución 30 % / volumen 20 %) y es lo que viaja al LLM como `trend`
 * de cada TF. Nunca se ha comprobado ni que reparta ni que signifique lo que dice.
 *
 * ANCLAS, fijadas antes de ejecutar:
 *
 *  A1 · REFLEXIÓN (simetría forzada, ancla EXACTA). Se refleja el camino del precio
 *       (`p' = 2A − p`, con los `high`/`low` intercambiados) y se refleja el agresor
 *       (`taker_buy' = volume − taker_buy`). Bajo esa transformación **todos** los
 *       ingredientes se dan la vuelta exactamente: los retornos cambian de signo, luego
 *       RSI' = 100−RSI, MACD' = −MACD, DI+ ↔ DI−, las bandas de SuperTrend se invierten,
 *       StochRSI' = 100−StochRSI y buy_pressure' = 100−buy_pressure. El ATR y el ADX no
 *       cambian (los rangos se conservan). Por tanto la etiqueta DEBE salir la contraria,
 *       una a una: `strongly_bullish ↔ strongly_bearish`, `bullish ↔ bearish`,
 *       `neutral ↔ neutral`. **Ancla: 100 %.** Cualquier fallo es una asimetría del código
 *       —un `? 1 : -1` con el caso del medio sin cubrir, una banda muerta descentrada— y no
 *       una propiedad del mercado. Es el patrón que ya destapó `fear_greed.trend_1d`.
 *
 *  A2 · RAMAS MUERTAS. Frecuencia de las 5 etiquetas. `strongly_*` exige |bias| >= 0,6 con
 *       pesos 0,5/0,3/0,2: si saliera ~0 % sería el fallo T1 otra vez (un corte que no
 *       seleccciona nada). Ancla: ninguna etiqueta al 0 % ni por encima del ~60 %.
 *
 *  A3 · VALIDEZ DESCRIPTIVA (contra la deriva del periodo, que es el pendiente nº4).
 *       `computeTrend` NO es un pronóstico: describe el estado ACTUAL. Así que lo que debe
 *       cumplirse es que la deriva YA REALIZADA de la ventana crezca monótonamente de
 *       `strongly_bearish` a `strongly_bullish`, y que `neutral` quede cerca de 0. Se
 *       reporta además la deriva POSTERIOR, pero como observación, NO como ancla: exigirle
 *       que prediga sería juzgarlo por algo que no promete.
 *
 * Método: velas reales del TF, indicadores calculados con las funciones REALES en el mismo
 * orden que `indicatorService.computeIndicators`, y `computeTrend` importado tal cual.
 *
 * SOLO LECTURA. No abre la BBDD. Binance público, sin API keys.
 *
 * Uso: node scripts/auditComputeTrend.mjs   ·   COINS=BTC TFS=1D node scripts/...
 */

import {
  calculateRSI, calculateMACD, calculateADX, calculateSuperTrend,
  calculateWaveTrend, calculateStochRSI, calculateVolumeDelta,
} from '../src/utils/indicators.js';
import { computeTrend } from '../src/services/indicatorService.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const TFS = (process.env.TFS ?? '1h,4h,1D').split(',');
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };
const TF_LIMIT = { '1h': 168, '4h': 180, '1D': 90, '1W': 52 };
const ANCHORS = Number(process.env.ANCHORS ?? 400);
const FWD = Number(process.env.FWD ?? 6);         // velas hacia delante (solo observación)

const LABELS = ['strongly_bearish', 'bearish', 'neutral', 'bullish', 'strongly_bullish'];
const OPPOSITE = {
  strongly_bullish: 'strongly_bearish', bullish: 'bearish', neutral: 'neutral',
  bearish: 'bullish', strongly_bearish: 'strongly_bullish',
};

async function klines(symbol, interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
    volume: +x[5], taker_buy_base: +x[9],
  }));
}

/**
 * Reconstruye el término de ESTRUCTURA (peso 0,5) tal y como lo compone `computeTrend`.
 * Sirve para explicar el reparto en vez de deducirlo: `neutral` exige |bias| < 0,2, y la
 * estructura sola aporta ±0,5 cuando sus dos componentes coinciden — o sea que con acuerdo
 * estructural hace falta que ejecución (0,3) y volumen (0,2) se opongan CASI POR COMPLETO
 * para volver a |bias| < 0,2. Medido: con acuerdo estructural `neutral` sale el 1,04 %;
 * con la estructura dividida, el 47,47 %. O sea que `neutral` no significa "sin sesgo":
 * significa, casi siempre, "ADX y SuperTrend se contradicen".
 */
function structureOf(candles) {
  const adx = calculateADX(candles), st = calculateSuperTrend(candles);
  let score = 0, count = 0;
  if (adx && adx.regime !== 'ranging') { score += adx.trend_direction === 'bullish' ? 1 : -1; count++; }
  if (st) { score += st.trend === 'UP' ? 1 : -1; count++; }
  return count > 0 ? score / count : 0;
}

/** Mismo orden y mismas funciones que `indicatorService.computeIndicators`. */
function trendOf(candles) {
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

/**
 * Reflexión del camino: `p' = 2A − p`. Los extremos se intercambian (el máximo reflejado
 * es el mínimo) y el agresor se complementa. Conserva rangos y volumen.
 */
function mirror(candles) {
  const A = candles[0].close;
  return candles.map((c) => ({
    t: c.t,
    open: 2 * A - c.open, close: 2 * A - c.close,
    high: 2 * A - c.low, low: 2 * A - c.high,
    volume: c.volume, taker_buy_base: c.volume - c.taker_buy_base,
  }));
}

const blank = () => ({
  n: 0, mirrorOk: 0, mirrorBad: [],
  counts: Object.fromEntries(LABELS.map((l) => [l, 0])),
  struct: { agree: 0, split: 0, none: 0 },
  neutralWhen: { agree: 0, split: 0, none: 0 },
  past: Object.fromEntries(LABELS.map((l) => [l, []])),
  fwd: Object.fromEntries(LABELS.map((l) => [l, []])),
});

const agg = blank();

console.log('AUDITORÍA DE `computeTrend` (etiqueta ponderada 50/30/20)');
console.log('ANCLAS: A1 reflexión → 100 % de etiquetas invertidas · A2 sin ramas muertas');
console.log('        A3 la deriva YA REALIZADA debe crecer monótonamente con la etiqueta\n');

for (const tf of TFS) {
  const win = TF_LIMIT[tf];
  for (const coin of COINS) {
    try {
      const need = win + ANCHORS + FWD;
      const all = await klines(coin, BINANCE_TF[tf], Math.min(1000, need));
      if (all.length < win + 20) { console.log(`  ${coin}/${tf}: histórico insuficiente`); continue; }
      const t = blank();
      for (let end = win; end + FWD <= all.length; end++) {
        const w = all.slice(end - win, end);
        const lbl = trendOf(w);
        const mir = trendOf(mirror(w));
        t.n++; agg.n++;
        if (mir === OPPOSITE[lbl]) { t.mirrorOk++; agg.mirrorOk++; }
        else if (t.mirrorBad.length < 3) t.mirrorBad.push(`${lbl}→${mir}`);
        t.counts[lbl]++; agg.counts[lbl]++;
        const sv = structureOf(w);
        const bucket = sv === 0 ? 'split' : 'agree';
        agg.struct[bucket]++;
        if (lbl === 'neutral') agg.neutralWhen[bucket]++;
        // Deriva de la ventana (ya realizada) y de las FWD velas siguientes (observación).
        const past = (w.at(-1).close / w[0].close - 1) * 100;
        const fwd = (all[end + FWD - 1].close / w.at(-1).close - 1) * 100;
        t.past[lbl].push(past); agg.past[lbl].push(past);
        t.fwd[lbl].push(fwd); agg.fwd[lbl].push(fwd);
      }
      const bad = t.n - t.mirrorOk;
      console.log(`  ${coin}/${tf.padEnd(3)} n=${String(t.n).padStart(4)}  `
        + `A1 reflexión ${(t.mirrorOk / t.n * 100).toFixed(1)}%`
        + (bad ? `  ❌ ${bad} fallos: ${t.mirrorBad.join(', ')}` : '  ✅'));
    } catch (e) { console.log(`  ${coin}/${tf}: ${e.message}`); }
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x) => (x == null ? '  —  ' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);

console.log(`\n${'═'.repeat(78)}\nA1 · REFLEXIÓN (agregado): `
  + `${(agg.mirrorOk / agg.n * 100).toFixed(2)}% de ${agg.n} ventanas invierten la etiqueta`
  + `  ${agg.mirrorOk === agg.n ? '✅ EXACTO' : '❌'}`);

console.log('\nA2 · REPARTO DE ETIQUETAS (ancla: ninguna al 0 % ni dominante)');
for (const l of LABELS) {
  console.log(`    ${l.padEnd(17)} ${(agg.counts[l] / agg.n * 100).toFixed(1).padStart(5)}%`
    + `  (n=${agg.counts[l]})`);
}

console.log('\n    Descomposición del reparto — el término de ESTRUCTURA pesa 0,5 y sus dos');
console.log('    componentes (ADX en tendencia, SuperTrend) son binarios SIN banda muerta:');
console.log(`      estructura con ACUERDO (±1 → aporta ±0,5): ${(agg.struct.agree / agg.n * 100).toFixed(1)}%`
  + `  → de ellas neutral: ${agg.neutralWhen.agree} (${(agg.neutralWhen.agree / Math.max(agg.struct.agree, 1) * 100).toFixed(2)}%)`);
console.log(`      estructura DIVIDIDA o ausente (0):         ${(agg.struct.split / agg.n * 100).toFixed(1)}%`
  + `  → de ellas neutral: ${agg.neutralWhen.split} (${(agg.neutralWhen.split / Math.max(agg.struct.split, 1) * 100).toFixed(2)}%)`);

console.log('\nA3 · DERIVA POR ETIQUETA — la de la VENTANA es el ancla; la posterior, observación');
console.log(`    ${'etiqueta'.padEnd(17)}${'deriva ventana'.padStart(16)}${`deriva +${FWD} velas`.padStart(18)}`);
for (const l of LABELS) {
  console.log(`    ${l.padEnd(17)}${fmt(mean(agg.past[l])).padStart(16)}${fmt(mean(agg.fwd[l])).padStart(18)}`);
}
