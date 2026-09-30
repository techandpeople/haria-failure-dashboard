#!/usr/bin/env bash
# HARIA — macOS launcher. Double-click to start the dashboard.
# One-time prerequisite: Docker Desktop (this checks and guides you if missing).
set -euo pipefail
cd "$(dirname "$0")/../.."            # repo root (holds docker-compose.yml)

dialog() { osascript -e "display dialog \"$1\" buttons {\"OK\"} with icon caution" >/dev/null 2>&1 || true; }

# 1. Docker present + running?
if ! command -v docker >/dev/null 2>&1; then
  dialog "Docker Desktop isn't installed. I'll open the download page — install it, then run HARIA again."
  open "https://www.docker.com/products/docker-desktop/"; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  dialog "Docker Desktop is installed but not running. I'll try to start it — wait until it's ready, then run HARIA again."
  open -a Docker >/dev/null 2>&1 || true; exit 1
fi

# 2. First run: pick the folder of rosbags (saved to .env).
if [ ! -f .env ] || ! grep -q '^BAGS=' .env 2>/dev/null; then
  FOLDER=$(osascript -e 'POSIX path of (choose folder with prompt "Choose your folder of rosbags")' 2>/dev/null || true)
  [ -z "${FOLDER:-}" ] && exit 0
  printf 'BAGS=%s\n' "${FOLDER%/}" > .env
fi

# 3. Pull the prebuilt image and start.
docker compose pull 2>/dev/null || true
docker compose up -d

# 4. Wait for the server, then open the dashboard.
for _ in $(seq 1 90); do curl -fs http://localhost:8000 >/dev/null 2>&1 && break; sleep 1; done
open "http://localhost:8000"
