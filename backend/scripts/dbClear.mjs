#!/usr/bin/env node
/**
 * dbClear.mjs — vacía datos consolidados de la BBDD SQLite.
 *
 * Uso (desde backend/):  node scripts/dbClear.mjs <history|analyses|all>
 * Llamado desde scripts/runSystem.sh (con confirmación previa en el menú).
 *
 *   history   → history_series (CVD/VWAP/funding/oi/lsr/liq/fear_greed)
 *   analyses  → analyses + analysis_tf_snapshot + analysis_liquidation_snapshot +
 *               analysis_fvg_snapshot + analysis_outcome
 *   all       → ambos
 *
 * Nota: si el backend está corriendo mantiene en memoria las series ya hidratadas
 * (CVD/VWAP) hasta el próximo reinicio; el borrado afecta al disco de inmediato.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';

const target = process.argv[2];
const dbPath = process.env.DB_PATH || './data/cryptex.db';

const VALID = ['history', 'analyses', 'all'];
if (!VALID.includes(target)) {
  console.error(`  Uso: node scripts/dbClear.mjs <${VALID.join('|')}>`);
  process.exit(1);
}

if (!existsSync(dbPath)) {
  console.log(`  No existe la BBDD: ${dbPath}`);
  process.exit(0);
}

const db = new Database(dbPath, { fileMustExist: true });
db.pragma('journal_mode = WAL');

const has = (name) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);

const del = (name) => {
  if (!has(name)) return 0;
  const n = db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
  db.prepare(`DELETE FROM ${name}`).run();
  return n;
};

const report = [];
if (target === 'history' || target === 'all') {
  report.push(['history_series', del('history_series')]);
}
if (target === 'analyses' || target === 'all') {
  // Orden hijo→padre (no hay FK enforcement, pero mantiene coherencia lógica).
  // analysis_fvg_snapshot se añadió después que este script y faltaba en la lista: al vaciar
  // dejaba sus filas huérfanas apuntando a análisis inexistentes. Las hijas van antes que la
  // madre (no hay enforcement de FK en better-sqlite3 sin triggers).
  for (const t of ['analysis_liquidation_snapshot', 'analysis_tf_snapshot', 'analysis_fvg_snapshot', 'analysis_outcome', 'analyses']) {
    report.push([t, del(t)]);
  }
}

// Recuperar espacio del WAL/páginas liberadas (best-effort: falla si la BBDD está bloqueada).
try { db.exec('VACUUM'); } catch { /* backend corriendo puede bloquear VACUUM */ }
db.close();

for (const [t, n] of report) console.log(`  borrado ${t}: ${n} filas`);
