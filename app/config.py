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
# session. Legacy single-slot fallback used when no per-bag cache key is given.
SESSION_OUT_DIR = Path(os.environ.get("HARIA_SESSION_DIR", BASE_DIR / "session_out"))

# Persistent per-bag cache root: each opened bag is pre-processed once into
# CACHE_DIR/<bag_key>/ and reused on later opens (multi-session safe).
CACHE_DIR = Path(os.environ.get("HARIA_CACHE_DIR", BASE_DIR / "cache"))

# Default folder the onboarding browser opens at (a mounted /data in Docker, or
# a real path natively).
HARIA_ROOT = Path(os.environ.get("HARIA_ROOT", RECORDINGS_DIR))

# When true (shared server), the folder browser is confined to HARIA_ROOT. When
# false (default, local use), the user can browse to any folder the backend can
# read on the machine.
HARIA_LOCK_ROOT = os.environ.get("HARIA_LOCK_ROOT", "").lower() in ("1", "true", "yes")

# Cache eviction budget (Phase C): drop least-recently-used bag caches beyond these.
CACHE_MAX_GB   = float(os.environ.get("HARIA_CACHE_MAX_GB", "20"))
CACHE_MAX_BAGS = int(os.environ.get("HARIA_CACHE_MAX_BAGS", "50"))

# Per-user state (last folder, recents) lives here as small JSON files.
STATE_DIR = Path(os.environ.get("HARIA_STATE_DIR", CACHE_DIR / "state"))

FRONTEND_DIR = BASE_DIR / "frontend"

RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
SESSION_OUT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)
STATE_DIR.mkdir(parents=True, exist_ok=True)

# Depth colorisation range in metres, as "lo,hi" — or "auto" (default) to
# derive it from the first frames of each depth topic. The range is fixed for
# the whole session on purpose: per-frame autoscaling makes depth video throb.
HARIA_DEPTH_RANGE_M = os.environ.get("HARIA_DEPTH_RANGE_M", "auto")
