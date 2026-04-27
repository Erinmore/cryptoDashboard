#!/usr/bin/env bash
# CRYPTEX dev launcher — menú interactivo para gestionar backend y frontend.
# Uso: ./scripts/dev.sh  (desde cualquier directorio)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE_BACKEND="$ROOT/.dev/backend.pid"
PIDFILE_FRONTEND="$ROOT/.dev/frontend.pid"
LOGFILE_BACKEND="$ROOT/.dev/backend.log"
LOGFILE_FRONTEND="$ROOT/.dev/frontend.log"

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
    echo -e "${YELLOW}Backend ya está corriendo (pid $(cat "$PIDFILE_BACKEND")).${RESET}"
    return
  fi
  echo -e "${CYAN}[CRYPTEX]${RESET} Arrancando backend → http://localhost:3000"
  (cd "$ROOT/backend" && npm run dev >> "$LOGFILE_BACKEND" 2>&1) &
  echo $! > "$PIDFILE_BACKEND"
  echo -e "${GREEN}Backend arrancado (pid $!). Log: .dev/backend.log${RESET}"
}

start_frontend() {
  if is_running "$PIDFILE_FRONTEND"; then
    echo -e "${YELLOW}Frontend ya está corriendo (pid $(cat "$PIDFILE_FRONTEND")).${RESET}"
    return
  fi
  echo -e "${CYAN}[CRYPTEX]${RESET} Arrancando frontend → http://localhost:5173"
  (cd "$ROOT/frontend" && npm run dev >> "$LOGFILE_FRONTEND" 2>&1) &
  echo $! > "$PIDFILE_FRONTEND"
  echo -e "${GREEN}Frontend arrancado (pid $!). Log: .dev/frontend.log${RESET}"
}

stop_process() {
  local name="$1" pidfile="$2"
  if is_running "$pidfile"; then
    local pid
    pid=$(cat "$pidfile")
    # Matar el grupo de procesos para capturar hijos (node --watch, vite, etc.)
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
    echo -e "${RED}$name parado (pid $pid).${RESET}"
  else
    echo -e "${DIM}$name no estaba corriendo.${RESET}"
    rm -f "$pidfile"
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
  echo -e "${BOLD}  Logs${RESET}"
  echo -e "  ${CYAN}7${RESET})  Ver últimas líneas  (ambos)"
  echo -e "  ${CYAN}8${RESET})  Ver últimas líneas  (backend)"
  echo -e "  ${CYAN}9${RESET})  Ver últimas líneas  (frontend)"
  echo -e "  ${CYAN}f${RESET})  Seguir en tiempo real (ambos — Ctrl+C para volver)"
  echo -e "  ${CYAN}b${RESET})  Seguir backend en tiempo real"
  echo -e "  ${CYAN}v${RESET})  Seguir frontend en tiempo real"
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
      [[ "$target" == "both" || "$target" == "backend"  ]] && stop_process "Backend"  "$PIDFILE_BACKEND"
      [[ "$target" == "both" || "$target" == "frontend" ]] && stop_process "Frontend" "$PIDFILE_FRONTEND"
      ;;
    logs)
      show_logs "$target"
      ;;
    follow)
      follow_logs "$target"
      ;;
    *)
      echo "Uso: dev.sh [start|stop|logs|follow] [backend|frontend|both]"
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
      stop_process "Backend"  "$PIDFILE_BACKEND"
      stop_process "Frontend" "$PIDFILE_FRONTEND"
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    5)
      stop_process "Backend" "$PIDFILE_BACKEND"
      echo ""
      read -rp "  Pulsa Enter para volver al menú..." _
      ;;
    6)
      stop_process "Frontend" "$PIDFILE_FRONTEND"
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
    q|Q)
      echo -e "${DIM}Saliendo del launcher. Los procesos siguen corriendo en background.${RESET}"
      exit 0
      ;;
    *)
      ;;
  esac
done
