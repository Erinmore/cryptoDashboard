#!/usr/bin/env node
/**
 * diffAnalyzeContext.mjs — B5: el refactor de `buildAnalyzeContext`, ¿preserva el payload?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTE ARNÉS Y NO "PASAN LOS TESTS"
 *
 * La ficha de B5 lo dice explícitamente: **no basta con que pasen los tests**. Mockean el LLM
 * y no cubren la forma completa del payload, así que un campo que desaparece, cambia de nombre
 * o pasa a `null` sale verde. Sin un diff del payload real, un cambio de la ruta de decisión
 * disfrazado de refactor pasa desapercibido.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * POR QUÉ SE COMPARA EN EL MISMO PROCESO Y NO ANTES/DESPUÉS DE DESPLEGAR
 *
 * Un `curl` antes del despliegue y otro después compara **dos instantes de mercado
 * distintos**: el precio se mueve, los indicadores con él, y prácticamente todos los campos
 * difieren por motivos legítimos. En ese ruido no se distingue una regresión.
 *
 * Aquí se llaman las DOS versiones —la refactorizada y una copia literal de la anterior
 * sacada de git (`LEGACY=...`)— **en el mismo proceso y una detrás de otra**, con la caché de
 * servicios ya caliente por la primera llamada. Así la segunda reutiliza los mismos datos y
 * cualquier diferencia es o una regresión o una fuente que cambió entre medias — y esto último
 * se distingue porque afecta a los campos de un servicio entero, no a uno suelto.
 *
 * ⚠️ ORDEN DELIBERADO: se llama primero a la línea base. Así la versión nueva corre siempre con
 * la caché caliente y, si aun así apareciera una diferencia, no puede ser porque la nueva
 * pidiera datos frescos que la vieja no vio.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 * QUÉ COMPARA
 *
 *   1. **Conjunto de RUTAS** (todas las claves anidadas). Es la comprobación fuerte: caza un
 *      campo perdido, renombrado o añadido, que es el riesgo real de un refactor de ensamblado.
 *   2. **Valores**, ruta a ruta. Se clasifican en:
 *        · idénticos
 *        · VOLÁTILES conocidos (marcas de tiempo y el reloj) — se listan, no se cuentan como fallo
 *        · **INESPERADOS** — cualquier otro. Uno solo invalida el refactor.
 *
 * ▶ RESULTADO B5 (2026-08-04): **DIFF LIMPIO**, en local y en la Pi contra el .env de
 * producción, para SOL/BTC/ETH: **conjunto de rutas IDÉNTICO** (1.008 / 1.071 / 1.063) y
 * **0 diferencias de valor inesperadas**. Más 815/815 tests. El refactor preserva el payload.
 *
 * ⚠️ Y el camino hasta ese "limpio" tuvo dos trampas, las dos cazadas por controles:
 *   1. **7 diferencias en `order_book`** que parecían regresión. El CONTROL NULO dio **12** en
 *      ese mismo bloque → suelo de ruido de una fuente sin caché, no regresión.
 *   2. **El diff pasaba por vacío sobre CVD y VWAP.** Sin `initDb()`, `loadSeries` no puede
 *      abrir la BBDD, captura el error y devuelve `[]`: las dos versiones daban `null` y
 *      "coincidían" sin haber ejecutado esa rama. De ahí la línea de COBERTURA, que obliga al
 *      arnés a declarar sobre qué NO ha comprobado nada.
 *   3. En la Pi, un **429 de Coinalyze** por martillear la API con seis llamadas seguidas dejó
 *      a ETH sin bloques de derivados y produjo 4 diferencias; aislado y con el límite ya
 *      liberado, ETH da 0. El `onchain` nulo en la Pi es el mismo efecto (cuota free de 15
 *      req/día que consume el proceso de producción) — verificado en BBDD que los análisis
 *      REALES de BTC sí llevan on-chain (`mvrv=1,2131`).
 *
 * SOLO LECTURA: no escribe en BBDD, no llama al LLM, no despliega nada.
 *
 * Uso (idealmente EN LA PI, contra el .env de producción):
 *   node scripts/diffAnalyzeContext.mjs                        # control nulo: suelo de ruido
 *   LEGACY=./lib/legacyAnalyzeContext.mjs node scripts/...     # comparar contra una versión previa
 *   COINS=SOL TF=1h node scripts/diffAnalyzeContext.mjs
 */

import {
  fetchAnalyzeSources, computeTechnicalByTf, buildBtcContext, assembleAnalyzeContext,
} from '../src/controllers/analysisController.js';
import { getHistories } from '../src/services/historyService.js';
import { initDb } from '../src/config/db.js';

