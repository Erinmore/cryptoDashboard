/**
 * auditVolatilityState.mjs — ¿reparte por terciles el `volatility_state` de Bollinger?
 *
 * EL PROBLEMA. `calculateBollingerBands` etiqueta squeeze/normal/expansion situando la
 * anchura actual en su PROPIA distribución con `bucketByPercentile(lowP=0.33, highP=0.67)`
 * ([indicators.js:141](../src/utils/indicators.js#L141)). La muestra INCLUYE al propio
 * valor, así que por definición el reparto tiene que ser **33/34/33**. La doc de v8_0 da
 * por bueno un **24-42 %** "sin ramas muertas", y eso no es una tolerancia: es un número
 * que no puede ser lo que dice ser. O el reparto es uniforme y el 24-42 sobra, o no lo es
 * y entonces la etiqueta no significa "tercil".
 *
 * ANCLAS, fijadas antes de ejecutar:
 *
 *  A1 · AUTO-REFERENCIA (exacta por construcción). Cada bucket = 33,3/33,3/33,3 % —los
 *       cortes están en 0,33 y 0,67 y el valor está dentro de la muestra—, con IC binomial
 *       alrededor. Una desviación que EXCEDA su IC es bug o artefacto, no tolerancia.
 *
 *  A2 · UNIFORMIDAD DEL RANGO (más fina que A1). Si el reparto es por terciles, el
 *       histograma de DECILES de `width_pctile` debe ser plano al 10 %. Los tres buckets
 *       pueden cuadrar por compensación y el rango seguir sesgado; los deciles no.
 *
 *  A3 · CONTROL i.i.d. POR MONTE CARLO (descomposición: ¿está en los datos o lo mete la
 *       construcción?).
 *       Se repite todo sobre retornos gaussianos i.i.d. con volatilidad CONSTANTE. Ahí no
 *       hay agrupamiento de volatilidad que explique nada: si el control también se desvía,
 *       la desviación la produce la GEOMETRÍA del estimador (ventanas de 20 solapadas + el
 *       rango del ÚLTIMO elemento), y sería un artefacto presente hasta en un mundo
 *       perfectamente estacionario. Si el control sale plano y el mercado no, la desviación
 *       es real y es agrupamiento de volatilidad.
 *
 *       (Nota: barajar la serie NO sirve como control — los cuantiles y el rango son
 *       función del MULTICONJUNTO, no del orden, así que la etiqueta no cambiaría.)
 *
 * Método: ventana de producción EXACTA por TF (1h=168, 4h=180, 1D=90, 1W=52 cierres, ver
 * `coingeckoService.TF_LIMIT`), rodada sobre el histórico. Se llama a la función REAL.
 *
 * SOLO LECTURA. No abre la BBDD. Binance público, sin API keys.
 *
 * Uso: node scripts/auditVolatilityState.mjs   ·   COINS=SOL TFS=4h node scripts/...
 */

import { calculateBollingerBands } from '../src/utils/indicators.js';

const blank = () => ({ squeeze: 0, normal: 0, expansion: 0, n: 0, deciles: new Array(10).fill(0), nullLabel: 0 });

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',');
const TFS = (process.env.TFS ?? '1h,4h,1D,1W').split(',');
const BINANCE_TF = { '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w' };
const TF_LIMIT = { '1h': 168, '4h': 180, '1D': 90, '1W': 52 };   // = coingeckoService.TF_LIMIT
const INDEP_TARGET = Number(process.env.INDEP_TARGET ?? 120);   // anclas SIN solape buscadas
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 22);
const MC_PATHS = Number(process.env.MC_PATHS ?? 1500);          // caminos i.i.d. independientes
const LABELS = ['squeeze', 'normal', 'expansion'];

/**
 * ⚠️ INDEPENDENCIA. Dos ventanas consecutivas comparten `win-1` de sus `win` cierres, así
 * que rodar el ancla vela a vela NO produce observaciones independientes: el n efectivo es
 * del orden de `anclas/win`, no de `anclas`. Un IC binomial sobre las anclas solapadas sale
 * ~13× demasiado estrecho, y leerlo como si fuera real es lo que convierte ruido de
 * estimación en "desviaciones". Por eso aquí se reportan las DOS cosas: el punto sobre
 * todas las anclas (estimador de máxima precisión) y el IC sobre anclas SEPARADAS por una
 * ventana completa (sin solape), que es el único que se puede leer.
 */
