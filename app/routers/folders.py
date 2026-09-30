"""
Folder onboarding: scan the configured HARIA_ROOT for bags at any depth, and
persist per-user "who / which folder / recents" state.

A directory counts as a *bag* when it directly holds metadata.yaml, a .mcap, a
.db3, or a video file — bag dirs are tree leaves (we don't descend into them).
This handles arbitrary nesting like robot › researcher › day › session.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import HARIA_LOCK_ROOT, HARIA_ROOT
from app.services import bag_indexer, user_state, video_indexer

router = APIRouter(tags=["folders"])

MAX_DEPTH = 6
_VIDEO_EXTS = tuple(getattr(video_indexer, "VIDEO_EXTS", (".mp4", ".mkv", ".mov", ".avi")))
_ARCHIVE_SUFFIXES = (".zip", ".tar.gz", ".tgz")


def _file_kind(f: Path) -> Optional[str]:
    """Classify a loose file the dashboard can use, else None."""
    n = f.name.lower()
    if f.suffix in (".mcap", ".db3"):        return "bag"
    if f.suffix.lower() in _VIDEO_EXTS:      return "video"
    if n.endswith(_ARCHIVE_SUFFIXES):        return "archive"
    return None


def _is_bag(d: Path) -> bool:
    if (d / "metadata.yaml").exists():
        return True
    for f in d.iterdir():
        if f.is_file() and (f.suffix in (".mcap", ".db3") or f.suffix.lower() in _VIDEO_EXTS):
            return True
    return False


def _scan(d: Path, root: Path, depth: int) -> dict:
    node = {
        "name": d.name or str(d),
        "path": str(d.resolve()),
        "rel": str(d.resolve().relative_to(root)) if d.resolve() != root else "",
        "is_bag": False,
        "children": [],
    }
    try:
        if _is_bag(d):
            node["is_bag"] = True
            return node          # bag dirs are leaves
    except (PermissionError, OSError):
        return node
    if depth >= MAX_DEPTH:
        return node
    try:
        subs = sorted([c for c in d.iterdir() if c.is_dir() and not c.name.startswith(".")],
                      key=lambda c: c.name.lower())
    except (PermissionError, OSError):
        subs = []
    for c in subs:
        child = _scan(c, root, depth + 1)
        # Keep a subtree only if it contains at least one bag somewhere.
        if child["is_bag"] or child["children"]:
            node["children"].append(child)
    return node


def _has_bags_below(d: Path, depth: int = 3) -> bool:
    """Cheap check: does this dir (or a shallow descendant) contain a bag?
    Used only to hint the browser which subfolders are worth entering."""
    try:
        if _is_bag(d):
            return True
        if depth <= 0:
            return False
        for c in d.iterdir():
            if c.is_dir() and not c.name.startswith(".") and _has_bags_below(c, depth - 1):
                return True
    except (PermissionError, OSError):
        pass
    return False


@router.get("/folders/browse")
def folders_browse(path: Optional[str] = None):
    """List the immediate sub-folders of `path` (one level), so the UI can
    navigate anywhere the backend can read. `path` defaults to HARIA_ROOT (or,
    if that doesn't exist, the user's home). Confined to HARIA_ROOT only when
    HARIA_LOCK_ROOT is set (shared-server safety)."""
    root = HARIA_ROOT.resolve()
    start = Path(path).resolve() if path else (root if root.is_dir() else Path.home())

    if HARIA_LOCK_ROOT and root != start and root not in start.parents:
        start = root
    if not start.is_dir():
        raise HTTPException(404, f"Not a folder: {start}")

    # Parent (unless locked at the root, or already at filesystem top).
    parent = None
    if not (HARIA_LOCK_ROOT and start == root) and start.parent != start:
        parent = str(start.parent)

    entries, files = [], []
    try:
        for c in sorted(start.iterdir(), key=lambda p: p.name.lower()):
            if c.name.startswith("."):
                continue
            if c.is_dir():
                try:
                    is_bag = _is_bag(c)
                    has_bags = is_bag or _has_bags_below(c, 2)
                except (PermissionError, OSError):
                    is_bag, has_bags = False, False
                entries.append({"name": c.name, "path": str(c), "is_bag": is_bag, "has_bags": has_bags})
            elif c.is_file():
                kind = _file_kind(c)
                if kind:
                    files.append({"name": c.name, "path": str(c), "kind": kind})
    except (PermissionError, OSError) as e:
        raise HTTPException(403, f"Cannot read folder: {e}")

    return {
        "path": str(start),
        "parent": parent,
        "locked": HARIA_LOCK_ROOT,
        "is_bag_here": _is_bag(start),
        "entries": entries,
        "files": files,
    }


@router.post("/folders/import-archive")
def import_archive(path: str):
    """Extract a local .zip / .tar.gz next to itself and return the bag path to
    open. The archive stays; the extracted folder lives in the same directory."""
    p = Path(path).resolve()
    root = HARIA_ROOT.resolve()
    if HARIA_LOCK_ROOT and root != p and root not in p.parents:
        raise HTTPException(400, "Archive is outside the allowed root.")
    if not p.is_file() or _file_kind(p) != "archive":
        raise HTTPException(404, f"Not an archive: {p}")

    stem = p.name
    for ext in _ARCHIVE_SUFFIXES:
        if stem.lower().endswith(ext):
            stem = stem[: -len(ext)]
            break
    dest = p.parent / stem
    try:
        if not dest.exists():
            dest.mkdir(parents=True, exist_ok=True)
            if p.name.lower().endswith(".zip"):
                import zipfile
                with zipfile.ZipFile(p, "r") as zf:
                    zf.extractall(dest)
            else:
                import tarfile
                with tarfile.open(p, "r:gz") as tf:
                    tf.extractall(dest)
    except (OSError, Exception) as e:   # extraction / write failure
        raise HTTPException(500, f"Could not extract archive: {e}")

    bag_root = bag_indexer.find_bag_root(dest)
    return {"path": str(bag_root)}


@router.get("/folders/tree")
def folders_tree(path: Optional[str] = None):
    """Nested folder tree under `path` (default HARIA_ROOT), bag dirs marked.
    Confined to HARIA_ROOT only when HARIA_LOCK_ROOT is set."""
    root = HARIA_ROOT.resolve()
    start = Path(path).resolve() if path else root
    if HARIA_LOCK_ROOT and root != start and root not in start.parents:
        start = root
    if not start.is_dir():
        return {"root": str(start), "exists": False, "tree": None}
    return {"root": str(start), "exists": True, "tree": _scan(start, start, 0)}


# ---------------------------------------------------------------------------
# Per-user state
# ---------------------------------------------------------------------------

class StateUpdate(BaseModel):
    last_folder: Optional[str] = None
    recent: Optional[dict] = None     # {bag_key, path, name}


@router.get("/users/{user}/state")
def get_user_state(user: str, folder: Optional[str] = None):
    """Central last-folder pointer, plus this user's in-folder recents/state."""
    out = {"user": user, "last_folder": user_state.get_last_folder(user), "recents": [], "working_on": ""}
    if folder:
        fu = user_state.get_folder_user(folder, user)
        out["recents"] = fu.get("recents", [])
        out["working_on"] = fu.get("working_on", "")
    return out


