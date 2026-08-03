/**
 * backfillLiquidationClusters.mjs — reconstruye `analysis_liquidation_snapshot` hacia atrás.
 *
 * POR QUÉ. La tabla llevaba VACÍA desde siempre y no por falta de dato: `buildClusterRows`
 * leía `top_long_clusters`/`top_short_clusters` y el servicio emite `long_clusters`/
 * `short_clusters`, así que el `?? []` se tragaba el bloque entero en silencio (bug
 * corregido el 2026-08-02). Los clusters SÍ llegaban al LLM —la sección F5 del prompt
 * consume `magnetic_long/short_zone_active`—, o sea que la decisión se tomó con ellos y lo
 * único que faltaba era poder auditarlos a posteriori: exactamente la deuda que
 * `analysis_fvg_snapshot` cerró para los FVG.
 *
 * NO REIMPLEMENTA NADA. Usa `computeLiquidationClusters` (el mismo núcleo puro que corre en
 * producción) y `buildClusterRows` (la misma función que escribe las filas en vivo). Si
 * alguna de las dos cambia, esto cambia con ella — que es justo lo que no ocurrió con el
 * nombre de la clave.
 *
 * ⚠️ LA RECONSTRUCCIÓN NO ES BIT-EXACTA, y conviene tenerlo claro antes de leer las filas:
 *   - Los BINS pueden moverse un poco. El rango de precio sale del high/low de las velas
 *     que casan con un bucket, y la ÚLTIMA hora de la ventana estaba a medio formar cuando
 *     corrió el análisis y está cerrada ahora. Es el mismo caveat que obligó a persistir
 *     `band_pct` en vez de recalcularlo.
 *   - `total_usd` por bin es exacto salvo por ese mismo bucket final.
 *   - `distance_pct` SÍ es exacto: se calcula contra `analyses.price_current`, que es el
 *     spot persistido en el instante del análisis, no un precio reconstruido.
 * Por eso cada fila escrita aquí va marcada con `reconstructed = 1`.
 *
 * VENTANA. Coinalyze sirve >=30 días de liquidation-history 1h (comprobado: 694 buckets en
 * una ventana de 720 h), así que la limitación real no es la profundidad del histórico sino
 * que cada análisis necesita sus 168 h PREVIAS. Un análisis más antiguo que
 * (hoy − 30 d + 7 d) no se puede reconstruir; el script lo detecta y lo omite en vez de
 * escribir un cluster calculado sobre una ventana truncada, que sería peor que no tener nada.
 *
 * Uso (desde backend/):
 *   node scripts/backfillLiquidationClusters.mjs --dry-run
 *   node scripts/backfillLiquidationClusters.mjs
 *   node scripts/backfillLiquidationClusters.mjs --force     # reescribe las que ya existan
 */

import Database from 'better-sqlite3';
import axios from 'axios';
import { existsSync } from 'fs';
import { computeLiquidationClusters } from '../src/utils/liquidationClusters.js';
import { buildClusterRows } from '../src/controllers/analysisController.js';
import { COINALYZE_SYMBOLS } from '../src/config/constants.js';
import { fetchHistoricalKlines } from '../src/services/coingeckoService.js';

const DRY   = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const HOURS       = 7 * 24;          // misma ventana que el servicio
const COINALYZE   = 'https://api.coinalyze.net/v1';
const API_KEY     = process.env.COINALYZE_API_KEY;
const PAUSE_MS    = 1200;            // cortesía con el free tier

// Acceso directo como el resto de scripts (dbClear/dbStats): `getDb()` exige que la app haya
// llamado a `initDb()`, y aquí no arrancamos la app.
const dbPath = process.env.DB_PATH || './data/cryptex.db';
if (!existsSync(dbPath)) { console.log(`  No existe la BBDD: ${dbPath}`); process.exit(0); }
if (!API_KEY) { console.log('  Falta COINALYZE_API_KEY en el entorno.'); process.exit(1); }

const db = new Database(dbPath, { fileMustExist: true });
db.pragma('journal_mode = WAL');

// La columna de procedencia la crea la migración de la app; si el script corre contra una
// BBDD que aún no ha arrancado con el código nuevo, la añadimos aquí (idempotente).
const hasCol = db.prepare("PRAGMA table_info(analysis_liquidation_snapshot)").all()
  .some(c => c.name === 'reconstructed');
