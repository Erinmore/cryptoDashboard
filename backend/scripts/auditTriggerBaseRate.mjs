/**
 * auditTriggerBaseRate.mjs — tasa base del gatillo de un shadow trade.
 *
 * POR QUÉ. `summarizeShadowTrades` reporta `trigger_rate_pct` ("¿las condiciones que el
 * sistema nombra llegan a darse?") y hasta ahora era un número suelto: exactamente la misma
 * clase de cifra que era `offered_pct` antes de `OPPORTUNITY_BASE_RATE`. Si el precio alcanza
 * esa distancia en esa dirección y en esa ventana tan a menudo como en un instante CUALQUIERA,
 * que el gatillo se dé no dice nada sobre el criterio del sistema. Lo que refuta o confirma es
 * el LIFT contra la tasa base, no el porcentaje absoluto.
 *
 * EL HALLAZGO QUE LO HACE BARATO. Se creía que la tasa base había que medirla "por
 * condicional" porque depende de la geometría (distancia × vigencia). Medido: **no**. Al
 * normalizar la distancia por `ATR% × √velas` la tasa COLAPSA — 24h y 48h coinciden fila a
 * fila dentro de 1-2 puntos. O sea que es una CURVA DE UNA VARIABLE, medible una vez y
 * enviada como constante con su `measured_at`, igual que `OPPORTUNITY_BASE_RATE`.
 *
 * Es el mismo razonamiento de √t con el que se fijaron los pares de oportunidad por horizonte
 * (24h 2×/1×, 7d 4×/1×) y la banda del Derivatives Score (0,5×ATR%×√n).
 *
 * DEFINICIÓN DEL EJE — importa que sea LA MISMA en la tabla y en la búsqueda:
 *
 *     d = |entry_price − price_current| / (atr_pct × √validity_candles)
 *
 * `atr_pct` es el de **`analysis_outcome.atr_pct_at_analysis`**: ATR de Wilder(14) sobre las
 * `ATR_PERIOD+5 = 19` velas CERRADAS antes del análisis, del TF primario. Se eligió ese y no
 * el `components.atr_pct` de la ruta de decisión (ventana de 180) por una razón práctica: el
 * primero está persistido RETROACTIVAMENTE para todas las filas y el segundo solo desde el
 * 2026-08-01. Para una tasa base da igual qué ATR sea mientras tabla y consumidor usen el
 * mismo — lo que no vale es mezclarlos.
 *
 * ⚠️ SE MIDE LA GEOMETRÍA, NO EL GATILLO TEXTUAL. Igual que el evaluador: "¿tocó el precio la
 * entrada?", no "¿hubo un cierre de 4h más allá de X?". Es la referencia correcta porque es
 * exactamente lo que `evaluateShadowTrade` cuenta como disparo (`SHADOW_FILL_RULE`).
 *
 * NOTA SOBRE EL RANGO ÚTIL. La curva se aplana por arriba (d>1 → tasas de un dígito) y por
 * abajo tiende a 100 %: un condicional con la entrada pegada al precio dispara casi seguro y
 * su lift no significa nada. Los cortes de la rejilla se eligen para cubrir el rango en que
 * los condicionales reales caen (los 7 primeros de producción están en d≈0,4).
 *
 * SOLO LECTURA: no toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditTriggerBaseRate.mjs
 *       COINS=SOL node scripts/auditTriggerBaseRate.mjs
 */

import { calculateATR } from '../src/utils/indicators.js';
import { wilsonInterval } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const ATR_PERIOD = 14;
const ATR_WINDOW = ATR_PERIOD + 5;         // outcomeService.js:58 — misma ventana
/** Rejilla del eje: distancia normalizada por ATR%×√velas. */
const GRID = [0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1.0, 1.25];
/** Vigencias en velas del TF primario (4h): 24h y 48h. Sirven para comprobar el colapso. */
const VALIDITIES = [6, 12];
const MIN_N = 100;                          // por debajo, la celda no se reporta

async function klines(coin, interval = '4h', limit = 1000) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${coin}USDT&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`Binance ${coin} ${interval}: HTTP ${r.status}`);
  return (await r.json()).map((x) => ({
    t: x[0], open: +x[1], high: +x[2], low: +x[3], close: +x[4],
  }));
}

/** Reproduce `atr_pct_at_analysis`: Wilder(14) sobre las 19 velas cerradas previas. */
function atrPctAt(candles, i) {
  const w = candles.slice(Math.max(0, i - ATR_WINDOW + 1), i + 1);
  if (w.length < ATR_WINDOW) return null;
  const atr = calculateATR(w, ATR_PERIOD);
  const close = w.at(-1).close;
  if (!Number.isFinite(atr) || !(close > 0)) return null;
  return parseFloat((atr / close * 100).toFixed(2));   // mismo redondeo que computeAtrPct
}

