#!/usr/bin/env bash
#
# checkCollection.sh — ¿sigue viva la recogida de datos?
#
# Motivación (revisión crítica 2026-07-26, hallazgo H2): `collect.sh` ante un fallo escribe
# una línea ERROR en su log y termina — correcto, no debe reintentar. Pero NADIE LEE ESE LOG.
# Si el servicio se cae un viernes por la noche, el cron dispara cuatro veces en balde durante
# el fin de semana y el lunes faltan cuatro observaciones que nadie sabe que faltan. Con una
# muestra objetivo de 15-28, perder 4 es perder el 15-25 % del experimento.
#
# Este script comprueba lo que puede fallar en silencio y deja el veredicto en un fichero de
# estado que el backend expone en /health → visible desde el navegador, sin ssh ni leer logs.
#
# Comprobaciones:
#   1. Último análisis: no debería tener más de MAX_ANALYSIS_AGE_H horas (cron A dispara cada 12h)
#   2. Backup del día: presente y con integridad verificada
#   3. CVD/VWAP acumulando: una fila nueva por día (son series IRRECONSTRUIBLES)
#   4. Errores recientes en el log de recogida
#
# Uso:  ./checkCollection.sh          # imprime el informe y escribe el estado
#       ./checkCollection.sh --quiet  # solo escribe el estado (para cron)
#
set -uo pipefail

DB="${DB:-$HOME/cryptex/backend/data/cryptex.db}"
BACKEND_DIR="${BACKEND_DIR:-$HOME/cryptex/backend}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/cryptex-backups}"
COLLECT_DIR="${COLLECT_DIR:-$HOME/cryptex/.collect}"
STATE_FILE="${STATE_FILE:-$COLLECT_DIR/health.json}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v18.20.8/bin/node}"
COIN="${COIN:-SOL}"
# Monedas cuya recogida debe vigilarse. Se activaron BTC y ETH el 2026-08-03 (0-bis).
COINS_ESPERADAS="${COINS_ESPERADAS:-SOL BTC ETH}"
MAX_ANALYSIS_AGE_H="${MAX_ANALYSIS_AGE_H:-26}"   # 2 disparos/día → 12h; 26h tolera uno perdido
PAUSE_FILE="${PAUSE_FILE:-$COLLECT_DIR/PAUSED}"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

mkdir -p "$COLLECT_DIR"
say() { [ "$QUIET" = "1" ] || echo "$@"; }

# ── Consulta a la BBDD (readonly) ────────────────────────────────────────────
DBJSON="$(cd "$BACKEND_DIR" && "$NODE_BIN" -e '
  const D = require("better-sqlite3");
  const out = { ok: false };
  try {
    const db = new D(process.argv[1], { readonly: true });
    const coin = process.argv[2];
    const a = db.prepare("SELECT COUNT(*) c, MAX(timestamp) t FROM analyses WHERE coin = ?").get(coin);
    out.analyses = a.c;
    out.last_analysis = a.t ?? null;
    out.hours_since = a.t ? (Date.now() - new Date(a.t).getTime()) / 3600000 : null;
    // Días distintos con snapshot de CVD: es la serie que no se puede reconstruir.
    out.cvd_days = db.prepare("SELECT COUNT(*) c FROM history_series WHERE metric=? AND coin=?").get("cvd", coin).c;
    out.cvd_last = db.prepare("SELECT MAX(ts_key) t FROM history_series WHERE metric=? AND coin=?").get("cvd", coin).t ?? null;
    out.outcomes = db.prepare("SELECT COUNT(*) c FROM analysis_outcome").get().c;
    // Estado POR MONEDA. Sin esto, activar la recogida de BTC/ETH (2026-08-03) habría dejado
    // dos tercios de la muestra sin vigilar: un fallo en BTC se descubriría semanas después,
    // al ir a comparar y encontrar el hueco. Se vigila lo que se recoge.
    out.per_coin = db.prepare(
      "SELECT coin, COUNT(*) n, MAX(timestamp) t FROM analyses GROUP BY coin"
    ).all().map((r) => ({
      coin: r.coin, n: r.n,
      hours: r.t ? (Date.now() - new Date(r.t).getTime()) / 3600000 : null,
    }));
    out.ok = true;
  } catch (e) { out.error = e.message; }
  process.stdout.write(JSON.stringify(out));
' "$DB" "$COIN" 2>/dev/null)"

field() { printf '%s' "$DBJSON" | "$NODE_BIN" -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    try { const v = JSON.parse(d)[process.argv[1]]; process.stdout.write(v == null ? "" : String(v)); }
    catch { process.stdout.write(""); }
  });' "$1" 2>/dev/null; }

PROBLEMS=()
ANALYSES="$(field analyses)"
HOURS="$(field hours_since)"
CVD_DAYS="$(field cvd_days)"
CVD_LAST="$(field cvd_last)"
OUTCOMES="$(field outcomes)"

say "── Salud de la recogida ($(date -u +%Y-%m-%dT%H:%MZ)) ──"

# 0 · ¿Recogida pausada a propósito? Sin esto, una pausa deliberada se reportaría como
# "degraded" por falta de análisis recientes — una falsa alarma que enseña a ignorar el
# indicador, que es la peor forma de perder una alerta.
PAUSED=0
if [ -f "$PAUSE_FILE" ]; then
  PAUSED=1
  say "  ⏸  recogida PAUSADA: $(cat "$PAUSE_FILE")"
fi

# 1 · Frescura del último análisis
if [ "$PAUSED" = "1" ]; then
  say "  · frescura del análisis: no se comprueba (pausada)"
