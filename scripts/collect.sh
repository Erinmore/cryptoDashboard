#!/usr/bin/env bash
#
# collect.sh — lanza UN análisis de la fase de recogida y lo registra en el log.
#
# Pensado para correr desde cron EN LA PI. No reintenta: un fallo se anota y ya está
# (reintentar gastaría otra llamada al LLM y metería una observación casi duplicada,
# sesgando la muestra).
#
# Uso:
#   ./collect.sh              # motivo "fixed" (recogida programada)
#   ./collect.sh "veto_long"  # motivo libre (disparo oportunista, ver collectOpportunistic.sh)
#
# Variables de entorno (con defaults):
#   COIN / TF / MODEL   parámetros del análisis (fijos durante la recogida: ver SESSION_STATE §2)
#   API                 base de la API (http://localhost:8080)
#   LOG                 fichero de log
#
set -uo pipefail

REASON="${1:-fixed}"
COIN="${COIN:-SOL}"
TF="${TF:-4h}"
MODEL="${MODEL:-claude-opus-4-8}"
API="${API:-http://localhost:8080}"
LOG_DIR="${LOG_DIR:-$HOME/cryptex/.collect}"
LOG="${LOG:-$LOG_DIR/collect.log}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v18.20.8/bin/node}"

mkdir -p "$LOG_DIR"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START=$(date +%s)

# --max-time generoso: un análisis con Opus 4.8 tarda ~45s (visto 44.9s en producción).
BODY="$(curl -s --max-time 240 -w '\n%{http_code}' \
  -X POST "$API/api/analyze" \
  -H 'Content-Type: application/json' \
  -d "{\"coin\":\"$COIN\",\"primary_tf\":\"$TF\",\"model\":\"$MODEL\"}" 2>&1)"
CURL_RC=$?

HTTP="$(printf '%s' "$BODY" | tail -n1)"
JSON="$(printf '%s' "$BODY" | sed '$d')"
DUR=$(( $(date +%s) - START ))

if [ "$CURL_RC" -ne 0 ]; then
  echo "$TS reason=$REASON ERROR curl_rc=$CURL_RC dur=${DUR}s" >> "$LOG"
  exit 1
fi

if [ "$HTTP" != "200" ]; then
  # Body recortado: basta para diagnosticar sin inundar el log.
  SNIP="$(printf '%s' "$JSON" | tr -d '\n' | cut -c1-200)"
  echo "$TS reason=$REASON ERROR http=$HTTP dur=${DUR}s body=\"$SNIP\"" >> "$LOG"
  exit 1
fi

# Resumen legible del resultado (parse robusto con node, no con grep).
SUMMARY="$(printf '%s' "$JSON" | "$NODE_BIN" -e '
let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
  try {
    const r = JSON.parse(d), s = r.structured ?? {};
    const gate = s.fail_safe_applied ? " FAILSAFE" : "";
    process.stdout.write(
      `action=${s.action} conf=${s.confidence} conv=${s.conviction} ` +
      `risk=${s.risk_score} setup=${s.has_executable_setup ? 1 : 0}${gate}`
    );
  } catch { process.stdout.write("parse_error"); }
});' 2>/dev/null)"

echo "$TS reason=$REASON http=200 dur=${DUR}s $SUMMARY" >> "$LOG"
