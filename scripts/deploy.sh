#!/usr/bin/env bash
#
# deploy.sh — despliega CRYPTEX en la Raspberry Pi (deploy nativo + systemd).
#
# Modelo: un solo proceso Node (Express sirve API + frontend construido) en :8080,
# gestionado por systemd (cryptex.service). NO usa Docker ni reverse-proxy.
#
# Uso:
#   ./scripts/deploy.sh           # build frontend + sync código + restart servicio
#   ./scripts/deploy.sh --deps    # además reinstala deps del backend (npm ci)
#                                 # (usar solo cuando cambie package-lock.json —
#                                 #  recompila better-sqlite3 arm64, ~1-2 min)
#
# Variables de entorno (con defaults):
#   PI_HOST   destino SSH           (pi@192.168.1.250)
#   PI_DIR    ruta del proyecto Pi  (/home/pi/cryptex)
#   SERVICE   unit de systemd       (cryptex.service)
#   PORT      puerto de health-check (8080)
#
# Nota: el .env NO se sincroniza (contiene secretos y se gestiona en la Pi).
#
set -euo pipefail

PI_HOST="${PI_HOST:-pi@192.168.1.250}"
PI_DIR="${PI_DIR:-/home/pi/cryptex}"
SERVICE="${SERVICE:-cryptex.service}"
PORT="${PORT:-8080}"

INSTALL_DEPS=0
[ "${1:-}" = "--deps" ] && INSTALL_DEPS=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Cargar nvm/node (necesario para el build del frontend)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "▶ Build del frontend (Vite)..."
( cd frontend && npm run build )

echo "▶ Sync frontend/dist → $PI_HOST:$PI_DIR ..."
rsync -az --delete frontend/dist/ "$PI_HOST:$PI_DIR/frontend/dist/"

echo "▶ Sync backend/src → $PI_HOST:$PI_DIR ..."
rsync -az --delete backend/src/ "$PI_HOST:$PI_DIR/backend/src/"

echo "▶ Sync package manifests..."
rsync -az backend/package.json backend/package-lock.json "$PI_HOST:$PI_DIR/backend/"

if [ "$INSTALL_DEPS" = "1" ]; then
  echo "▶ Reinstalando deps del backend (npm ci)..."
  ssh "$PI_HOST" 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd '"$PI_DIR"'/backend && npm ci --omit=dev'
fi

echo "▶ Reiniciando $SERVICE ..."
ssh "$PI_HOST" "sudo systemctl restart $SERVICE && sleep 2 && systemctl is-active $SERVICE"

echo "▶ Health check..."
ssh "$PI_HOST" "curl -fsS http://localhost:$PORT/health && echo"

echo "✅ Deploy completo → http://${PI_HOST#*@}:$PORT"
