#!/usr/bin/env node
/**
 * backfillLiquidationsHourly.mjs — siembra la serie de ARCHIVO `liquidations_1h`.
 *
 * ─── POR QUÉ ESTO SE EJECUTA UNA VEZ Y CUANTO ANTES ───────────────────────────────────
 *
 * Coinalyze sirve **90 días y ni uno más**, y esa ventana RUEDA: lo que hoy está a 91 días
 * ya no existe para nadie. El poller en vivo sólo puede acumular hacia delante, así que sin
 * este backfill la serie arranca hoy y los 90 días que la API todavía ofrece se pierden
 * para siempre — un día por día.
 *
 * Y esos 90 días concretos importan más que otros: la rúbrica de derivados se calibró el
 * **2026-07-29** sobre los 90 anteriores, así que sembrar ahora deja la frontera
 * dentro-de-muestra / fuera-de-muestra guardada en la propia BBDD, en vez de tener que
 * reconstruirla más tarde desde una API que ya la habrá olvidado.
 *
 * QUÉ HABILITA. El término de cascada de `liquidationCascade` normaliza contra la mediana
 * de ~697 ventanas RODANTES de 24h y se abstiene por debajo de `cascade_min_points: 620`.
 * Con agregados diarios (30 puntos/mes) ese guard no se satisface jamás, así que la cascada
 * sería muda en cualquier auditoría a posteriori. La resolución horaria es la condición
 * necesaria para poder validar fuera de muestra la mitad de la rúbrica que hoy no se puede.
 *
 * NO REIMPLEMENTA NADA. La escritura la hace `addLiquidationsHourlyEntries` del propio
 * servicio, que es también quien la hace en vivo — un solo dueño del formato de la fila.
 *
 * Idempotente: `persist()` hace ON CONFLICT DO UPDATE. Re-ejecutarlo reescribe lo mismo.
 * ⚠️ La escritura es INCREMENTAL por diseño (sólo lo posterior al último `ts_key` guardado),
 * así que para RELLENAR HACIA ATRÁS hay que ejecutarlo antes de que el poller haya escrito
 * nada, o usar `--force` (que borra la serie de esa moneda y la reescribe entera).
 *
 * SOLO ESCRIBE `history_series`: no toca análisis, ni la ruta de decisión, ni el prompt.
 *
 * Uso (desde backend/):
 *   node scripts/backfillLiquidationsHourly.mjs                 # 3 monedas, 90 días
 *   COINS=SOL DAYS=30 node scripts/backfillLiquidationsHourly.mjs
 *   node scripts/backfillLiquidationsHourly.mjs --dry-run       # no escribe, informa
 *   node scripts/backfillLiquidationsHourly.mjs --force         # borra y reescribe la serie
 */

import axios from 'axios';
import env from '../src/config/env.js';
import { COINALYZE_SYMBOLS } from '../src/config/constants.js';
import { addLiquidationsHourlyEntries } from '../src/services/historyService.js';
import { getDb, initDb, closeDb } from '../src/config/db.js';

const COINS = (process.env.COINS ?? 'SOL,BTC,ETH').split(',').map((s) => s.trim().toUpperCase());
const DAYS = Number(process.env.DAYS ?? 90);   // 90 = el máximo que sirve Coinalyze
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const METRIC = 'liquidations_1h';

if (!env.coinalyzeApiKey) {
  console.error('Falta COINALYZE_API_KEY — sin ella no hay nada que descargar.');
  process.exit(1);
}
if (!Number.isFinite(DAYS) || DAYS <= 0 || DAYS > 90) {
  console.error(`DAYS=${DAYS} fuera de rango: Coinalyze sirve como mucho 90 días.`);
  process.exit(1);
}

const iso = (sec) => new Date(sec * 1000).toISOString().replace('.000Z', 'Z');

