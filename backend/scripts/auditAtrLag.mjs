/**
 * auditAtrLag.mjs — ¿va rezagado el ATR, y cuánto sesga los umbrales que normaliza?
 *
 * POR QUÉ ESTE SCRIPT. El ATR de Wilder es un promedio exponencial del rango verdadero con
 * α = 1/period: por construcción mira SOLO hacia atrás, con una memoria efectiva de ~13
 * periodos. Si la volatilidad cambia de nivel, el ATR llega tarde — alto cuando ya se
 * comprimió, bajo cuando ya se expandió. Eso no es una hipótesis sobre el mercado: es una
 * propiedad del estimador. **Lo que hay que medir es el TAMAÑO del sesgo en el régimen en
 * el que opera producción**, porque el ATR es el DENOMINADOR de casi todos los umbrales del
 * sistema: la banda del eje OI×precio (`0,5×ATR%×√n`), `dynamicNearLevelPct` (1,5×ATR%), el
 * listón de oportunidad (2×ATR) y la distancia normalizada del gatillo (`ATR%×√velas`).
 *
 * Tres síntomas independientes apuntan al mismo sitio y por eso se mide ahora: `no_signal`
 * domina el eje de OI · el lift del shadow trade sale −55 y está diagnosticado que sale
 * negativo POR CONSTRUCCIÓN si el ATR va alto en compresión · la asimetría arriba/abajo de
 * la oportunidad se explicó por "el listón de 2×ATR queda alto en régimen comprimido".
 *
 * ANCLAS, fijadas ANTES de ejecutar. La predicción del rezago está FIRMADA, que es lo que
 * la hace falsable — un sesgo sin signo predicho no refutaría nada:
 *
 *  A1 · INSESGADO EN AGREGADO (auto-referencia). El ATR estima el rango verdadero por vela.
 *       Sobre TODOS los anclajes, `TR realizado de las k velas siguientes / ATR_t` debe dar
 *       **≈ 1,00**. Si el agregado ya se desvía, el estimador está sesgado en nivel y no
 *       solo en tiempo.
 *
 *  A2 · EL SESGO FIRMADO (la prueba de verdad). Se parte por lo que el ATR ACABA de hacer
 *       (`ATR_t / ATR_{t−k}`, terciles). El rezago predice, con signo:
 *         · comprimiendo (ATR cayendo) → el ATR va ALTO → ratio **< 1**
 *         · expandiendo (ATR subiendo) → el ATR va BAJO → ratio **> 1**
 *       Y predice MONOTONÍA entre los dos extremos. Si los tres terciles dan ≈1, no hay
 *       rezago explotable y las tres explicaciones de arriba se caen a la vez.
 *
 *  A3 · MAGNITUD EN UNIDADES DE DECISIÓN (lo único que importa para actuar). El sesgo se
 *       traduce a la banda REAL con `priceBandPct` —la función de producción, no una
 *       fórmula copiada— y se reporta cuántos puntos porcentuales de banda sobran o faltan.
 *       Un sesgo del 5 % no justifica tocar nada; uno del 30 % explicaría el `no_signal`.
 *
 *  A4 · ¿TIENE ARREGLO? Se repite con ATR de ventana más corta (7) y con **Parkinson**,
 *       que estima la volatilidad con el RANGO INTRAVELA (high/low) en vez de acumular
 *       historia, y por eso reacciona en una vela. Si el sesgo condicional se encoge, el
 *       arreglo tiene diana; si no se encoge, el problema no es el estimador.
 *
 * ⚠️ Esto NO propone cambiar nada. Es solo lectura, no abre la BBDD y no toca producción.
 *
 * Uso: node scripts/auditAtrLag.mjs   ·   COINS=SOL TF=4h DAYS=400 node scripts/auditAtrLag.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { priceBandPct } from '../src/utils/derivativesScore.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const TF = process.env.TF ?? '4h';
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d' };
const DAYS = Number(process.env.DAYS ?? 400);
const PERIOD = 14;                 // el de producción (SUPERTREND_ATR_PERIOD)
const FWD = Number(process.env.FWD ?? 6);    // velas hacia delante = 24h en 4h
const LOOKBACK = Number(process.env.LOOKBACK ?? 6);  // para medir qué acaba de hacer el ATR
const HOUR_MS = 3600 * 1000;
const TF_H = { '1h': 1, '4h': 4, '1D': 24 }[TF];

async function klines(symbol, interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
  }));
}

async function fetchDeep(symbol, interval, want) {
  const out = [];
  let endTime;
  for (let i = 0; i < 20 && out.length < want; i++) {
    const b = await klines(symbol, interval, 1000, endTime);
    if (!b.length) break;
    out.unshift(...b);
    endTime = b[0].t - 1;
    if (b.length < 1000) break;
  }
  return out;
}

/** Rango verdadero de Wilder — la misma definición que promedia `calculateATR`. */
const trueRange = (c, prev) => Math.max(
  c.high - c.low,
  prev ? Math.abs(c.high - prev.close) : 0,
  prev ? Math.abs(c.low - prev.close) : 0,
);

