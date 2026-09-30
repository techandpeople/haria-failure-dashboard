"""
Per-bag cache manager — the foundation for multi-session playback.

Each opened bag is pre-processed once into CACHE_DIR/<bag_key>/ (same layout as
the legacy SESSION_OUT_DIR: index.json + per-topic slug/ dirs). A manifest records
the source bag and a signature of its bag files so a later open can be served
instantly when nothing changed, and different bags can be viewed concurrently
because each has its own directory.

Processing status is tracked per bag key here (not on the single SessionState),
so one user's build never clobbers another's status.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path
from typing import Optional

from app.config import CACHE_DIR

_lock = threading.Lock()
_status: dict[str, dict] = {}     # bag_key -> {state, progress, error}

# Per-key build locks so two concurrent first-opens of the same bag never build
# into the same cache dir at once (the second waiter finds it fresh and skips).
_build_locks: dict[str, threading.Lock] = {}
_build_locks_guard = threading.Lock()

# Data files whose changes should invalidate a cache (annotations.json is
# deliberately excluded so re-saving annotations doesn't force a rebuild).
_SIG_SUFFIXES = (".mcap", ".db3", ".mp4", ".mkv", ".mov", ".avi", ".webm", ".yaml")


def build_lock(key: str) -> threading.Lock:
    with _build_locks_guard:
        lk = _build_locks.get(key)
        if lk is None:
            lk = _build_locks[key] = threading.Lock()
    return lk


# ---------------------------------------------------------------------------
# Keys & directories
# ---------------------------------------------------------------------------

def key_for(path) -> str:
    """Stable cache key for a bag directory (by absolute path)."""
    return hashlib.sha1(str(Path(path).resolve()).encode("utf-8")).hexdigest()[:16]


def dir_for(key: str) -> Path:
    return CACHE_DIR / key


def _manifest_path(key: str) -> Path:
    return dir_for(key) / ".manifest.json"


# ---------------------------------------------------------------------------
# Manifest & freshness
# ---------------------------------------------------------------------------

def source_sig(source) -> dict:
    """Signature of the bag's data files (bags, videos, metadata) — ignores
    annotations.json so re-saving annotations doesn't invalidate the cache."""
    src = Path(source)
    total = 0
    mtime = 0.0
    n = 0
    try:
        for f in src.iterdir():
            if f.is_file() and f.suffix.lower() in _SIG_SUFFIXES:
                try:
                    st = f.stat()
                    total += st.st_size
                    mtime = max(mtime, st.st_mtime)
                    n += 1
                except OSError:
                    pass
    except OSError:
        pass
    return {"bytes": total, "mtime": mtime, "n": n}


def read_manifest(key: str) -> Optional[dict]:
    p = _manifest_path(key)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def write_manifest(key: str, data: dict) -> None:
    d = dir_for(key)
    d.mkdir(parents=True, exist_ok=True)
    tmp = _manifest_path(key).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(_manifest_path(key))


def source_for(key: str) -> Optional[Path]:
    m = read_manifest(key)
    return Path(m["source"]) if m and m.get("source") else None


def is_fresh(key: str, source) -> bool:
    """True if a ready cache for this bag exists and matches the source files."""
    m = read_manifest(key)
    if not m or m.get("state") != "ready":
        return False
    if not (dir_for(key) / "index.json").exists():
        return False
    return m.get("source") == str(Path(source).resolve()) and m.get("sig") == source_sig(source)


def mark_ready(key: str, source) -> None:
    m = read_manifest(key) or {}
    m.update({
        "source": str(Path(source).resolve()),
        "sig": source_sig(source),
        "state": "ready",
        "built_at": time.time(),
        "last_used": time.time(),
    })
    write_manifest(key, m)


def touch(key: str) -> None:
    """Bump last_used for LRU (Phase C)."""
    m = read_manifest(key)
    if m is not None:
        m["last_used"] = time.time()
        write_manifest(key, m)


# ---------------------------------------------------------------------------
# Per-bag processing status (polled by /playback/status?bag=key)
# ---------------------------------------------------------------------------

def set_status(key: str, state: str, progress: str = "", error: str = "") -> None:
    with _lock:
        _status[key] = {"state": state, "progress": progress, "error": error}


def get_status(key: str) -> dict:
    with _lock:
        s = _status.get(key)
        if s:
            return dict(s)
    # Not in memory (e.g. after a restart) — infer from the manifest.
    m = read_manifest(key)
    if m and m.get("state") == "ready" and (dir_for(key) / "index.json").exists():
        return {"state": "ready", "progress": "", "error": ""}
    return {"state": "idle", "progress": "", "error": ""}