if (!hasCol) {
  if (DRY) console.log('  (DRY) faltaría añadir la columna `reconstructed`');
  else db.exec('ALTER TABLE analysis_liquidation_snapshot ADD COLUMN reconstructed INTEGER NOT NULL DEFAULT 0');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rows = db.prepare(`
  SELECT a.id, a.coin, a.timestamp, a.price_current,
         (SELECT COUNT(*) FROM analysis_liquidation_snapshot s WHERE s.analysis_id = a.id) AS have
  FROM analyses a
  ORDER BY a.timestamp
`).all();

const pending = rows.filter(r => FORCE || r.have === 0);
console.log(`\nAnálisis en BBDD: ${rows.length} · sin clusters: ${rows.filter(r => !r.have).length}`
  + ` · a procesar: ${pending.length}${DRY ? '  (DRY-RUN)' : ''}${FORCE ? '  (FORCE)' : ''}\n`);
if (!pending.length) { console.log('  Nada que hacer.\n'); process.exit(0); }

const insert = db.prepare(`
  INSERT INTO analysis_liquidation_snapshot
    (analysis_id, cluster_type, cluster_rank, price, total_usd, distance_pct, reconstructed)
  VALUES (@analysis_id, @cluster_type, @cluster_rank, @price, @total_usd, @distance_pct, 1)
`);
const wipe = db.prepare('DELETE FROM analysis_liquidation_snapshot WHERE analysis_id = ?');

let written = 0, skipped = 0, failed = 0;

for (const a of pending) {
  const tMs   = Date.parse(a.timestamp);
  const toSec = Math.floor(tMs / 1000);
  const fromSec = toSec - HOURS * 3600;
  const label = `${a.timestamp.slice(0, 16)} ${a.coin}`;

  const symbol = COINALYZE_SYMBOLS[a.coin.toUpperCase()];
  if (!symbol) { console.log(`  ✗ ${label}: sin símbolo Coinalyze`); skipped++; continue; }

  try {
    const [liqRes, candles] = await Promise.all([
      axios.get(`${COINALYZE}/liquidation-history`, {
        params: { api_key: API_KEY, symbols: symbol, interval: '1hour', from: fromSec, to: toSec },
        timeout: 20000,
      }),
      // Binance devuelve las velas cuyo OPEN cae en [startTime, endTime].
      fetchHistoricalKlines(a.coin, '1h', fromSec * 1000, tMs, 1000),
    ]);

    const buckets = liqRes.data?.[0]?.history ?? [];

    // GUARDA DE COBERTURA: si la ventana no llega atrás del todo, el rango de precio se
    // calcula sobre menos historia y los bins no son comparables con los de producción.
    // Preferimos no escribir a escribir algo que parezca lo mismo y no lo sea.
    const oldest = buckets.length ? Math.min(...buckets.map(b => b.t)) : null;
    const coverageH = oldest ? (toSec - oldest) / 3600 : 0;
    if (coverageH < HOURS * 0.9) {
      console.log(`  ⊘ ${label}: cobertura ${coverageH.toFixed(0)}h de ${HOURS}h — se omite`);
      skipped++;
      await sleep(PAUSE_MS);
      continue;
    }

    const clusters = computeLiquidationClusters(buckets, candles);
    if (!clusters) {
      console.log(`  ⊘ ${label}: el núcleo devuelve null (sin rango utilizable)`);
      skipped++;
      await sleep(PAUSE_MS);
      continue;
    }

    // MISMA función que escribe en vivo, y misma referencia de precio.
    const clusterRows = buildClusterRows(a.id, clusters, a.price_current);
    if (!clusterRows.length) {
      console.log(`  ⊘ ${label}: 0 filas derivadas`);
      skipped++;
      await sleep(PAUSE_MS);
      continue;
    }
    if (clusterRows.length > 10) {
      console.log(`  ✗ ${label}: ${clusterRows.length} filas (>10) — se omite, revisar`);
      failed++;
      await sleep(PAUSE_MS);
      continue;
    }

    const near = clusters.nearest_long_cluster_pct;
    const detail = `${clusterRows.length} filas · long≈${near ?? '—'}% · short≈${clusters.nearest_short_cluster_pct ?? '—'}%`
      + ` · buckets ${buckets.length} · velas ${candles.length}`;

    if (DRY) {
      console.log(`  · ${label}: ${detail}`);
    } else {
      db.transaction(() => {
        if (FORCE) wipe.run(a.id);
        for (const r of clusterRows) insert.run(r);
      })();
      console.log(`  ✓ ${label}: ${detail}`);
    }
    written += clusterRows.length;
  } catch (err) {
    console.log(`  ✗ ${label}: ${err.message}`);
    failed++;
  }

  await sleep(PAUSE_MS);
}

console.log(`\n  ${DRY ? 'Se escribirían' : 'Escritas'}: ${written} filas · omitidos: ${skipped} · fallos: ${failed}\n`);
db.close();
