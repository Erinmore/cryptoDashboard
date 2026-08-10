/**
 * backfillContradictionBlocks.mjs — rellena `analyses.contradiction_blocks` en filas previas.
 *
 * POR QUÉ. La columna se añadió el 2026-07-31 para que el historial pueda decir CUÁLES de los
 * tres bloques (volumen/derivados/estructura) están en contradicción, en vez de solo cuántos.
 * `gating.js` ya los calculaba pero no se persistían. Las filas anteriores tienen los CÓDIGOS
 * y el bloque se deriva de ellos con un mapa fijo, así que el dato es reconstruible sin
 * pérdida — no hay que dejarlo a null ni esperar a que se repueble solo.
 *
 * IMPORTA el mapa de `utils/gating.js` en vez de copiarlo: dos definiciones de "qué bloque es
 * cada señal" y el conteo del decay dejaría de casar con lo que muestra el historial.
 *
 * INTEGRIDAD: `contradiction_count` debe ser igual al número de bloques DISTINTOS derivados.
 * Si no cuadra en alguna fila, se avisa y no se toca — sería señal de que el dedupe por veto
 * dejó códigos y conteo desalineados, y eso hay que mirarlo, no parchearlo.
 *
 * Uso (desde backend/):
 *   node scripts/backfillContradictionBlocks.mjs --dry-run
 *   node scripts/backfillContradictionBlocks.mjs
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { CONTRADICTION_BLOCK } from '../src/utils/gating.js';

const DRY = process.argv.includes('--dry-run');
// Acceso directo como el resto de scripts (dbClear/dbStats): `getDb()` exige que la app haya
// llamado a `initDb()`, y aquí no arrancamos la app.
const dbPath = process.env.DB_PATH || './data/cryptex.db';
if (!existsSync(dbPath)) { console.log(`  No existe la BBDD: ${dbPath}`); process.exit(0); }
const db = new Database(dbPath, { fileMustExist: true });
db.pragma('journal_mode = WAL');

const rows = db.prepare(`
  SELECT id, coin, timestamp, contradiction_count, contradiction_codes
  FROM analyses
  WHERE contradiction_codes IS NOT NULL AND contradiction_blocks IS NULL
  ORDER BY timestamp
`).all();

console.log(`\nFilas con códigos y sin bloques: ${rows.length}${DRY ? '  (DRY-RUN)' : ''}\n`);
if (!rows.length) { console.log('  Nada que hacer.\n'); process.exit(0); }

const upd = db.prepare('UPDATE analyses SET contradiction_blocks = ? WHERE id = ?');
let ok = 0, skip = 0, unknown = 0;

for (const r of rows) {
  let codes = [];
  try { codes = JSON.parse(r.contradiction_codes) ?? []; } catch { /* ignore */ }
  const sinMapa = codes.filter((c) => !CONTRADICTION_BLOCK[c]);
  if (sinMapa.length) {
    console.log(`  ⚠ ${r.timestamp}  código sin mapa: ${sinMapa.join(', ')} — se omite`);
    unknown++; continue;
  }
  const blocks = [...new Set(codes.map((c) => CONTRADICTION_BLOCK[c]))];

  if (r.contradiction_count != null && r.contradiction_count !== blocks.length) {
    console.log(`  ⚠ ${r.timestamp}  count=${r.contradiction_count} pero ${blocks.length} bloques `
      + `(${blocks.join('+')}) — DESCUADRA, se omite`);
    skip++; continue;
  }
  console.log(`  ${DRY ? '·' : '✓'} ${r.timestamp}  ${r.coin}  ${codes.length} señales → `
    + `${blocks.length} bloques: ${blocks.join(' + ')}`);
  if (!DRY) upd.run(JSON.stringify(blocks), r.id);
  ok++;
}

console.log(`\n${DRY ? 'se actualizarían' : 'actualizadas'}: ${ok} · descuadres: ${skip} · códigos desconocidos: ${unknown}\n`);
