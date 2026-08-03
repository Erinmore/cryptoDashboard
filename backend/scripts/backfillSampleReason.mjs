#!/usr/bin/env node
/**
 * backfillSampleReason.mjs — rellena `analyses.sample_reason` en las filas anteriores a la columna.
 *
 * ⚠️ REESCRITO EL MISMO DÍA: LA FUENTE ES EL LOG, NO LA HORA. La primera versión deducía el
 * motivo de la hora del análisis y marcaba todo `:inferred`. Pero `collect.log` **registra el
 * motivo de cada ejecución** (`reason=fixed`, `reason=opportunistic:veto_short`,
 * `reason=manual_verificacion`…), o sea que el dato EXISTE — sólo estaba en otro sitio. Deducir
 * lo que ya está escrito es inventar donde se puede leer. La heurística horaria se queda sólo
 * como respaldo para filas sin línea de log, y ésas sí van marcadas `:inferred`.
 *
 * ─── POR QUÉ SE RELLENA, SI LA REGLA DEL PROYECTO ES NO RELLENAR ───────────────────────
 *
 * Con `gate_version` se decidió dejar NULL a propósito: no se puede saber con qué reglas se
 * produjo una fila vieja, y un valor inventado sería peor que un hueco. **Aquí es distinto: la
 * información SÍ es recuperable.** El cron fijo dispara en una ventana horaria estrecha
 * (08:05-08:23 y 20:05-20:23 UTC) y el oportunista corría al minuto 7 de cada hora, así que la
 * hora de la fila determina su origen. Verificado sobre las 12 filas existentes: 9 caen en la
 * ventana fija y las 3 restantes son exactamente las que deben quedar fuera (02:07 y 04:07 del
 * oportunista viejo, y una verificación manual a las 16:59).
 *
 * ─── PERO SE MARCA COMO INFERIDO, Y ESO NO ES NEGOCIABLE ──────────────────────────────
 *
 * Se escribe `fixed:inferred` / `adhoc:inferred`, no `fixed` a secas. Y el no-fijo es `adhoc`,
 * no `opportunistic`: la hora dice que NO fue planificado, pero no distingue un disparo por
 * evento de un lanzamiento manual — de hecho la fila de las 16:59 fue una verificación a mano.
 * Etiquetarla `opportunistic` afirmaría más de lo que el dato permite. Un dato DERIVADO
 * presentado como dato REGISTRADO es la clase de confusión que este proyecto ha pagado cara
 * (los clusters reconstruidos llevan por eso su columna `reconstructed`). Con el sufijo:
 *   · el prefijo sigue siendo válido, así que los filtros por `LIKE 'fixed%'` funcionan igual;
 *   · y quien mire de cerca ve de dónde salió, sin tener que confiar en un comentario.
 *
 * ⚠️ LÍMITE CONOCIDO: un análisis manual lanzado a las 08:06 se etiquetaría como `fixed:inferred`.
 * Sobre las filas existentes no ocurre (comprobado una a una), pero la inferencia no se puede
 * extender a filas futuras — desde el 2026-08-03 el motivo llega en la petición y se registra.
 *
 * Idempotente: sólo toca filas con `sample_reason IS NULL`.
 *
 * Uso (desde backend/):
 *   node scripts/backfillSampleReason.mjs --dry-run
 *   node scripts/backfillSampleReason.mjs
 */

import { readFileSync } from 'fs';
import path from 'path';
import { getDb, initDb, closeDb } from '../src/config/db.js';
import { normalizeSampleReason } from '../src/utils/sampleReason.js';

const DRY = process.argv.includes('--dry-run');

/** Ventanas UTC del cron fijo, con margen para el escalonado (:05/:11/:17) + ~55 s de análisis. */
const VENTANAS_FIJAS = [['08:05', '08:23'], ['20:05', '20:23']];

const enVentana = (hhmm) => VENTANAS_FIJAS.some(([a, b]) => hhmm >= a && hhmm <= b);

const LOG = process.env.COLLECT_LOG
  ?? path.join(process.env.HOME ?? '', 'cryptex/.collect/collect.log');
/** Tolerancia entre el ARRANQUE que registra el log y el fin del análisis que graba la fila. */
const TOLERANCIA_MS = 5 * 60 * 1000;

/** Líneas `<ISO> reason=<valor>` del log de recogida, ordenadas. */
function leerLog() {
  try {
    return readFileSync(LOG, 'utf8').split('\n')
      .map((l) => l.match(/^(\S+Z)\s+reason=(\S+)/))
      .filter(Boolean)
      .map((m) => ({ ms: Date.parse(m[1]), reason: normalizeSampleReason(m[2], { fallback: null }) }))
      .filter((e) => Number.isFinite(e.ms) && e.reason)
      .sort((a, b) => a.ms - b.ms);
  } catch { return []; }
}

initDb();
const db = getDb();

const filas = db.prepare(
  // Re-procesa también lo marcado `:inferred`: si ahora hay línea de log, un hecho registrado
  // sustituye a una deducción.
  `SELECT id, coin, timestamp FROM analyses
    WHERE sample_reason IS NULL OR sample_reason LIKE '%:inferred' ORDER BY timestamp`,
).all();

console.log(`Backfill de sample_reason — ${filas.length} filas sin motivo${DRY ? ' · DRY-RUN' : ''}`);
if (!filas.length) { console.log('Nada que hacer.'); closeDb(); process.exit(0); }

const entradas = leerLog();
console.log(`  log: ${entradas.length} ejecuciones con motivo registrado (${LOG})\n`);

const upd = db.prepare('UPDATE analyses SET sample_reason = ? WHERE id = ?');
const cuenta = {};
let escritas = 0;

for (const f of filas) {
  const d = new Date(f.timestamp);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  // 1º el LOG (hecho registrado): la línea más cercana ANTERIOR dentro de la tolerancia.
  const t = d.getTime();
  const enLog = entradas.filter((e) => e.ms <= t && t - e.ms <= TOLERANCIA_MS).at(-1);
  // 2º respaldo: la hora. Sólo aquí se marca `:inferred`.
  const motivo = enLog ? enLog.reason : (enVentana(hhmm) ? 'fixed:inferred' : 'adhoc:inferred');
  cuenta[motivo] = (cuenta[motivo] ?? 0) + 1;
  console.log(`  ${f.coin.padEnd(4)} ${f.timestamp.slice(0, 16)}  ${hhmm} UTC → ${motivo}`
    + `${enLog ? '   (del log)' : '   (inferido de la hora)'}`);
  if (!DRY) { upd.run(motivo, f.id); escritas++; }
}

console.log(`\n  ${Object.entries(cuenta).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);
if (!DRY) {
  console.log(`  Escritas ${escritas} filas.`);
  console.table(db.prepare(
    'SELECT sample_reason, COUNT(*) n FROM analyses GROUP BY sample_reason ORDER BY sample_reason',
  ).all());
} else {
  console.log('  (dry-run: no se ha escrito nada)');
}
closeDb();
