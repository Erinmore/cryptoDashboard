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
 * ── M4 (2026-08-04) · POR QUÉ LA VENTANA DEL ATR ES AHORA UN PARÁMETRO ──────────────────
 *
 * **B1** quiere unificar los dos ATR% del sistema dejando SOLO el de decisión (Wilder(14) con
 * la ventana de 180 velas que usa `indicatorService`) y retirando la reconstrucción de 19 que
 * hace el outcome job. Esta tabla se midió con el de 19, así que **si B1 entra sin re-medir,
 * la curva y su eje dejarían de ser pareja** — que es exactamente el fallo que la cabecera de
 * `TRIGGER_BASE_RATE` avisa ("da igual cuál sea mientras tabla y consumidor usen el mismo; lo
 * que no vale es mezclarlos").
 *
 * `ATR_WINDOW` por defecto sigue siendo 19: el script reproduce sin tocar nada la tabla
 * publicada. `ATR_WINDOW=180` mide el eje unificado. Comparar las dos salidas ES M4.
 *
 * ▶ RESULTADO M4 (2026-08-04): **la tabla NO hay que re-medirla para B1.**
 *
 *   · CONTROL previo — con `ATR_WINDOW=19` por defecto la salida REPRODUCE la tabla publicada
 *     el 2026-08-01 dentro de ±0,7 pt (73,5/74,1 · 61,5/62,2 · 50,7/52,4 · 41,6/44,6 · …)
 *     pese a que la ventana de 1.000 velas ha rodado tres días. El arnés mide lo que dice.
 *
 *   · **⚠️ EL PRIMER INTENTO FUE UN CONFUNDIDO, y por poco pasa.** Comparadas las dos ramas
 *     tal cual, la curva de 180 caía hasta **−3,3 pt** en `long` y no se movía en `short` —
 *     una asimetría con pinta de hallazgo. No lo era: con 180 el primer anclaje con ventana
 *     completa llega 161 velas más tarde, así que las dos ramas medían **PERIODOS distintos**
 *     (982 anclajes contra 821). De ahí `ANCHOR_START`, que iguala el conjunto de anclajes.
 *
 *   · Con anclajes IDÉNTICOS (n=1.624/moneda), 19 → 180 mueve la curva **≤1,1 pt en las 16
 *     celdas**, siempre a la baja y de forma monótona en `d`: dentro del IC (±2,4 pt, y ése
 *     ya es optimista por el solape de anclajes). O sea que **de los −3,3 pt originales, −0,9
 *     eran el ATR y −2,4 el periodo.** Replica el ≤1,6 pt que ya anotaba `TARGET_REACHABILITY`
 *     al comprobar lo mismo por su cuenta: `d` normaliza por el mismo ATR con el que se
 *     construye la distancia, así que la elección se cancela casi entera.
 *
 *   · **Lo que B1 SÍ mueve, y conviene tenerlo escrito:** en un setup REAL la entrada tiene un
 *     precio fijo, así que lo que se desplaza es `d`. Medido el cociente ATR180/ATR19 sobre
 *     los mismos anclajes: **mediana 1,008-1,010 · p10-p90 0,91-1,14** en las 3 monedas. En la
 *     mediana el efecto es ~0,4 pt de `P(disparo)` mostrada; en las colas, hasta ~4 pt. Acotado
 *     y pequeño, pero no cero: B1 cambia el número que ve el usuario en análisis concretos
 *     aunque la tabla se quede igual.
 *
 * ⚠️ EL `n` QUE IMPRIME NO ES EFECTIVO. Los anclajes son cada vela de 4h y el horizonte son
 * 6-12 velas, así que ventanas consecutivas comparten 5/6 de su futuro: el IC de Wilson de
 * abajo sale demasiado estrecho. Sirve para comparar celdas entre sí (todas comparten el
 * sesgo), no para afirmar una precisión absoluta.
 *
 * SOLO LECTURA: no toca BBDD, producción ni la ruta de decisión.
 *
 * Uso:  node scripts/auditTriggerBaseRate.mjs
 *       COINS=SOL node scripts/auditTriggerBaseRate.mjs
 *       ATR_WINDOW=180 node scripts/auditTriggerBaseRate.mjs    # M4: eje de DECISIÓN
 */

import { calculateATR } from '../src/utils/indicators.js';
import { wilsonInterval } from '../src/utils/stats.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim());
const ATR_PERIOD = 14;
/**
 * Velas que entran en el cálculo del ATR. 19 (= ATR_PERIOD+5) reproduce
 * `atr_pct_at_analysis` (outcomeService.js:58); 180 reproduce el ATR de DECISIÓN
 * (`technical['4h'].atr.pct`, que `indicatorService` calcula sobre TODAS las velas del TF).
 * El de Wilder es recursivo: con más calentamiento el número es OTRO, no más preciso.
 */
const ATR_WINDOW = Number(process.env.ATR_WINDOW ?? ATR_PERIOD + 5);
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

/** ATR% en el anclaje `i`: Wilder(14) sobre las `ATR_WINDOW` velas cerradas previas. */
function atrPctAt(candles, i) {
  const w = candles.slice(Math.max(0, i - ATR_WINDOW + 1), i + 1);
  if (w.length < ATR_WINDOW) return null;
  const atr = calculateATR(w, ATR_PERIOD);
  const close = w.at(-1).close;
  if (!Number.isFinite(atr) || !(close > 0)) return null;
  return parseFloat((atr / close * 100).toFixed(2));   // mismo redondeo que computeAtrPct
}

/**
 * Primer anclaje. Por defecto el primero para el que hay ventana de ATR completa — pero eso
 * hace que dos ejecuciones con `ATR_WINDOW` distinto midan PERIODOS distintos (con 180 se
 * pierden 161 velas por delante frente a 19), y entonces cualquier diferencia entre las dos
 * salidas mezcla "otro ATR" con "otros días". Fijarlo iguala el conjunto de anclajes y deja
 * la ventana del ATR como única variable — el control que M4 necesita para ser interpretable.
 */
const ANCHOR_START = Number(process.env.ANCHOR_START ?? ATR_WINDOW - 1);

async function auditCoin(coin) {
  const k = await klines(coin);
  const anchors = [];
  for (let i = Math.max(ATR_WINDOW - 1, ANCHOR_START); i < k.length; i++) {
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

  console.log(`\n${'═'.repeat(74)}\n${coin}  ·  ATR Wilder(${ATR_PERIOD}) sobre ${ATR_WINDOW} velas`
    + `  ·  ${anchors.length} anclajes de ${k.length} velas 4h\n${'═'.repeat(74)}`);
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
  console.log(`  source: 'scripts/auditTriggerBaseRate.mjs · ${COINS.join('/')} · TF 4h`
    + ` · ATR Wilder(${ATR_PERIOD})/${ATR_WINDOW} velas · fill=touch_entry_intrabar',`);
}
