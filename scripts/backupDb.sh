#!/usr/bin/env bash
#
# backupDb.sh — copia consistente diaria de la BBDD, con rotación.
#
# Motivación (revisión crítica 2026-07-26, hallazgo H1): `history_series` acumula CVD y VWAP
# a razón de 1 fila por día y moneda, y son las DOS ÚNICAS series irreconstruibles del
# sistema — ninguna API las sirve retroactivamente. Un `dbClear` mal tecleado, un fallo de
# disco o una migración fallida borraban la fase de recogida entera sin vuelta atrás.
#
# Por qué VACUUM INTO y no `cp`: la BD corre en WAL, así que copiar el fichero suelto puede
# capturar un estado a medias (parte del commit vive en el -wal). `VACUUM INTO` produce un
# único fichero consistente SIN detener el servicio ni tocar el original. Es el mismo
# mecanismo con el que se migró la BD de desarrollo a la Pi.
#
# Uso:
#   ./backupDb.sh            # copia de hoy + rotación
#   KEEP_DAYS=30 ./backupDb.sh
#
set -uo pipefail

DB="${DB:-$HOME/cryptex/backend/data/cryptex.db}"
DEST="${DEST:-$HOME/cryptex-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v18.20.8/bin/node}"
BACKEND_DIR="${BACKEND_DIR:-$HOME/cryptex/backend}"
LOG="${LOG:-$DEST/backup.log}"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y-%m-%d)"
OUT="$DEST/cryptex-$STAMP.db"

mkdir -p "$DEST"

log() { echo "$TS $*" >> "$LOG"; }

if [ ! -f "$DB" ]; then
  log "ERROR no existe la BD: $DB"
  exit 1
fi

# VACUUM INTO falla si el destino ya existe → se rehace la copia del día.
rm -f "$OUT"

# better-sqlite3 vive en backend/node_modules, de ahí el cd.
# VACUUM INTO admite parámetro enlazado (verificado), así que la ruta no se interpola en
# el SQL — nada que escapar aunque el path traiga comillas o espacios.
if ! (cd "$BACKEND_DIR" && "$NODE_BIN" -e '
  const D = require("better-sqlite3");
  const db = new D(process.argv[1], { readonly: true });
  db.prepare("VACUUM INTO ?").run(process.argv[2]);
  db.close();
' "$DB" "$OUT" 2>>"$LOG"); then
  log "ERROR VACUUM INTO fallo (destino=$OUT)"
  exit 1
fi

# Verificación de integridad: una copia corrupta que nadie abre no es un backup.
# shellcheck disable=SC2016  # los ${} de dentro son template literals de JS, no del shell
CHECK="$(cd "$BACKEND_DIR" && "$NODE_BIN" -e '
  const D = require("better-sqlite3");
  try {
    const db = new D(process.argv[1], { readonly: true });
    const ok = db.prepare("PRAGMA integrity_check").get().integrity_check;
    const a  = db.prepare("SELECT COUNT(*) c FROM analyses").get().c;
    const h  = db.prepare("SELECT COUNT(*) c FROM history_series").get().c;
    process.stdout.write(`${ok}|${a}|${h}`);
  } catch (e) { process.stdout.write(`fail:${e.message}|0|0`); }
' "$OUT" 2>/dev/null)"

STATUS="${CHECK%%|*}"
COUNTS="${CHECK#*|}"

if [ "$STATUS" != "ok" ]; then
  log "ERROR integrity_check=$STATUS en $OUT — copia descartada"
  rm -f "$OUT"
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
log "OK $(basename "$OUT") size=$SIZE analyses=${COUNTS%%|*} history_series=${COUNTS##*|}"

# Rotación: borrar copias con más de KEEP_DAYS días. Nunca borra la única que queda.
REMAINING="$(find "$DEST" -maxdepth 1 -name 'cryptex-*.db' | wc -l)"
if [ "$REMAINING" -gt 1 ]; then
  DELETED="$(find "$DEST" -maxdepth 1 -name 'cryptex-*.db' -mtime "+$KEEP_DAYS" -print -delete | wc -l)"
  [ "$DELETED" -gt 0 ] && log "rotacion: $DELETED copia(s) de mas de $KEEP_DAYS dias borradas"
fi

exit 0
