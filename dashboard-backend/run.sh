#!/usr/bin/env bash
set -e
source /opt/ros/jazzy/setup.bash
source .venv/bin/activate
# --no-access-log: the dashboard polls several times per second; logging every
# request floods the terminal and costs real time. Set HARIA_ACCESS_LOG=1 to
# turn request logging back on while debugging.
ACCESS_LOG_FLAG="--no-access-log"
[ "${HARIA_ACCESS_LOG:-0}" = "1" ] && ACCESS_LOG_FLAG=""
exec uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 $ACCESS_LOG_FLAG
