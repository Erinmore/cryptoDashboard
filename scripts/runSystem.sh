#!/usr/bin/env bash
# CRYPTEX dev launcher — menú interactivo para gestionar backend y frontend.
# Uso: ./scripts/dev.sh  (desde cualquier directorio)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE_BACKEND="$ROOT/.dev/backend.pid"
PIDFILE_FRONTEND="$ROOT/.dev/frontend.pid"
LOGFILE_BACKEND="$ROOT/.dev/backend.log"
LOGFILE_FRONTEND="$ROOT/.dev/frontend.log"
BACKEND_PORT=3000
FRONTEND_PORT=5173

# ── Colores ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── nvm ───────────────────────────────────────────────────────────────────────
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# ── Helpers ───────────────────────────────────────────────────────────────────

mkdir -p "$ROOT/.dev"

is_running() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

# Comprueba si un puerto TCP local está en LISTEN (independiente del pidfile —
# detecta backends huérfanos o procesos ajenos que ocupan el puerto).
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | grep -qE "[:.]${port}[[:space:]]"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1
  else
    return 1  # sin herramienta para comprobar → asumimos libre
  fi
}

# Muestra el/los PID que escuchan en un puerto (best-effort, para diagnóstico).
port_owner() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH 2>/dev/null | grep -E "[:.]${port}[[:space:]]" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN -n -P 2>/dev/null || true
  fi
}

# Espera (hasta ~4s) a que un puerto quede libre tras un stop.
wait_port_free() {
  local port="$1" tries=20
  while port_in_use "$port" && (( tries-- > 0 )); do sleep 0.2; done
}

# Mata el árbol completo de un PID vía su process group real (no el PID del
# subshell). npm → node --watch → server comparten PGID, así que matar el grupo
# los tumba a todos y no deja huérfanos (el `node --watch` padre incluido).
kill_tree() {
  local pid="$1" pgid
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [[ -n "$pgid" ]]; then
    kill -- -"$pgid" 2>/dev/null || true
  else
    kill "$pid" 2>/dev/null || true
  fi
}

status_badge() {
  local pidfile="$1"
  if is_running "$pidfile"; then
    echo -e "${GREEN}● running${RESET} (pid $(cat "$pidfile"))"
  else
    echo -e "${DIM}○ stopped${RESET}"
  fi
}

start_backend() {
  if is_running "$PIDFILE_BACKEND"; then
    echo -e "${YELLOW}Backend ya está corriendo (pid $(cat "$PIDFILE_BACKEND")). Usa 'restart' para reiniciarlo.${RESET}"
    return
  fi
  # El pidfile puede estar muerto pero otro proceso (backend huérfano o ajeno)
  # seguir ocupando el puerto → arrancar aquí daría EADDRINUSE. Comprobarlo antes.
  if port_in_use "$BACKEND_PORT"; then
    echo -e "${RED}El puerto :$BACKEND_PORT ya está ocupado (proceso no gestionado por este launcher).${RESET}"
    echo -e "${DIM}Ocupado por: $(port_owner "$BACKEND_PORT" | paste -sd' ' -)${RESET}"
    echo -e "${DIM}Usa 'stop backend' si es un backend huérfano, o libera el puerto antes de arrancar.${RESET}"
    return 1
  fi
  echo -e "${CYAN}[CRYPTEX]${RESET} Arrancando backend → http://localhost:3000"
  (cd "$ROOT/backend" && npm run dev >> "$LOGFILE_BACKEND" 2>&1) &
  echo $! > "$PIDFILE_BACKEND"
  echo -e "${GREEN}Backend arrancado (pid $!). Log: .dev/backend.log${RESET}"
}

