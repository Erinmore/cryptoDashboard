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
# ⚠️ MARCADOR POR MONEDA (2026-08-03). Era un fichero ÚNICO compartido, y con la recogida de
# tres monedas eso convertía el freno 1 ("un oportunista al día") en "un oportunista al día EN
# TOTAL": la primera moneda en disparar bloqueaba a las otras dos hasta la medianoche. Y como
# el cron va 33/35/37, SOL habría ganado la carrera SIEMPRE — un sesgo sistemático, no
# aleatorio, justo en la comparación entre monedas que motiva recogerlas. El freno es por
# moneda porque cada moneda es su propia muestra.
MARKER="${MARKER:-$LOG_DIR/last-opportunistic-$COIN.date}"
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
  # OJO con `return` de primer nivel: `node -e` NO envuelve el script en el wrapper de módulo
  # de CommonJS, así que un return suelto es "SyntaxError: Illegal return statement". Esa era
  # la razón de que este freno nunca funcionara: el nodo moría, el 2>/dev/null se tragaba el
  # error, RECENT quedaba vacío y el disparo seguía adelante. Se vio en producción el
  # 2026-07-27 (dos oportunistas con 59 min de diferencia). Toda la lógica va en la función.
  # shellcheck disable=SC2016  # process.argv es de JS, no del shell
  RECENT="$(cd "$BACKEND_DIR" && "$NODE_BIN" -e '
    const D = require("better-sqlite3");
    const recent = () => {
      const db = new D(process.argv[1], { readonly: true });
      const r = db.prepare("SELECT MAX(timestamp) t FROM analyses WHERE coin = ?").get(process.argv[2]);
      if (!r?.t) return "0";
      const hours = (Date.now() - new Date(r.t).getTime()) / 3600000;
      return hours < Number(process.argv[3]) ? "1" : "0";
    };
    try { process.stdout.write(recent()); }
    catch { process.stdout.write("0"); }  // ante duda, no bloquear el disparo
  ' "$DB" "$COIN" "$MIN_GAP_HOURS" 2>>"$LOG")"
  # Salida inesperada (vacía o distinta de 0/1) = el chequeo no se pudo hacer. Se anota: un
  # freno que falla en silencio es peor que no tenerlo, porque da falsa sensación de control.
  case "$RECENT" in
    1) exit 0 ;;
    0) ;;
    *) echo "$TS reason=opportunistic-check WARN freno_2h_indeterminado salida=\"$RECENT\"" >> "$LOG" ;;
  esac
fi

# ── ¿Se activa alguna condición? (payload gratis, sin LLM) ───────────────────
PAYLOAD="$(curl -s --max-time 60 "$API/api/analyze/payload?coin=$COIN&primary_tf=$TF" 2>/dev/null)"
[ -z "$PAYLOAD" ] && { echo "$TS reason=opportunistic-check ERROR payload_vacio" >> "$LOG"; exit 1; }

# Se dispara en la TRANSICIÓN, no mientras la condición persista.
#
# El disparador se diseñó para un evento RARO: el veto no había saltado nunca. Tras la
# recalibración de umbrales (2026-07-26) puede estar activo la mayor parte del tiempo, y un
# disparador que reacciona a la persistencia deja de ser oportunista: se convierte en un
# muestreo CONDICIONADO a que el veto esté activo. En 14 días serían hasta 14 observaciones
# extra sesgadas hacia ese estado, sobre 28 programadas — la distribución del checkpoint
# saldría inflada hacia justo el caso que el disparador selecciona.
#
# Comparando con el estado del chequeo anterior, solo se dispara con condiciones NUEVAS, que
# es lo que la intención original pedía: capturar el momento en que el camino se activa.
# ⚠️ ESTADO POR MONEDA (2026-08-03). Era un fichero ÚNICO, y con tres monedas cada una habría
# comparado sus condiciones contra las de LA MONEDA ANTERIOR (SOL :33 → BTC :35 → ETH :37), no
# contra las suyas del chequeo previo. Eso no bloquea el disparo: CORROMPE la detección de
# transición — inventa condiciones "nuevas" que solo son diferencias entre monedas y tapa las
# reales cuando coinciden. Segundo fichero de estado compartido del mismo script (el otro era
# el marcador diario); los dos eran invisibles mientras solo se recogía una moneda.
STATE_FILE="${STATE_FILE:-$LOG_DIR/last-gating-state-$COIN}"
PREV="$(cat "$STATE_FILE" 2>/dev/null || true)"

# shellcheck disable=SC2016  # las plantillas son de JS, no del shell
HITS="$(printf '%s' "$PAYLOAD" | "$NODE_BIN" -e '
let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
  try {
    const p = JSON.parse(d).payload ?? {};
    const g = p.gating ?? {};
    const oi = p.derivatives?.open_interest?.change_24h_pct;
    const chg = p.price_change_24h_pct;
    const hits = [];

    // Caminos endurecidos del gating.
    if (g.veto_long)         hits.push("veto_long");
    if (g.veto_short)        hits.push("veto_short");
    if (g.data_insufficient) hits.push("data_insufficient");
    // Régimen distinto del rango en el que se ha muestreado hasta ahora. Sin el valor en la
    // etiqueta: si fuera "oi_expandiendo_3.4pct" cada décima sería una condición "nueva" y
    // la comparación con el estado anterior no serviría de nada.
    if (typeof oi === "number" && oi > 3)             hits.push("oi_expandiendo");
    if (typeof chg === "number" && Math.abs(chg) > 5) hits.push("mov_24h_fuerte");

    process.stdout.write(hits.join(" "));
  } catch { process.stdout.write(""); }
});' 2>>"$LOG")"

# Estado actual guardado SIEMPRE, dispare o no: si solo se guardara al disparar, una
# condición que persiste volvería a contar como nueva en el siguiente chequeo.
printf '%s' "$HITS" > "$STATE_FILE"

[ -z "$HITS" ] && exit 0   # nada activo

# Condiciones presentes ahora que NO estaban en el chequeo anterior.
NUEVAS=""
for h in $HITS; do
  case " $PREV " in
    *" $h "*) ;;                                     # ya estaba → persistencia, no evento
    *) NUEVAS="${NUEVAS:+$NUEVAS+}$h" ;;
  esac
done

if [ -z "$NUEVAS" ]; then
  # Traza deliberada: sin ella parecería que el disparador está muerto, cuando en realidad
  # está haciendo justo su trabajo (no re-muestrear un estado que ya se capturó).
  echo "$TS reason=opportunistic-check persiste=\"$HITS\" sin_transicion" >> "$LOG"
  exit 0
fi

# ── Disparo ──────────────────────────────────────────────────────────────────
echo "$TODAY" > "$MARKER"
echo "$TS TRIGGER oportunista: $NUEVAS (estado previo: ${PREV:-vacío})" >> "$LOG"
exec "$SCRIPT_DIR/collect.sh" "opportunistic:$NUEVAS"