@router.post("/users/{user}/state")
def set_user_state(user: str, upd: StateUpdate, folder: Optional[str] = None):
    if upd.last_folder is not None:
        user_state.set_last_folder(user, upd.last_folder)
    if upd.recent and folder:
        r = upd.recent
        user_state.add_recent(folder, user, r.get("bag_key", ""), r.get("path", ""), r.get("name", ""))
    return get_user_state(user, folder)


# ---------------------------------------------------------------------------
# Shared folder session marker (who / last session / working-on) + mtime guard
# ---------------------------------------------------------------------------

class MarkerUpdate(BaseModel):
    author: Optional[str] = None
    working_on: Optional[str] = None
    last_session: Optional[dict] = None    # {path, name, bag_key}
    expected_mtime: Optional[float] = None
    force: bool = False


@router.get("/folders/marker")
def get_marker(path: str):
    return user_state.read_marker(path)


@router.post("/folders/marker")
def post_marker(path: str, upd: MarkerUpdate):
    data = {}
    if upd.author is not None:       data["updated_by"] = upd.author
    if upd.working_on is not None:   data["working_on"] = upd.working_on
    if upd.last_session is not None: data["last_session"] = upd.last_session
    return user_state.write_marker(path, data, expected_mtime=upd.expected_mtime, force=upd.force)