start_frontend() {
  if is_running "$PIDFILE_FRONTEND"; then
    echo -e "${YELLOW}Frontend ya está corriendo (pid $(cat "$PIDFILE_FRONTEND")). Usa 'restart' para reiniciarlo.${RESET}"
    return
  fi
  if port_in_use "$FRONTEND_PORT"; then
    echo -e "${RED}El puerto :$FRONTEND_PORT ya está ocupado (proceso no gestionado por este launcher).${RESET}"
    echo -e "${DIM}Ocupado por: $(port_owner "$FRONTEND_PORT" | paste -sd' ' -)${RESET}"
    echo -e "${DIM}Usa 'stop frontend' si es un frontend huérfano, o libera el puerto antes de arrancar.${RESET}"
    return 1
  fi
  echo -e "${CYAN}[CRYPTEX]${RESET} Arrancando frontend → http://localhost:5173"
  (cd "$ROOT/frontend" && npm run dev >> "$LOGFILE_FRONTEND" 2>&1) &
  echo $! > "$PIDFILE_FRONTEND"
  echo -e "${GREEN}Frontend arrancado (pid $!). Log: .dev/frontend.log${RESET}"
}

stop_process() {
  local name="$1" pidfile="$2" port="${3:-}"
  if is_running "$pidfile"; then
    local pid
    pid=$(cat "$pidfile")
    kill_tree "$pid"   # mata el grupo entero (npm, node --watch, server)
    rm -f "$pidfile"
    echo -e "${RED}$name parado (pid $pid).${RESET}"
  else
    echo -e "${DIM}$name no estaba corriendo.${RESET}"
    rm -f "$pidfile"
  fi
  # Limpieza de huérfanos: si el puerto sigue ocupado (proceso no trackeado por el
  # pidfile, p.ej. un arranque previo que quedó colgado), matar el árbol de quien
  # lo tenga — vía su process group, para arrastrar también al `node --watch` padre.
  if [[ -n "$port" ]] && port_in_use "$port"; then
    local owners opid
    owners=$(port_owner "$port")
    if [[ -n "$owners" ]]; then
      echo -e "${YELLOW}  Liberando :$port ocupado por proceso huérfano (pid $(echo "$owners" | paste -sd' ' -))...${RESET}"
      for opid in $owners; do kill_tree "$opid"; done
      wait_port_free "$port"
    fi
  fi
}

show_logs() {
  local target="$1"   # backend | frontend | both
  local lines="${2:-60}"

  case "$target" in
    backend)
      echo -e "${GREEN}── Backend log (últimas $lines líneas) ─────────────────${RESET}"
      tail -n "$lines" "$LOGFILE_BACKEND" 2>/dev/null || echo "(sin log aún)"
      ;;
    frontend)
      echo -e "${CYAN}── Frontend log (últimas $lines líneas) ────────────────${RESET}"
      tail -n "$lines" "$LOGFILE_FRONTEND" 2>/dev/null || echo "(sin log aún)"
      ;;
    both)
      echo -e "${GREEN}── Backend log (últimas $lines líneas) ─────────────────${RESET}"
      tail -n "$lines" "$LOGFILE_BACKEND" 2>/dev/null || echo "(sin log aún)"
      echo ""
      echo -e "${CYAN}── Frontend log (últimas $lines líneas) ────────────────${RESET}"
      tail -n "$lines" "$LOGFILE_FRONTEND" 2>/dev/null || echo "(sin log aún)"
      ;;
  esac
}

follow_logs() {
  local target="$1"   # backend | frontend | both
  echo -e "${DIM}Ctrl+C para volver al menú${RESET}"
  echo ""
  case "$target" in
    backend)
      tail -f "$LOGFILE_BACKEND" 2>/dev/null | sed "s/^/${GREEN}[backend]${RESET} /" ;;
    frontend)
      tail -f "$LOGFILE_FRONTEND" 2>/dev/null | sed "s/^/${CYAN}[frontend]${RESET} /" ;;
    both)
      tail -f "$LOGFILE_BACKEND"  2>/dev/null | sed "s/^/${GREEN}[backend] ${RESET}/" &
      TAIL_PID=$!
      tail -f "$LOGFILE_FRONTEND" 2>/dev/null | sed "s/^/${CYAN}[frontend]${RESET}/" &
      TAIL_PID2=$!
      wait "$TAIL_PID" "$TAIL_PID2" 2>/dev/null || true
      kill "$TAIL_PID" "$TAIL_PID2" 2>/dev/null || true
      ;;
  esac
}