/**
 * Volatilidad de Parkinson sobre `n` velas, en las MISMAS unidades que el ATR (precio por
 * vela). Usa solo el rango intravela: `σ² = mean(ln(H/L)²) / (4 ln2)`. Reacciona en una
 * vela porque no arrastra historia — es la alternativa natural al promedio recursivo.
 */
function parkinson(candles, n, lastClose) {
  const w = candles.slice(-n).filter((c) => c.high > 0 && c.low > 0);
  if (w.length < 2) return null;
  const s = w.reduce((a, c) => a + Math.log(c.high / c.low) ** 2, 0) / w.length;
  return Math.sqrt(s / (4 * Math.LN2)) * lastClose;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const rows = [];   // un registro por ancla, de todas las monedas

for (const coin of COINS) {
  const need = Math.ceil((DAYS * 24) / TF_H) + PERIOD + FWD + LOOKBACK + 5;
  const cs = await fetchDeep(coin, BINANCE_TF[TF], need);
  if (cs.length < PERIOD + FWD + LOOKBACK + 10) { console.log(`${coin}: sin datos`); continue; }

  for (let i = PERIOD + LOOKBACK + 1; i + FWD < cs.length; i++) {
    const hist = cs.slice(0, i + 1);
    const atr = calculateATR(hist, PERIOD);
    const atrShort = calculateATR(hist, 7);
    const atrPrev = calculateATR(cs.slice(0, i + 1 - LOOKBACK), PERIOD);
    const close = cs[i].close;
    if (![atr, atrShort, atrPrev].every(Number.isFinite) || !(close > 0)) continue;

    // Realizado HACIA DELANTE: el TR medio de las FWD velas siguientes, que es exactamente
    // la magnitud que el ATR pretende estimar.
    const fwd = cs.slice(i + 1, i + 1 + FWD);
    const trs = fwd.map((c, k) => trueRange(c, k === 0 ? cs[i] : fwd[k - 1]));
    const realized = mean(trs);
    if (!Number.isFinite(realized) || realized <= 0) continue;

    const park = parkinson(hist, PERIOD, close);
    // Cambio de precio de las últimas FWD velas = el `price_change_24h_pct_candles` que
    // compara `oiPriceCell` contra la banda. Con él se puede contar cuántas celdas silencia
    // el rezago POR SÍ SOLO, que es lo único que decide si el hallazgo tiene consecuencia.
    const ref = cs[i - FWD]?.close;
    const chg = ref > 0 ? ((close - ref) / ref) * 100 : null;

    rows.push({
      coin,
      atrPct: (atr / close) * 100,
      ratio: realized / atr,                     // >1 → el ATR se quedó CORTO
      ratioShort: realized / atrShort,
      ratioPark: park ? realized / park : null,
      slope: atr / atrPrev,                      // <1 → comprimiendo
      realizedPct: (realized / close) * 100,
      chg,
    });
  }
}

// ── reporte ──────────────────────────────────────────────────────────────────

const fmt = (x, d = 3) => (x == null ? '  —  ' : x.toFixed(d));

console.log('AUDITORÍA DEL REZAGO DEL ATR (Wilder, period=14) — solo lectura');
console.log(`TF ${TF} · ${DAYS} d · ${COINS.join('+')} · n=${rows.length} anclas`);
console.log(`Métrica: TR medio realizado en las ${FWD} velas siguientes ÷ ATR del instante.`);
console.log('  > 1 → el ATR se quedó CORTO (umbrales demasiado estrechos)');
console.log('  < 1 → el ATR se quedó ALTO  (umbrales demasiado anchos → no_signal)\n');

console.log(`A1 · AGREGADO (ancla: 1,000)   media ${fmt(mean(rows.map((r) => r.ratio)))}`
  + `   mediana ${fmt(median(rows.map((r) => r.ratio)))}`);

// A2 — terciles por la PENDIENTE reciente del ATR.
const slopes = rows.map((r) => r.slope).sort((a, b) => a - b);
const q = (p) => slopes[Math.floor((slopes.length - 1) * p)];
const [lo, hi] = [q(1 / 3), q(2 / 3)];
const bucket = (r) => (r.slope < lo ? 'comprimiendo' : r.slope < hi ? 'estable' : 'expandiendo');

console.log(`\nA2 · SESGO FIRMADO — terciles por pendiente reciente del ATR (${LOOKBACK} velas)`);
console.log('     PREDICHO: comprimiendo < 1  ·  expandiendo > 1  ·  monótono entre ambos');
console.log(`     ${'régimen'.padEnd(14)}${'n'.padStart(6)}${'ATR14'.padStart(9)}${'ATR7'.padStart(9)}${'Parkinson'.padStart(11)}`);
for (const b of ['comprimiendo', 'estable', 'expandiendo']) {
  const g = rows.filter((r) => bucket(r) === b);
  console.log(`     ${b.padEnd(14)}${String(g.length).padStart(6)}`
    + `${fmt(median(g.map((r) => r.ratio))).padStart(9)}`
    + `${fmt(median(g.map((r) => r.ratioShort))).padStart(9)}`
    + `${fmt(median(g.map((r) => r.ratioPark).filter(Number.isFinite))).padStart(11)}`);
}

// A3 — el sesgo traducido a la banda REAL de producción.
console.log('\nA3 · MAGNITUD EN UNIDADES DE DECISIÓN (banda del eje OI×precio, `priceBandPct` real)');
console.log(`     ${'régimen'.padEnd(14)}${'ATR% medio'.padStart(12)}${'banda'.padStart(9)}`
  + `${'banda "justa"'.padStart(15)}${'sobra'.padStart(9)}`);
for (const b of ['comprimiendo', 'estable', 'expandiendo']) {
  const g = rows.filter((r) => bucket(r) === b);
  if (!g.length) continue;
  const atrPct = median(g.map((r) => r.atrPct));
  const ratio = median(g.map((r) => r.ratio));
  const band = priceBandPct(atrPct, TF);
  const fair = priceBandPct(atrPct * ratio, TF);   // la que saldría con el ATR "sin rezago"
  console.log(`     ${b.padEnd(14)}${fmt(atrPct, 2).padStart(12)}${fmt(band, 3).padStart(9)}`
    + `${fmt(fair, 3).padStart(15)}${`${((band / fair - 1) * 100).toFixed(1)}%`.padStart(9)}`);
}

// Régimen ACTUAL de producción: el cuartil más comprimido por nivel de ATR%.
const byAtr = [...rows].sort((a, b) => a.atrPct - b.atrPct);
const calm = byAtr.slice(0, Math.floor(byAtr.length / 4));
console.log('\n     POR NIVEL de ATR% (no por pendiente) — el periodo actual está en el ~4 % más tranquilo.');
console.log('     Aquí manda la REVERSIÓN A LA MEDIA de la volatilidad, que empuja al revés que el rezago:');
for (const p of [0.04, 0.10, 0.25, 0.50]) {
  const g = byAtr.slice(0, Math.max(20, Math.floor(byAtr.length * p)));
  console.log(`       ${(p * 100).toFixed(0).padStart(3)} % más tranquilo  n=${String(g.length).padStart(5)}`
    + `   ratio ${fmt(median(g.map((r) => r.ratio)))}`
    + `   ATR% mediano ${fmt(median(g.map((r) => r.atrPct)), 2)}`);
}
const loud = byAtr.slice(-Math.floor(byAtr.length * 0.10));
console.log(`       10 % más agitado   n=${String(loud.length).padStart(5)}`
  + `   ratio ${fmt(median(loud.map((r) => r.ratio)))}`
  + `   ATR% mediano ${fmt(median(loud.map((r) => r.atrPct)), 2)}`);

// La cuenta que decide: anclas cuyo |Δprecio 24h| cae ENTRE la banda "justa" y la real.
// Son exactamente las que el rezago convierte en `no_signal` y que sin él habrían puntuado.
let silenced = 0, evaluable = 0, outside = 0;
for (const r of rows) {
  if (!Number.isFinite(r.chg) || !(r.atrPct > 0)) continue;
  const band = priceBandPct(r.atrPct, TF);
  const fair = priceBandPct(r.atrPct * r.ratio, TF);
  evaluable++;
  if (Math.abs(r.chg) > band) outside++;
  const [a, b] = fair < band ? [fair, band] : [band, fair];
  if (Math.abs(r.chg) > a && Math.abs(r.chg) <= b) silenced++;
}
console.log('\n     CONSECUENCIA REAL — anclas cuyo |Δprecio 24h| cae entre la banda justa y la real');
console.log(`     (o sea, las que el rezago silencia o desbloquea POR SÍ SOLO): `
  + `${silenced}/${evaluable} = ${(silenced / evaluable * 100).toFixed(2)}%`);
console.log(`     Para comparar: ${(outside / evaluable * 100).toFixed(1)}% de las anclas ya superan la banda actual.`);

console.log('\nA4 · POR MONEDA (ratio ATR14 en el tercil comprimiendo — ¿replica?)');
for (const c of COINS) {
  const g = rows.filter((r) => r.coin === c && bucket(r) === 'comprimiendo');
  if (g.length) console.log(`     ${c.padEnd(5)} ${fmt(median(g.map((r) => r.ratio)))}  (n=${g.length})`);
}
