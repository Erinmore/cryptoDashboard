#!/usr/bin/env node
/**
 * dbStats.mjs — informe read-only de datos consolidados en la BBDD SQLite.
 *
 * Uso (desde backend/):  node scripts/dbStats.mjs
 * Llamado desde scripts/runSystem.sh (opción de menú "Datos consolidados en BBDD").
 *
 * No arranca la app ni corre migraciones: abre la BBDD en solo-lectura y agrega
 * conteos por tabla + por serie histórica (history_series), con rango de fechas.
 */

import Database from 'better-sqlite3';
import { statSync, existsSync } from 'fs';

const dbPath = process.env.DB_PATH || './data/cryptex.db';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
};

if (!existsSync(dbPath)) {
  console.log(`\n  ${c.yellow}No existe la BBDD todavía${c.reset} en: ${c.dim}${dbPath}${c.reset}`);
  console.log(`  Arranca el backend al menos una vez para crearla.\n`);
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const tableExists = (name) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);

const count = (sql, ...args) => {
  try { return db.prepare(sql).get(...args)?.n ?? 0; } catch { return 0; }
};

// Tamaño en disco = .db + -wal + -shm (los writes recientes viven en el WAL).
let bytes = 0;
for (const ext of ['', '-wal', '-shm']) {
  try { bytes += statSync(dbPath + ext).size; } catch { /* noop */ }
}
const sizeMB = (bytes / 1024 / 1024).toFixed(2);

console.log(`\n  ${c.bold}Base de datos${c.reset}  ${c.dim}${dbPath}${c.reset}  (${sizeMB} MB en disco)\n`);

// ── Análisis IA ────────────────────────────────────────────────────────────
console.log(`  ${c.bold}Análisis IA${c.reset}`);
if (tableExists('analyses')) {
  const total = count(`SELECT COUNT(*) n FROM analyses`);
  console.log(`    analyses .......................... ${c.green}${total}${c.reset}`);
  if (total > 0) {
    const perCoin = db.prepare(
      `SELECT coin, COUNT(*) n, MAX(timestamp) last FROM analyses GROUP BY coin ORDER BY coin`,
    ).all();
    for (const r of perCoin) {
      console.log(`      ${c.cyan}${r.coin.padEnd(4)}${c.reset} ${String(r.n).padStart(5)}   ${c.dim}último: ${r.last}${c.reset}`);
    }
  }
  console.log(`    analysis_tf_snapshot .............. ${count(`SELECT COUNT(*) n FROM analysis_tf_snapshot`)}`);
  console.log(`    analysis_liquidation_snapshot ..... ${count(`SELECT COUNT(*) n FROM analysis_liquidation_snapshot`)}`);
  console.log(`    analysis_outcome .................. ${count(`SELECT COUNT(*) n FROM analysis_outcome`)}  ${c.dim}(job pendiente)${c.reset}`);
} else {
  console.log(`    ${c.dim}(sin tablas de análisis)${c.reset}`);
}

// ── Históricos (history_series) ─────────────────────────────────────────────
console.log(`\n  ${c.bold}Históricos (history_series)${c.reset}`);
if (tableExists('history_series')) {
  const total = count(`SELECT COUNT(*) n FROM history_series`);
  if (total === 0) {
    console.log(`    ${c.dim}(vacío)${c.reset}`);
  } else {
    const rows = db.prepare(`
      SELECT coin, metric, COUNT(*) n, MIN(ts_key) mn, MAX(ts_key) mx
      FROM history_series GROUP BY coin, metric ORDER BY coin, metric`).all();
    const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
    console.log(`    ${c.dim}coin    metric              registros   rango${c.reset}`);
    for (const r of rows) {
      console.log(
        `    ${c.cyan}${r.coin.padEnd(7)}${c.reset}${r.metric.padEnd(20)}${String(r.n).padStart(6)}   ${c.dim}${day(r.mn)} → ${day(r.mx)}${c.reset}`,
      );
    }
    console.log(`    ${c.dim}────────────────────────────────────────────────${c.reset}`);
    console.log(`    ${c.dim}total: ${total} registros${c.reset}`);
  }
} else {
  console.log(`    ${c.dim}(tabla no existe todavía)${c.reset}`);
}

console.log('');
db.close();