/**
 * ⚠️ SIN ESTO EL DIFF PASABA POR VACÍO SOBRE MEDIO PAYLOAD, y no daba ningún aviso.
 *
 * `getCoinHistory` hidrata CVD y VWAP desde `history_series` llamando a `loadSeries`, que a su
 * vez usa `getDb()` — y `getDb()` LANZA si la BBDD no está inicializada, cosa que en un script
 * suelto nunca ocurre porque la inicializa `app.js`. `loadSeries` captura ese error y devuelve
 * `[]`, así que las dos versiones producían `volume_history.cvd = null` y coincidían... por no
 * haber ejecutado esa rama. Comprobado: sin `initDb()`, `cvd` y `vwap` salen con 0 entradas.
 *
 * Los otros cinco históricos NO tienen este problema: los alimentan como efecto colateral los
 * propios `fetch*` del payload (medido: 30 / 8 / 42 / 168 / 7 entradas tras la primera llamada).
 */
initDb();

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const TF = process.env.TF ?? '4h';
/**
 * Módulo con la versión ANTERIOR a comparar, si la hay. Se pasa por env porque una línea base
 * sólo existe mientras dura un refactor concreto: se extrae de git, se usa, y se borra.
 *
 * Sin `LEGACY`, el script corre en **CONTROL NULO**: compara el pipeline ACTUAL contra sí
 * mismo, dos llamadas seguidas. Eso mide el SUELO DE RUIDO del payload, y por sí solo ya es
 * útil — es lo que demostró que las 7 diferencias de `order_book` del refactor B5 no eran
 * regresión sino la fuente: `binanceOrderBookService` **no cachea**, así que cada llamada trae
 * un libro distinto, y el control nulo dio **12** diferencias en ese mismo bloque, más que el
 * refactor. Sin ese control la tentación habría sido declararlas volátiles "porque se ve que
 * lo son", que es justo el razonamiento que este proyecto no acepta.
 *
 * Para volver a usarlo en el siguiente refactor: extraer la función anterior de git a un
 * módulo que exporte `buildAnalyzeContextLegacy(coin, tf)` y pasar su ruta en `LEGACY`.
 */
const LEGACY_PATH = process.env.LEGACY ?? null;
const legacyFn = LEGACY_PATH
  ? (await import(LEGACY_PATH)).buildAnalyzeContextLegacy
  : null;
const SELF = !legacyFn;

/**
 * Rutas cuyo valor DEBE poder diferir entre dos llamadas seguidas: son sellos de tiempo del
 * propio momento de construcción, no datos de mercado. Se listan explícitamente — un "ignora
 * lo que cambie" convertiría el diff en decorado.
 */
const VOLATILE = [
  /^price_timestamp_utc$/,
  /^derivatives_score\.measured_at$/,       // constante, pero viaja con la rúbrica
  /\.data_lag_days$/,
  /\.data_freshness$/,
  // ⚠️ `order_book` NO está aquí "porque se ve que cambia": está porque el CONTROL NULO lo
  // midió. `binanceOrderBookService` es el único servicio SIN caché, así que cada llamada
  // trae un libro distinto. En el CONTROL NULO (sin `LEGACY`) salen **12 diferencias, las
  // 12 en este bloque** — más que las 7 que daba el refactor, o sea que el refactor queda por
  // DEBAJO del suelo de ruido de la propia fuente. Sin ese control, estas 7 eran
  // indistinguibles de una regresión.
  /^order_book\./,
];
const isVolatile = (p) => VOLATILE.some((re) => re.test(p));