# ── Datos consolidados en BBDD ─────────────────────────────────────────────────

db_stats() {
  ( cd "$ROOT/backend" && node scripts/dbStats.mjs )
}

db_clear() {
  local target="$1"   # history | analyses | all
  ( cd "$ROOT/backend" && node scripts/dbClear.mjs "$target" )
}

db_clear_menu() {
  echo -e "${BOLD}  Vaciar datos de la BBDD${RESET}"
  echo -e "  ${YELLOW}1${RESET})  Solo históricos       (history_series)"
  echo -e "  ${YELLOW}2${RESET})  Solo análisis IA      (analyses + snapshots)"
  echo -e "  ${YELLOW}3${RESET})  Todo"
  echo -e "  ${DIM}c)  Cancelar${RESET}"
  echo ""
  echo -n "  Opción: "
  read -r sub

  local target=""
  case "$sub" in
    1) target="history" ;;
    2) target="analyses" ;;
    3) target="all" ;;
    *) echo -e "  ${DIM}Cancelado.${RESET}"; return ;;
  esac

  if is_running "$PIDFILE_BACKEND"; then
    echo -e "  ${YELLOW}Aviso:${RESET} el backend está corriendo; mantiene CVD/VWAP en memoria hasta reiniciarlo."
  fi
  echo -en "  ${RED}Escribe SI para confirmar el borrado (${target}):${RESET} "
  read -r confirm
  if [[ "$confirm" == "SI" ]]; then
    db_clear "$target"
  else
    echo -e "  ${DIM}Cancelado (no se escribió SI).${RESET}"
  fi
}

print_header() {
  clear
  echo -e "${BOLD}╔══════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   CRYPTEX  dev  launcher         ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  Backend   $(status_badge "$PIDFILE_BACKEND")"
  echo -e "  Frontend  $(status_badge "$PIDFILE_FRONTEND")"
  echo ""
}

print_menu() {
  echo -e "${BOLD}  Arrancar${RESET}"
  echo -e "  ${GREEN}1${RESET})  Ambos  (backend + frontend)"
  echo -e "  ${GREEN}2${RESET})  Solo backend   (:3000)"
  echo -e "  ${GREEN}3${RESET})  Solo frontend  (:5173)"
  echo ""
  echo -e "${BOLD}  Parar${RESET}"
  echo -e "  ${RED}4${RESET})  Ambos"
  echo -e "  ${RED}5${RESET})  Solo backend"
  echo -e "  ${RED}6${RESET})  Solo frontend"
  echo ""
  echo -e "${BOLD}  Reiniciar${RESET} ${DIM}(stop + start, libera puertos huérfanos)${RESET}"
  echo -e "  ${GREEN}r${RESET})  Ambos     ${GREEN}rb${RESET})  Solo backend     ${GREEN}rv${RESET})  Solo frontend"
  echo ""
  echo -e "${BOLD}  Logs${RESET}"
  echo -e "  ${CYAN}7${RESET})  Ver últimas líneas  (ambos)"
  echo -e "  ${CYAN}8${RESET})  Ver últimas líneas  (backend)"
  echo -e "  ${CYAN}9${RESET})  Ver últimas líneas  (frontend)"
  echo -e "  ${CYAN}f${RESET})  Seguir en tiempo real (ambos — Ctrl+C para volver)"
  echo -e "  ${CYAN}b${RESET})  Seguir backend en tiempo real"
  echo -e "  ${CYAN}v${RESET})  Seguir frontend en tiempo real"
  echo ""
  echo -e "${BOLD}  Datos (BBDD)${RESET}"
  echo -e "  ${YELLOW}d${RESET})  Ver datos consolidados  (registros por tabla/serie, rango histórico)"
  echo -e "  ${YELLOW}x${RESET})  Vaciar históricos / análisis"
  echo ""
  echo -e "  ${DIM}q)  Salir (los procesos siguen corriendo)${RESET}"
  echo ""
  echo -n "  Opción: "
}

