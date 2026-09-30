#!/usr/bin/env bash
# HARIA - Linux launcher (playback). Run this or use HARIA.desktop.
# For recording from a robot, use record-haria.sh instead.
set -euo pipefail
cd "$(dirname "$0")/../.."            # repo root (holds docker-compose.yml)

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed — see https://docs.docker.com/engine/install/"
  xdg-open "https://docs.docker.com/engine/install/" >/dev/null 2>&1 || true
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "The Docker daemon isn't running (try: sudo systemctl start docker)."
  exit 1
fi

if [ ! -f .env ] || ! grep -q '^BAGS=' .env 2>/dev/null; then
  if command -v zenity >/dev/null 2>&1; then
    FOLDER=$(zenity --file-selection --directory --title="Choose your folder of rosbags" 2>/dev/null) || exit 0
  else
    read -rp "Path to your rosbags folder: " FOLDER
  fi
  [ -z "${FOLDER:-}" ] && exit 0
  printf 'BAGS=%s\n' "${FOLDER%/}" > .env
fi

docker compose pull 2>/dev/null || true
docker compose up -d

for _ in $(seq 1 90); do curl -fs http://localhost:8000 >/dev/null 2>&1 && break; sleep 1; done
xdg-open "http://localhost:8000" >/dev/null 2>&1 || echo "Open http://localhost:8000"
