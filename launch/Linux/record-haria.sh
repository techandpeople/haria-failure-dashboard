#!/usr/bin/env bash
# HARIA - Linux RECORD launcher. Starts the record profile (host networking +
# device passthrough) so you can capture live from a robot / local camera+mic.
# Recording only works on Linux — see the README.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker isn't installed or the daemon isn't running."; exit 1
fi
if [ ! -f .env ] || ! grep -q '^BAGS=' .env 2>/dev/null; then
  if command -v zenity >/dev/null 2>&1; then
    FOLDER=$(zenity --file-selection --directory --title="Choose the folder to record into" 2>/dev/null) || exit 0
  else
    read -rp "Path to record into: " FOLDER
  fi
  [ -z "${FOLDER:-}" ] && exit 0
  printf 'BAGS=%s\n' "${FOLDER%/}" > .env
fi

docker compose pull 2>/dev/null || true
docker compose --profile record up -d

for _ in $(seq 1 90); do curl -fs http://localhost:8000 >/dev/null 2>&1 && break; sleep 1; done
xdg-open "http://localhost:8000" >/dev/null 2>&1 || echo "Open http://localhost:8000"
