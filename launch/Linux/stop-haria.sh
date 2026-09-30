#!/usr/bin/env bash
# Stop the HARIA container (Linux).
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose --profile record down 2>/dev/null || true
docker compose down
