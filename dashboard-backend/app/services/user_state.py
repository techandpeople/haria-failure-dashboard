"""
Working-folder state.

HARIA keeps its per-user data INSIDE the chosen working folder, so a folder is
self-contained and separated by user:

    <folder>/.haria/users/<user>.json   per-user: {recents, working_on}
    <folder>/.haria/session.json        shared marker: who last worked here,
                                         last session, working-on, updated_at

A tiny central pointer (STATE_DIR/users/<user>.json = {last_folder}) is the one
exception — it lets onboarding offer "resume" before any folder is known.

The shared marker carries an mtime guard: a client remembers the marker's mtime
when it opens the folder, and a write that passes a stale expected_mtime is
reported as a conflict so the user can be warned it changed underneath them.
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Optional

from app.config import STATE_DIR

_lock = threading.Lock()
_MAX_RECENTS = 20
_DIRNAME = ".haria"


def _safe(user: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", (user or "").strip()).strip("_.") or "anon"


def _read_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError, FileNotFoundError):
        return {}


def _write_json(p: Path, data: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)


# ---------------------------------------------------------------------------
# Central pointer (only "last_folder", so resume works before a folder is known)
# ---------------------------------------------------------------------------

def _pointer_path(user: str) -> Path:
    return STATE_DIR / "users" / f"{_safe(user)}.json"


def get_last_folder(user: str) -> Optional[str]:
    return _read_json(_pointer_path(user)).get("last_folder")


def set_last_folder(user: str, folder: Optional[str]) -> None:
    with _lock:
        p = _pointer_path(user)
        d = _read_json(p)
        d["last_folder"] = folder
        _write_json(p, d)


# ---------------------------------------------------------------------------
# Per-user state inside the working folder
# ---------------------------------------------------------------------------

def _haria_dir(folder: str) -> Path:
    return Path(folder) / _DIRNAME


def _user_file(folder: str, user: str) -> Path:
    return _haria_dir(folder) / "users" / f"{_safe(user)}.json"


def get_folder_user(folder: str, user: str) -> dict:
    d = _read_json(_user_file(folder, user))
    d.setdefault("recents", [])
    d.setdefault("working_on", "")
    return d


def add_recent(folder: str, user: str, bag_key: str, path: str, name: str) -> dict:
    with _lock:
        d = get_folder_user(folder, user)
        recents = [r for r in d.get("recents", []) if r.get("path") != path]
        recents.insert(0, {"bag_key": bag_key, "path": path, "name": name, "opened_at": time.time()})
        d["recents"] = recents[:_MAX_RECENTS]
        try:
            _write_json(_user_file(folder, user), d)
        except OSError:
            pass   # read-only folder — recents are best-effort
        return d


# ---------------------------------------------------------------------------
# Shared folder marker + mtime guard
# ---------------------------------------------------------------------------

def _marker_path(folder: str) -> Path:
    return _haria_dir(folder) / "session.json"


def read_marker(folder: str) -> dict:
    p = _marker_path(folder)
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return {"exists": False, "mtime": 0.0, "marker": None}
    return {"exists": True, "mtime": mtime, "marker": _read_json(p)}


def write_marker(folder: str, data: dict, expected_mtime: Optional[float] = None,
                 force: bool = False) -> dict:
    """Write the shared marker. If expected_mtime is given and the file has been
    modified since (someone else touched it), return a conflict instead of
    overwriting — unless force=True."""
    with _lock:
        p = _marker_path(folder)
        cur = read_marker(folder)
        if (not force and expected_mtime is not None and cur["exists"]
                and abs(cur["mtime"] - expected_mtime) > 1e-6):
            return {"ok": False, "conflict": True, "mtime": cur["mtime"], "marker": cur["marker"]}
        payload = {**(cur["marker"] or {}), **data, "updated_at": time.time()}
        try:
            _write_json(p, payload)
        except OSError as e:
            return {"ok": False, "conflict": False, "error": str(e),
                    "mtime": cur["mtime"], "marker": cur["marker"]}
        after = read_marker(folder)
        return {"ok": True, "conflict": False, "mtime": after["mtime"], "marker": after["marker"]}