# ── Modo no-interactivo: argumentos directos ──────────────────────────────────
# Uso: dev.sh start|stop|logs [backend|frontend|both]
if [[ $# -ge 1 ]]; then
  cmd="$1"
  target="${2:-both}"
  case "$cmd" in
    start)
      [[ "$target" == "both" || "$target" == "backend"  ]] && start_backend
      [[ "$target" == "both" || "$target" == "frontend" ]] && start_frontend
      ;;
    stop)
      [[ "$target" == "both" || "$target" == "backend"  ]] && stop_process "Backend"  "$PIDFILE_BACKEND"  "$BACKEND_PORT"
      [[ "$target" == "both" || "$target" == "frontend" ]] && stop_process "Frontend" "$PIDFILE_FRONTEND" "$FRONTEND_PORT"
      ;;
    restart)
      if [[ "$target" == "both" || "$target" == "backend" ]]; then
        stop_process "Backend" "$PIDFILE_BACKEND" "$BACKEND_PORT"; start_backend
      fi
      if [[ "$target" == "both" || "$target" == "frontend" ]]; then
        stop_process "Frontend" "$PIDFILE_FRONTEND" "$FRONTEND_PORT"; start_frontend
      fi
      ;;
    logs)
      show_logs "$target"
      ;;
    follow)
      follow_logs "$target"
      ;;
    db)
      # Uso: runSystem.sh db [stats|clear] [history|analyses|all]
      sub="${2:-stats}"
      case "$sub" in
        stats) db_stats ;;
        clear)
          ctarget="${3:-}"
          case "$ctarget" in
            history|analyses|all) db_clear "$ctarget" ;;
            *) echo "Uso: runSystem.sh db clear [history|analyses|all]"; exit 1 ;;
          esac
          ;;
        *) echo "Uso: runSystem.sh db [stats|clear] [history|analyses|all]"; exit 1 ;;
      esac
      ;;
    *)
      echo "Uso: dev.sh [start|stop|restart|logs|follow] [backend|frontend|both]"
      echo "     dev.sh db [stats|clear] [history|analyses|all]"
      exit 1
      ;;
  esac
  exit 0
fi

# ── Menú interactivo ──────────────────────────────────────────────────────────
while true; do
  print_header
  print_menu
  read -r opt

  case "$opt" in
    1)
      start_backend
      sleep 0.8
      start_frontend
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    2)
      start_backend
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    3)
      start_frontend
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    4)
      stop_process "Backend"  "$PIDFILE_BACKEND"  "$BACKEND_PORT"
      stop_process "Frontend" "$PIDFILE_FRONTEND" "$FRONTEND_PORT"
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    5)
      stop_process "Backend" "$PIDFILE_BACKEND" "$BACKEND_PORT"
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    6)
      stop_process "Frontend" "$PIDFILE_FRONTEND" "$FRONTEND_PORT"
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    r|R)
      stop_process "Backend"  "$PIDFILE_BACKEND"  "$BACKEND_PORT";  start_backend
      sleep 0.8
      stop_process "Frontend" "$PIDFILE_FRONTEND" "$FRONTEND_PORT"; start_frontend
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    rb|RB)
      stop_process "Backend" "$PIDFILE_BACKEND" "$BACKEND_PORT"; start_backend
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    rv|RV)
      stop_process "Frontend" "$PIDFILE_FRONTEND" "$FRONTEND_PORT"; start_frontend
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    7)
      echo ""
      show_logs both 80
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    8)
      echo ""
      show_logs backend 80
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    9)
      echo ""
      show_logs frontend 80
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    f)
      echo ""
      follow_logs both || true
      ;;
    b)
      echo ""
      follow_logs backend || true
      ;;
    v)
      echo ""
      follow_logs frontend || true
      ;;
    d|D)
      echo ""
      db_stats || true
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    x|X)
      echo ""
      db_clear_menu || true
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    q|Q)
      echo -e "${DIM}Saliendo del launcher. Los procesos siguen corriendo en background.${RESET}"
      exit 0
      ;;
    *)
      ;;
  esac
done