/** Todas las rutas hoja de un objeto, en notación `a.b[0].c`. */
function paths(obj, prefix = '', out = new Map()) {
  if (obj === null || typeof obj !== 'object') { out.set(prefix, obj); return out; }
  if (Array.isArray(obj)) {
    if (!obj.length) out.set(`${prefix}[]`, '<vacío>');
    obj.forEach((v, i) => paths(v, `${prefix}[${i}]`, out));
    return out;
  }
  const keys = Object.keys(obj);
  if (!keys.length) out.set(`${prefix}{}`, '<vacío>');
  for (const k of keys) paths(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

const same = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a === b : Object.is(a, b));

let totalUnexpected = 0;

console.log('═'.repeat(96));
console.log('B5 · DIFF DEL PAYLOAD — refactor de `buildAnalyzeContext` (¿preserva comportamiento?)');
console.log(`monedas ${COINS.join(', ')} · TF primario ${TF}`);
console.log(SELF
  ? 'MODO CONTROL NULO (sin LEGACY): el pipeline ACTUAL contra sí mismo → suelo de ruido.'
  : `Línea base: ${LEGACY_PATH}. Se llama primero a ella; la nueva corre con la caché caliente.`);
console.log('═'.repeat(96));

for (const coin of COINS) {
  console.log(`\n${'─'.repeat(96)}\n${coin}`);
  let legacy, next;
  // Mismo pipeline que `buildAnalyzeContext`, escrito aquí a propósito: si el diff llamara a
  // `buildAnalyzeContext` no distinguiría un refactor real de una función que sigue delegando
  // en la versión vieja. Comparar las ETAPAS es lo que hace la comprobación honesta.
  const current = async () => {
    const sources = await fetchAnalyzeSources(coin);
    const technical = computeTechnicalByTf(sources.candles, sources.price?.price ?? null);
    const btcContext = await buildBtcContext(coin, technical);
    const histories = getHistories(coin);
    return assembleAnalyzeContext({ coin, primaryTf: TF, sources, technical, btcContext, histories });
  };
  try {
    // Primero la línea base, para que la versión nueva corra con la caché ya caliente: si aun
    // así apareciera una diferencia, no puede ser porque la nueva pidiera datos más frescos.
    legacy = legacyFn ? await legacyFn(coin, TF) : await current();
    next = await current();
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    totalUnexpected++;
    continue;
  }

  // ── 0 · COBERTURA ──────────────────────────────────────────────────────────
  // Un diff que compara dos `null` "coincide" sin haber ejecutado nada. Se declara qué
  // bloques venían con dato para que un pase vacío no se lea como un pase.
  const blocks = {
    technical: Object.keys(legacy.technical ?? {}).length,
    fear_greed_history: legacy.sentiment?.fear_greed_history,
    funding_history: legacy.derivatives?.funding_rate?.history,
    oi_history: legacy.derivatives?.open_interest?.history,
    lsr_history: legacy.derivatives?.long_short_ratio?.history,
    liq_history: legacy.derivatives?.liquidations_24h?.history,
    cvd: legacy.volume_history?.cvd,
    vwap: legacy.volume_history?.vwap,
    onchain: legacy.onchain?.available === false ? null : legacy.onchain,
    etf_flows: legacy.etf_flows?.available === false ? null : legacy.etf_flows,
    macro: legacy.macro,
    volatility: legacy.volatility,
    order_book: legacy.order_book,
    clusters: legacy.derivatives?.liquidation_clusters,
    btc_context: legacy.btc_context,
  };
  const vacios = Object.entries(blocks).filter(([, v]) => v == null || v === 0).map(([k]) => k);
  console.log(`  cobertura: ${Object.keys(blocks).length - vacios.length}/${Object.keys(blocks).length} bloques con dato`
    + (vacios.length ? `  ⚠️ SIN EJERCITAR: ${vacios.join(', ')}` : '  ✓ todos ejercitados'));

  const a = paths(legacy);
  const b = paths(next);

  // ── 1 · Conjunto de rutas ──────────────────────────────────────────────────
  const onlyA = [...a.keys()].filter((k) => !b.has(k));
  const onlyB = [...b.keys()].filter((k) => !a.has(k));
  console.log(`  rutas: ${a.size} antes · ${b.size} después`);
  if (onlyA.length) { console.log(`  ⛔ ${onlyA.length} rutas PERDIDAS:`); onlyA.slice(0, 25).forEach((k) => console.log(`       − ${k}`)); }
  if (onlyB.length) { console.log(`  ⛔ ${onlyB.length} rutas NUEVAS:`); onlyB.slice(0, 25).forEach((k) => console.log(`       + ${k}`)); }
  if (!onlyA.length && !onlyB.length) console.log('  ✓ conjunto de rutas IDÉNTICO');
  totalUnexpected += onlyA.length + onlyB.length;

  // ── 2 · Valores ────────────────────────────────────────────────────────────
  const diffs = [];
  for (const [k, v] of a) if (b.has(k) && !same(v, b.get(k))) diffs.push([k, v, b.get(k)]);
  const volatile = diffs.filter(([k]) => isVolatile(k));
  const unexpected = diffs.filter(([k]) => !isVolatile(k));
  console.log(`  valores: ${a.size - diffs.length} idénticos · ${volatile.length} volátiles conocidos · ${unexpected.length} inesperados`);
  for (const [k, x, y] of volatile.slice(0, 5)) console.log(`       ~ ${k}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  for (const [k, x, y] of unexpected.slice(0, 40)) console.log(`     ⛔ ${k}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  if (unexpected.length > 40) console.log(`     … y ${unexpected.length - 40} más`);
  totalUnexpected += unexpected.length;
}

console.log(`\n${'═'.repeat(96)}`);
if (totalUnexpected === 0) {
  console.log(SELF
    ? '✓ Sin diferencias por encima de lo declarado volátil — suelo de ruido medido.'
    : '✓ DIFF LIMPIO — el cambio preserva el payload.');
} else {
  console.log(`⛔ ${totalUnexpected} diferencias INESPERADAS — el cambio NO preserva comportamiento.`);
  console.log('   Antes de concluir: correr SIN `LEGACY` para medir el suelo de ruido y comparar.');
}
console.log('═'.repeat(96));
process.exit(totalUnexpected === 0 ? 0 : 1);