async function auditCoin(coin) {
  const k = await klines(coin);
  const anchors = [];
  for (let i = ATR_WINDOW - 1; i < k.length; i++) {
    const atr = atrPctAt(k, i);
    if (atr && atr > 0) anchors.push({ i, close: k[i].close, atr });
  }

  /** ¿Tocó el precio la entrada a distancia `d` normalizada, dentro de `v` velas? */
  const rate = (d, v, dir) => {
    let hits = 0, n = 0;
    for (const a of anchors) {
      if (a.i + v >= k.length) continue;
      const movePct = d * a.atr * Math.sqrt(v);
      const target = a.close * (1 + (dir === 'long' ? movePct : -movePct) / 100);
      const w = k.slice(a.i + 1, a.i + 1 + v);
      n++;
      if (dir === 'long'
        ? Math.max(...w.map((c) => c.high)) >= target
        : Math.min(...w.map((c) => c.low)) <= target) hits++;
    }
    return { pct: n ? (hits / n) * 100 : null, n, hits };
  };

  console.log(`\n${'═'.repeat(74)}\n${coin}\n${'═'.repeat(74)}`);
  console.log('  d      long 24h  long 48h  |  short 24h  short 48h  |  |Δ| máx 24h-48h');
  console.log('  ' + '-'.repeat(70));
  const out = {};
  for (const d of GRID) {
    const cells = {};
    for (const v of VALIDITIES) for (const dir of ['long', 'short']) cells[`${dir}${v}`] = rate(d, v, dir);
    if (Object.values(cells).some((c) => c.n < MIN_N)) continue;
    const dl = Math.abs(cells.long6.pct - cells.long12.pct);
    const ds = Math.abs(cells.short6.pct - cells.short12.pct);
    console.log(`  ${d.toFixed(2)}  ${cells.long6.pct.toFixed(1).padStart(8)}% ${cells.long12.pct.toFixed(1).padStart(8)}%  |`
      + ` ${cells.short6.pct.toFixed(1).padStart(9)}% ${cells.short12.pct.toFixed(1).padStart(9)}%  |`
      + ` ${Math.max(dl, ds).toFixed(1).padStart(6)} pt`);
    // Se promedian las dos vigencias: si colapsan, promediarlas estrecha el IC sin sesgar.
    out[d] = {
      long: (cells.long6.pct + cells.long12.pct) / 2,
      short: (cells.short6.pct + cells.short12.pct) / 2,
      n: cells.long6.n + cells.long12.n,
    };
  }
  return { coin, out };
}

const results = [];
for (const coin of COINS) {
  try { results.push(await auditCoin(coin)); }
  catch (e) { console.error(`${coin}: ${e.message}`); }
}

if (results.length) {
  console.log(`\n${'═'.repeat(74)}\nTABLA AGREGADA — media de las ${results.length} monedas\n${'═'.repeat(74)}`);
  console.log('  d       long    short   |  dispersión entre monedas (long / short)');
  console.log('  ' + '-'.repeat(66));
  const table = {};
  for (const d of GRID) {
    const ls = results.map((r) => r.out[d]?.long).filter(Number.isFinite);
    const ss = results.map((r) => r.out[d]?.short).filter(Number.isFinite);
    if (ls.length !== results.length) continue;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const spread = (a) => Math.max(...a) - Math.min(...a);
    table[d] = { long: parseFloat(avg(ls).toFixed(1)), short: parseFloat(avg(ss).toFixed(1)) };
    console.log(`  ${d.toFixed(2)}  ${avg(ls).toFixed(1).padStart(6)}%  ${avg(ss).toFixed(1).padStart(6)}%   |`
      + `  ${spread(ls).toFixed(1).padStart(4)} pt / ${spread(ss).toFixed(1).padStart(4)} pt`);
  }
  const n0 = results[0].out[GRID.find((d) => results[0].out[d])]?.n ?? 0;
  console.log(`\n  n por celda y moneda ≈ ${n0} anclajes (2 vigencias combinadas)`);
  const w = wilsonInterval(Math.round(n0 * 0.5), n0);
  console.log(`  IC95 de una tasa del 50 % con ese n: [${w.low}-${w.high}] → ±${((w.high - w.low) / 2).toFixed(1)} pt\n`);
  console.log('  ── Para pegar en utils/stats.js ──');
  console.log(`  points: ${JSON.stringify(table)},`);
  console.log(`  measured_at: '${new Date().toISOString().slice(0, 10)}',`);
  console.log(`  source: 'scripts/auditTriggerBaseRate.mjs · 90d · ${COINS.join('/')} · TF 4h · fill=touch_entry_intrabar',`);
}
