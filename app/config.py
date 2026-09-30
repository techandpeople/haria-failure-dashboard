"""
Central path configuration.

Everything is overridable via environment variables so the backend can run
on the robot, in a container, or on a laptop without code changes.
"""
from __future__ import annotations

import os
from pathlib import Path

# dashboard-backend/
BASE_DIR = Path(__file__).resolve().parent.parent

# Where `ros2 bag record` output (and uploaded bags) live.
RECORDINGS_DIR = Path(os.environ.get("HARIA_RECORDINGS_DIR", BASE_DIR / "recordings"))

# Scratch dir holding the pre-processed (JSONL + JPEG) view of the *current*
# session. Wiped whenever a new recording starts or a new bag is uploaded.
SESSION_OUT_DIR = Path(os.environ.get("HARIA_SESSION_DIR", BASE_DIR / "session_out"))

FRONTEND_DIR = BASE_DIR / "frontend"

RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
SESSION_OUT_DIR.mkdir(parents=True, exist_ok=True)

# Depth colorisation range in metres, as "lo,hi" — or "auto" (default) to
# derive it from the first frames of each depth topic. The range is fixed for
# the whole session on purpose: per-frame autoscaling makes depth video throb.
HARIA_DEPTH_RANGE_M = os.environ.get("HARIA_DEPTH_RANGE_M", "auto")
