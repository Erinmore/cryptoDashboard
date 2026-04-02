#!/usr/bin/env bash
# Arranca backend (:3000) y frontend (:5173) en paralelo.
# Uso: ./scripts/dev.sh  (desde la raíz del proyecto)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Activar nvm
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Colores
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo -e "${CYAN}[CRYPTEX]${RESET} Arrancando backend  → http://localhost:3000"
echo -e "${CYAN}[CRYPTEX]${RESET} Arrancando frontend → http://localhost:5173"
echo -e "${CYAN}[CRYPTEX]${RESET} Ctrl+C para parar ambos"
echo ""

# Matar ambos procesos al salir
cleanup() {
  echo ""
  echo -e "${CYAN}[CRYPTEX]${RESET} Parando..."
  kill -- -$$  2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Arrancar backend con prefijo en cada línea de log
(cd "$ROOT/backend"  && npm run dev 2>&1 | sed "s/^/${GREEN}[backend] ${RESET}/") &

# Pequeña pausa para que el backend arranque primero
sleep 1

# Arrancar frontend
(cd "$ROOT/frontend" && npm run dev 2>&1 | sed "s/^/${CYAN}[frontend]${RESET}/") &

wait
