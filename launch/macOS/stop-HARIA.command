#!/usr/bin/env bash
# Stop the HARIA container (macOS).
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose --profile record down 2>/dev/null || true
docker compose down
osascript -e 'display notification "HARIA stopped" with title "HARIA"' >/dev/null 2>&1 || true
