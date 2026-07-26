#!/usr/bin/env bash
#
# collectOpportunistic.sh — dispara un análisis SOLO si el mercado activa un camino
# que la muestra todavía no ha ejercitado. Pensado para cron horario EN LA PI.
#
# Motivación (ver SESSION_STATE §2 y §4.4): tras el sprint de gating quedaron caminos
# endurecidos que NUNCA han disparado en producción (veto determinista, fail-closed H2).
# Un análisis lanzado justo cuando se activan vale mucho más que uno más en rango.
#
# Consultar el payload es GRATIS (no llama al LLM); solo el POST /api/analyze cuesta.
#
# Dos frenos para no dispararse de más:
#   1. Tope de 1 disparo oportunista al día (fichero marcador con la fecha).
#   2. Skip si YA hay un análisis reciente (<MIN_GAP_HOURS) — evita duplicar el disparo
#      programado de collect.sh y respeta también los que lance el usuario a mano.
#
set -uo pipefail

COIN="${COIN:-SOL}"
TF="${TF:-4h}"
API="${API:-http://localhost:8080}"
LOG_DIR="${LOG_DIR:-$HOME/cryptex/.collect}"
LOG="${LOG:-$LOG_DIR/collect.log}"
MARKER="${MARKER:-$LOG_DIR/last-opportunistic.date}"
DB="${DB:-$HOME/cryptex/backend/data/cryptex.db}"
BACKEND_DIR="${BACKEND_DIR:-$HOME/cryptex/backend}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v18.20.8/bin/node}"
MIN_GAP_HOURS="${MIN_GAP_HOURS:-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$LOG_DIR"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TODAY="$(date -u +%Y-%m-%d)"

# ── Freno 1: ¿ya se disparó un oportunista hoy? ──────────────────────────────
if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$TODAY" ]; then
  exit 0
fi

# ── Freno 2: ¿hay un análisis demasiado reciente? ────────────────────────────
# Se consulta la BBDD (readonly) en vez del log: así cuenta también lo que lance
# el usuario desde la UI, no solo lo que dispare el cron.
if [ -f "$DB" ]; then
  RECENT="$(cd "$BACKEND_DIR" && "$NODE_BIN" -e '
    const D = require("better-sqlite3");
    try {
      const db = new D(process.argv[1], { readonly: true });
      const r = db.prepare("SELECT MAX(timestamp) t FROM analyses WHERE coin = ?").get(process.argv[2]);
      if (!r?.t) return process.stdout.write("0");
      const hours = (Date.now() - new Date(r.t).getTime()) / 3600000;
      process.stdout.write(hours < Number(process.argv[3]) ? "1" : "0");
    } catch { process.stdout.write("0"); }  // ante duda, no bloquear el disparo
  ' "$DB" "$COIN" "$MIN_GAP_HOURS" 2>/dev/null)"
  [ "$RECENT" = "1" ] && exit 0
fi

# ── ¿Se activa alguna condición? (payload gratis, sin LLM) ───────────────────
PAYLOAD="$(curl -s --max-time 60 "$API/api/analyze/payload?coin=$COIN&primary_tf=$TF" 2>/dev/null)"
[ -z "$PAYLOAD" ] && { echo "$TS reason=opportunistic-check ERROR payload_vacio" >> "$LOG"; exit 1; }

REASON="$(printf '%s' "$PAYLOAD" | "$NODE_BIN" -e '
let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
  try {
    const p = JSON.parse(d).payload ?? {};
    const g = p.gating ?? {};
    const oi = p.derivatives?.open_interest?.change_24h_pct;
    const chg = p.price_change_24h_pct;
    const hits = [];

    // Caminos endurecidos que nunca han disparado en producción — máxima prioridad.
    if (g.veto_long)         hits.push("veto_long");
    if (g.veto_short)        hits.push("veto_short");
    if (g.data_insufficient) hits.push("data_insufficient");
    // Régimen distinto del rango en el que se ha muestreado hasta ahora.
    if (typeof oi === "number" && oi > 3)          hits.push(`oi_expandiendo_${oi}pct`);
    if (typeof chg === "number" && Math.abs(chg) > 5) hits.push(`mov_24h_${chg}pct`);

    process.stdout.write(hits.join("+"));
  } catch { process.stdout.write(""); }
});' 2>/dev/null)"

[ -z "$REASON" ] && exit 0   # nada que ver hoy

# ── Disparo ──────────────────────────────────────────────────────────────────
echo "$TODAY" > "$MARKER"
echo "$TS TRIGGER oportunista: $REASON" >> "$LOG"
exec "$SCRIPT_DIR/collect.sh" "opportunistic:$REASON"