async function fetchHourly(coin) {
  const symbol = COINALYZE_SYMBOLS[coin];
  if (!symbol) throw new Error(`moneda no soportada: ${coin}`);
  const to = Math.floor(Date.now() / 1000);
  const from = to - DAYS * 24 * 3600;
  const { data } = await axios.get('https://api.coinalyze.net/v1/liquidation-history', {
    timeout: 30000,
    params: { symbols: symbol, interval: '1hour', from, to, api_key: env.coinalyzeApiKey },
  });
  return data?.[0]?.history ?? [];
}

initDb();
const db = getDb();

console.log(`Backfill de \`${METRIC}\` — ${COINS.join(', ')} · ${DAYS} días`
  + `${DRY ? ' · DRY-RUN' : ''}${FORCE ? ' · FORCE (borra y reescribe)' : ''}`);
console.log('Coinalyze sirve 90 días y esa ventana rueda: lo no guardado hoy se pierde.\n');

let totalWritten = 0;
for (const coin of COINS) {
  let hist;
  try {
    hist = await fetchHourly(coin);
  } catch (err) {
    console.log(`  ${coin.padEnd(4)} ERROR: ${err.message}`);
    continue;
  }
  if (!hist.length) {
    console.log(`  ${coin.padEnd(4)} sin datos devueltos por la API`);
    continue;
  }

  const before = db.prepare(
    'SELECT COUNT(*) n, MIN(ts_key) mn, MAX(ts_key) mx FROM history_series WHERE coin=? AND metric=?',
  ).get(coin, METRIC);

  // Cobertura: cuántas horas del rango descargado faltan realmente. Es el número que dice si
  // el backfill hace falta, y se calcula ANTES de escribir para que el dry-run sirva de algo.
  const span = hist.at(-1).t - hist[0].t;
  const expected = Math.floor(span / 3600) + 1;
  console.log(`  ${coin.padEnd(4)} API: ${hist.length} velas (${iso(hist[0].t)} → ${iso(hist.at(-1).t)})`
    + `${hist.length < expected ? ` · ⚠️ ${expected - hist.length} huecos en origen` : ''}`);
  console.log(`       BBDD antes: ${before.n} filas`
    + (before.n ? ` (${iso(before.mn)} → ${iso(before.mx)})` : ''));

  if (DRY) {
    const have = new Set(db.prepare(
      'SELECT ts_key FROM history_series WHERE coin=? AND metric=?',
    ).all(coin, METRIC).map((r) => r.ts_key));
    console.log(`       escribiría ~${hist.filter((c) => !have.has(c.t)).length} filas nuevas\n`);
    continue;
  }

  if (FORCE) {
    const del = db.prepare('DELETE FROM history_series WHERE coin=? AND metric=?').run(coin, METRIC);
    console.log(`       --force: ${del.changes} filas borradas`);
  }

  const written = addLiquidationsHourlyEntries(coin, hist);
  const after = db.prepare(
    'SELECT COUNT(*) n, MIN(ts_key) mn, MAX(ts_key) mx FROM history_series WHERE coin=? AND metric=?',
  ).get(coin, METRIC);
  totalWritten += written;
  console.log(`       escritas ${written} · BBDD ahora: ${after.n} filas`
    + (after.n ? ` (${iso(after.mn)} → ${iso(after.mx)})` : ''));

  // La razón de ser de la serie es alimentar la mediana rodante de 24h, así que se informa
  // si el guard `cascade_min_points: 620` quedaría satisfecho. Un backfill "correcto" que no
  // llegue a ese punto no habilita lo que vino a habilitar.
  if (after.n) {
    const ok = after.n >= 620 + 24;
    console.log(`       mediana rodante de 24h: ${ok ? '✅' : '⚠️ '} ~${Math.max(0, after.n - 23)} ventanas`
      + ` (cascade_min_points exige 620)\n`);
  } else console.log();
}

if (!DRY) console.log(`Total escrito: ${totalWritten} filas.`);
closeDb();