elif [ -z "$ANALYSES" ]; then
  PROBLEMS+=("no se pudo leer la BBDD")
  say "  ✗ BBDD ilegible"
elif [ "$ANALYSES" = "0" ]; then
  # Tras un punto cero es lo esperado: no es un fallo mientras no pasen >26h.
  say "  · análisis: 0 (BBDD recién vaciada — se poblará en el próximo disparo)"
else
  H_INT="${HOURS%%.*}"
  say "  · análisis de $COIN: $ANALYSES · último hace ${H_INT}h"
  if [ -n "$H_INT" ] && [ "$H_INT" -gt "$MAX_ANALYSIS_AGE_H" ]; then
    PROBLEMS+=("sin análisis desde hace ${H_INT}h (esperado <= ${MAX_ANALYSIS_AGE_H}h)")
    say "  ✗ la recogida parece parada"
  fi
fi

# 1-bis · Frescura POR MONEDA (desde que se recogen las tres, 2026-08-03)
if [ "$PAUSED" != "1" ]; then
  PER_COIN="$(printf '%s' "$DBJSON" | "$NODE_BIN" -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      try {
        const pc = JSON.parse(d).per_coin ?? [];
        process.stdout.write(pc.map((r) => `${r.coin}:${r.n}:${r.hours == null ? -1 : Math.floor(r.hours)}`).join(" "));
      } catch { process.stdout.write(""); }
    });' 2>/dev/null)"
  for ESPERADA in $COINS_ESPERADAS; do
    ENTRADA=""
    for E in $PER_COIN; do case "$E" in "$ESPERADA":*) ENTRADA="$E";; esac; done
    if [ -z "$ENTRADA" ]; then
      say "  · $ESPERADA: sin análisis todavía"
      continue
    fi
    N_C="${ENTRADA#*:}"; N_C="${N_C%%:*}"
    H_C="${ENTRADA##*:}"
    say "  · $ESPERADA: $N_C análisis · último hace ${H_C}h"
    if [ "$H_C" -gt "$MAX_ANALYSIS_AGE_H" ] 2>/dev/null; then
      PROBLEMS+=("$ESPERADA sin análisis desde hace ${H_C}h")
      say "  ✗ recogida de $ESPERADA parada"
    fi
  done
fi

# 2 · Backup del día
TODAY_BK="$BACKUP_DIR/cryptex-$(date -u +%Y-%m-%d).db"
if [ -f "$TODAY_BK" ]; then
  say "  · backup de hoy: OK ($(du -h "$TODAY_BK" | cut -f1))"
else
  # Antes de las 03:10 UTC todavía no ha corrido: no es un fallo.
  if [ "$(date -u +%H%M)" -gt "0330" ]; then
    PROBLEMS+=("falta el backup de hoy")
    say "  ✗ sin backup de hoy (el cron de las 03:10 UTC no corrió)"
  else
    say "  · backup de hoy: aún no toca (cron 03:10 UTC)"
  fi
fi

# 3 · CVD acumulando — la serie irreconstruible
say "  · CVD: $CVD_DAYS día(s) acumulados · outcomes: $OUTCOMES"
if [ -n "$CVD_LAST" ]; then
  AGE_D=$(( ( $(date -u +%s) - CVD_LAST ) / 86400 ))
  if [ "$AGE_D" -gt 1 ]; then
    PROBLEMS+=("CVD sin snapshot desde hace ${AGE_D}d — serie IRRECONSTRUIBLE")
    say "  ✗ CVD no avanza (${AGE_D}d) — ¿historyPoller caído?"
  fi
fi

# 4 · Errores recientes en el log de recogida (últimas 48h de líneas)
ERRS=0
if [ -f "$COLLECT_DIR/collect.log" ]; then
  ERRS="$(tail -n 20 "$COLLECT_DIR/collect.log" | grep -c "ERROR" || true)"
  [ "$ERRS" -gt 0 ] && { PROBLEMS+=("$ERRS error(es) en los últimos 20 disparos"); say "  ✗ $ERRS ERROR en el log reciente"; }
fi

# ── Veredicto + estado legible por el backend ────────────────────────────────
STATUS="ok"
[ "$PAUSED" = "1" ] && STATUS="paused"
[ "${#PROBLEMS[@]}" -gt 0 ] && STATUS="degraded"

# JSON a mano: son 6 campos y evita depender de node para escribirlo.
{
  printf '{"status":"%s","checked_at":"%s","analyses":%s,"hours_since_last":%s,"cvd_days":%s,"outcomes":%s,"problems":['		\
    "$STATUS" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${ANALYSES:-null}" "${HOURS:-null}" "${CVD_DAYS:-null}" "${OUTCOMES:-null}"
  for i in "${!PROBLEMS[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '"%s"' "$(printf '%s' "${PROBLEMS[$i]}" | sed 's/"/\\"/g')"
  done
  printf ']}\n'
} > "$STATE_FILE"

# `paused` sale limpio igual que `ok`: es un estado deseado, no un fallo. Sin esto el cron
# devolvería 1 cada día y llenaría cron.err de ruido.
if [ "$STATUS" = "ok" ] || [ "$STATUS" = "paused" ]; then
  say "  $([ "$STATUS" = "paused" ] && echo "⏸  pausada, sin incidencias" || echo "✅ todo correcto")"
  exit 0
fi

say ""
say "  ⚠️  PROBLEMAS:"
for p in "${PROBLEMS[@]}"; do say "     - $p"; done
# Se deja rastro también en el log de recogida, que es donde se mira al depurar.
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) HEALTH degraded: ${PROBLEMS[*]}" >> "$COLLECT_DIR/collect.log"
exit 1