async function klines(symbol, interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => +x[4]);            // solo cierres: es lo que consume BB
}

/** Igual pero devuelve la kline completa (hace falta el `t` para paginar hacia atrás). */
async function klinesFull(symbol, interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}`
    + `&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol}/${interval}: HTTP ${r.status}`);
  return await r.json();
}

/** Histórico profundo paginando hacia atrás con `endTime` (máx. 1000 velas por petición). */
async function fetchDeep(symbol, interval, want) {
  const out = [];
  let endTime;
  for (let i = 0; i < MAX_PAGES && out.length < want; i++) {
    const batch = await klinesFull(symbol, interval, 1000, endTime);
    if (!batch.length) break;
    out.unshift(...batch.map((x) => ({ t: x[0], close: +x[4] })));
    endTime = batch[0][0] - 1;             // justo antes de la vela más antigua recibida
    if (batch.length < 1000) break;
  }
  return out;
}

/**
 * Réplica del muestreo REAL de producción: el cron A dispara 2 veces al día a hora fija
 * (08:05 y 20:05 UTC, 5 min tras el cierre de la vela 4h). O sea que producción NO ve el
 * indicador en instantes al azar: lo ve siempre a la misma hora del día. Si la anchura de
 * Bollinger tuviera estacionalidad horaria, el reparto que ve producción NO sería el
 * reparto general — y la etiqueta significaría otra cosa de la que dice.
 */
function tallyAtHours(rows, win, hoursUtc) {
  const t = blank();
  for (let end = win; end <= rows.length; end++) {
    const h = new Date(rows[end - 1].t).getUTCHours();
    if (!hoursUtc.includes(h)) continue;
    const bb = calculateBollingerBands(rows.slice(end - win, end).map((r) => r.close));
    if (!bb?.volatility_state) { t.nullLabel++; continue; }
    t[bb.volatility_state]++; t.n++;
    if (Number.isFinite(bb.width_pctile)) t.deciles[Math.min(9, Math.floor(bb.width_pctile / 10))]++;
  }
  return t;
}

/** Rueda la ventana de producción y tabula la etiqueta y el decil del percentil. */
function tally(closes, win, step = 1) {
  const t = { squeeze: 0, normal: 0, expansion: 0, n: 0, deciles: new Array(10).fill(0), nullLabel: 0 };
  for (let end = win; end <= closes.length; end += step) {
    const bb = calculateBollingerBands(closes.slice(end - win, end));
    if (!bb) continue;
    if (bb.volatility_state == null) { t.nullLabel++; continue; }
    t[bb.volatility_state]++;
    t.n++;
    if (Number.isFinite(bb.width_pctile)) {
      t.deciles[Math.min(9, Math.floor(bb.width_pctile / 10))]++;
    }
  }
  return t;
}

/** Serie sintética: retornos gaussianos i.i.d., volatilidad CONSTANTE (control A3). */
function synthetic(n, sigma = 0.01, seed = 42) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const gauss = () => {
    const u = Math.max(rnd(), 1e-12), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp(sigma * gauss()));
  return out;
}

// IC binomial de Wald al 95 % — basta para decidir si una desviación cabe en el ruido.
const ci95 = (k, n) => (n ? 1.96 * Math.sqrt((k / n) * (1 - k / n) / n) * 100 : null);
const pct = (k, n) => (n ? (k / n) * 100 : null);

function line(label, t) {
  const parts = LABELS.map((l) => {
    const p = pct(t[l], t.n), m = ci95(t[l], t.n);
    const off = Math.abs(p - 100 / 3) > m ? '*' : ' ';
    return `${l.padEnd(9)} ${p.toFixed(1).padStart(5)}%±${m.toFixed(1)}${off}`;
  });
  return `    ${label.padEnd(14)} n=${String(t.n).padStart(4)}  ${parts.join('  ')}`;
}

console.log('AUDITORÍA DE `volatility_state` (Bollinger, terciles de su propia serie)');
console.log('ANCLA: 33,3 / 33,3 / 33,3 % por construcción (lowP=0.33, highP=0.67, valor incluido).');
console.log('Dos lecturas por fila: TODAS las anclas (solapadas → punto preciso, IC NO leíble)');
console.log('y las anclas SIN SOLAPE (separadas una ventana entera → IC honesto).\n');


const add = (dst, src) => {
  for (const l of LABELS) dst[l] += src[l];
  dst.n += src.n; dst.nullLabel += src.nullLabel;
  src.deciles.forEach((d, i) => { dst.deciles[i] += d; });
};

const aggAll = blank();
const aggIndep = blank();
const aggProd = blank();
const aggNull = blank();

for (const tf of TFS) {
  const win = TF_LIMIT[tf];
  console.log(`${'═'.repeat(88)}\nTF ${tf} · ventana de producción ${win} cierres`);
  for (const coin of COINS) {
    try {
      const rowsRaw = await fetchDeep(coin, BINANCE_TF[tf], win * (INDEP_TARGET + 1));
      const closes = rowsRaw.map((r) => r.close);
      if (closes.length < win + 20) { console.log(`  ${coin}: histórico insuficiente (${closes.length})`); continue; }
      const all = tally(closes, win, 1);
      // ⚠️ FASE. `step = win` deja TODAS las anclas en la misma posición del ciclo: en 1h,
      // win=168 son EXACTAMENTE 7 días, así que cada ancla cae en el mismo día y hora de
      // la semana. Como la volatilidad cripto tiene estacionalidad semanal (fin de semana
      // plano), eso no mide el reparto: mide el fin de semana. `step = win+1` mantiene la
      // independencia (bloques disjuntos) y hace DERIVAR la fase.
      const locked = tally(closes, win, win);
      const indep = tally(closes, win, win + 1);
      console.log(line(`${coin} solapadas`, all));
      console.log(line(`${coin} fase fija`, locked));
      console.log(line(`${coin} SIN solape`, indep));
      add(aggAll, all); add(aggIndep, indep);
      if (tf === '1h') { add(aggProd, tallyAtHours(rowsRaw, win, [8, 20])); }
    } catch (e) { console.log(`  ${coin}: ${e.message}`); }
  }
}

console.log(`\n${'═'.repeat(88)}\nA1 · AGREGADO (${COINS.join('+')} × ${TFS.join('/')})`);
console.log(line('solapadas', aggAll));
console.log(line('SIN SOLAPE', aggIndep) + '   ← el único IC leíble');

console.log(line('MUESTREO PRODUCCIÓN 1h (08/20 UTC)', aggProd));
console.log('\nA2 · UNIFORMIDAD DEL RANGO — deciles de `width_pctile`, anclas SIN solape (ancla: 10 %)');
console.log('    ' + aggIndep.deciles.map((d, i) => `${i * 10}-${i * 10 + 10}: ${pct(d, aggIndep.n).toFixed(1)}%`).join('  '));

console.log(`\nA3 · NULO POR MONTE CARLO — ${MC_PATHS} caminos i.i.d. INDEPENDIENTES por TF (vol constante).`);
console.log('     Una etiqueta por camino ⇒ observaciones realmente independientes. Aísla la');
console.log('     GEOMETRÍA del estimador: si aquí sale 33/34/33, el sesgo de mercado es de los datos.');
for (const tf of TFS) {
  const win = TF_LIMIT[tf];
  const t = blank();
  for (let k = 0; k < MC_PATHS; k++) {
    const bb = calculateBollingerBands(synthetic(win, 0.01, 1000 + k * 7919));
    if (!bb?.volatility_state) { t.nullLabel++; continue; }
    t[bb.volatility_state]++; t.n++;
    if (Number.isFinite(bb.width_pctile)) t.deciles[Math.min(9, Math.floor(bb.width_pctile / 10))]++;
  }
  console.log(line(`nulo ${tf}`, t));
  add(aggNull, t);
}
// El mismo histograma de A2 sobre el nulo: separa "lo concentra el mercado" de "lo
// concentra la geometría del estimador".
console.log('    deciles del nulo: ' + aggNull.deciles.map((d, i) => `${i * 10}-${i * 10 + 10}: ${pct(d, aggNull.n).toFixed(1)}%`).join('  '));
