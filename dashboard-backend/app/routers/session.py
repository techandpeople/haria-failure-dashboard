"""
Endpoints backing the dashboard UI itself: the pre-processed topic archive
(index / time-windowed data / image frames), bag upload, and the annotations
of the current session.

Annotations are persisted as `annotations.json` next to the bag's .mcap and
metadata.yaml, so they always travel with the recording.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from app.config import CACHE_DIR, RECORDINGS_DIR, SESSION_OUT_DIR
from app.services import bag_indexer, cache_manager, live_capture, video_indexer
from app.services.session_cache import session_cache
from app.services.session_state import session

router = APIRouter(tags=["session"])


def _cache_dir(bag: Optional[str]) -> Path:
    """Resolve the pre-processed cache dir for a request.

    With a bag key → that bag's persistent cache (multi-session). Without one →
    the legacy single-slot SESSION_OUT_DIR (backward compatible)."""
    if bag:
        d = (CACHE_DIR / bag).resolve()
        if CACHE_DIR.resolve() in d.parents:
            return d
    return SESSION_OUT_DIR


def _topic_dir(slug: str, bag: Optional[str] = None) -> Path:
    base = _cache_dir(bag)
    tdir = (base / slug).resolve()
    if base.resolve() not in tdir.parents or not tdir.exists():
        raise HTTPException(404, f"No data for topic: {slug}")
    return tdir

VIDEO_CHUNK_BYTES = 4 * 1024 * 1024   # per-request cap for range reads


def _ensure_no_live_writers() -> None:
    """A playback session must have exclusive ownership of SESSION_OUT_DIR.

    If a recording is still running, refuse; if a live-capture node was left
    behind (browser refreshed instead of pressing Stop), shut it down so it
    can't keep rewriting the archive we're about to build."""
    from app.services.recorder import recorder
    if recorder.state.is_active:
        raise HTTPException(
            409,
            "A recording is still in progress — stop it before opening a "
            "bag for playback.",
        )
    live_capture.stop()


# ---------------------------------------------------------------------------
# Open an existing recording (no upload round-trip needed)
# ---------------------------------------------------------------------------

class OpenRequest(BaseModel):
    name: Optional[str] = None
    path: Optional[str] = None   # absolute bag dir under HARIA_ROOT (folder workflow)


@router.post("/playback/open")
async def playback_open(req: OpenRequest, background_tasks: BackgroundTasks):
    _ensure_no_live_writers()
    if req.path:
        from app.config import HARIA_LOCK_ROOT, HARIA_ROOT
        bag_dir = Path(req.path).resolve()
        root = HARIA_ROOT.resolve()
        if HARIA_LOCK_ROOT and root != bag_dir and root not in bag_dir.parents:
            raise HTTPException(400, "Path is outside the configured root folder")
    else:
        bag_dir = (RECORDINGS_DIR / (req.name or "")).resolve()
        if RECORDINGS_DIR.resolve() not in bag_dir.parents:
            raise HTTPException(404, f"Recording {req.name!r} not found")
    if not bag_dir.is_dir():
        raise HTTPException(404, "Bag folder not found")

    session.set_bag(bag_dir)
    key, kind = _index_session(bag_dir, background_tasks)
    return {"status": "processing", "path": str(bag_dir), "kind": kind, "bag": key}


# ---------------------------------------------------------------------------
# Bag upload → background pre-processing
# ---------------------------------------------------------------------------

@router.post("/playback/upload")
async def playback_upload(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    _ensure_no_live_writers()
    stem = Path(file.filename).name
    for ext in (".zip", ".tar.gz", ".tgz", ".mcap", ".db3"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    if not stem:
        raise HTTPException(400, "Invalid file name")

    bag_dir = RECORDINGS_DIR / stem
    bag_dir.mkdir(parents=True, exist_ok=True)
    dest = bag_dir / Path(file.filename).name
    with dest.open("wb") as buf:
        shutil.copyfileobj(file.file, buf)

    if dest.name.endswith(".zip"):
        import zipfile
        with zipfile.ZipFile(dest, "r") as zf:
            zf.extractall(bag_dir)
        dest.unlink()
        bag_dir = bag_indexer.find_bag_root(bag_dir)
    elif dest.name.endswith((".tar.gz", ".tgz")):
        import tarfile
        with tarfile.open(dest, "r:gz") as tf:
            tf.extractall(bag_dir)
        dest.unlink()
        bag_dir = bag_indexer.find_bag_root(bag_dir)

    session.set_bag(bag_dir)
    key, kind = _index_session(bag_dir, background_tasks)
    return {"status": "processing", "path": str(bag_dir), "kind": kind, "bag": key}


def _index_session(bag_dir: Path, background_tasks: BackgroundTasks) -> tuple[str, str]:
    """Ensure a per-bag cache exists (build it if stale) and return (bag_key, kind).

    A bag wins if present; a folder holding only videos becomes a video
    session (same index.json contract, so timeline/annotations are unchanged).
    Reuses the cache when the source is unchanged — reopening is then instant.
    """
    key = cache_manager.key_for(bag_dir)
    out_dir = cache_manager.dir_for(key)
    has_bag = any(bag_dir.glob("*.mcap")) or any(bag_dir.glob("*.db3"))
    kind = "video" if (not has_bag and video_indexer.find_videos(bag_dir)) else "bag"

    session.set_status("processing", "Queued…")   # legacy single-slot status
    if cache_manager.is_fresh(key, bag_dir):
        cache_manager.touch(key)
        cache_manager.set_status(key, "ready", "Cached")
        session.set_status("ready", "Cached")
        return key, kind

    cache_manager.set_status(key, "processing", "Queued…")
    background_tasks.add_task(_build_cache, key, kind, bag_dir, out_dir)
    return key, kind


def _build_cache(key: str, kind: str, bag_dir: Path, out_dir: Path) -> None:
    """Background build of a bag's cache dir; updates per-bag status.

    Serialised per key so two concurrent first-opens of the same bag can't both
    wipe + write the same cache dir — the second waiter finds it fresh and skips.
    """
    with cache_manager.build_lock(key):
        if cache_manager.is_fresh(key, bag_dir):     # another builder finished while we waited
            cache_manager.touch(key)
            cache_manager.set_status(key, "ready", "Cached")
            return
        cache_manager.set_status(key, "processing", "Indexing…")
        try:
            if kind == "video":
                video_indexer.preprocess_videos(bag_dir, out_dir)
            else:
                bag_indexer.preprocess_bag(bag_dir, out_dir)
            if (out_dir / "index.json").exists():
                cache_manager.mark_ready(key, bag_dir)
                cache_manager.set_status(key, "ready", "Done")
            else:
                cache_manager.set_status(key, "error", error="Indexing produced no output")
        except Exception as e:   # pragma: no cover - defensive
            cache_manager.set_status(key, "error", error=str(e))


def _extract_archives(bag_dir: Path) -> None:
    """Unpack any .zip / .tar.gz uploaded alongside loose bag files."""
    for f in list(bag_dir.iterdir()):
        if f.name.endswith(".zip"):
            import zipfile
            with zipfile.ZipFile(f, "r") as zf:
                zf.extractall(bag_dir)
            f.unlink()
        elif f.name.endswith((".tar.gz", ".tgz")):
            import tarfile
            with tarfile.open(f, "r:gz") as tf:
                tf.extractall(bag_dir)
            f.unlink()


def _validate_bag_dir(bag_dir: Path) -> tuple[bool, str]:
    """Check the uploaded files form a coherent bag: if metadata.yaml is
    present, every shard it lists must be here; otherwise at least one
    .mcap/.db3 is required (mcap/db3 are self-describing)."""
    import yaml
    mcaps = list(bag_dir.glob("*.mcap"))
    db3s  = list(bag_dir.glob("*.db3"))
    meta  = bag_dir / "metadata.yaml"

    if meta.exists():
        try:
            doc = yaml.safe_load(meta.read_text())
            info = doc.get("rosbag2_bagfile_information", doc) if isinstance(doc, dict) else {}
        except Exception:
            info = {}
        rels = info.get("relative_file_paths") or []
        present = {p.name for p in mcaps + db3s}
        missing = [r for r in rels if Path(r).name not in present]
        if rels and missing:
            return False, ("These files belong to a bag whose shards are missing: "
                           + ", ".join(Path(m).name for m in missing))
        if not (mcaps or db3s):
            return False, "metadata.yaml was uploaded but no .mcap or .db3 bag file came with it."
        return True, f"Validated {len(mcaps) + len(db3s)} bag file(s) against metadata.yaml."

    if mcaps or db3s:
        return True, "No metadata.yaml — reading the bag file(s) directly."

    videos = video_indexer.find_videos(bag_dir)
    if videos:
        return True, (f"{len(videos)} video file(s) — they will play together "
                      "on one timeline.")
    return False, "No .mcap, .db3 or video file found among the uploaded files."


@router.post("/playback/upload-multi")
async def playback_upload_multi(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    name: Optional[str] = Form(None),
):
    """Upload the loose files of a bag (metadata.yaml + one or more .mcap/.db3,
    or a picked folder) without zipping first. Validates they belong together
    before indexing."""
    _ensure_no_live_writers()
    if not files:
        raise HTTPException(400, "No files uploaded")

    # Session dir name: caller-supplied folder name, else a bag file's stem.
    stem = (name or "").strip()
    if not stem:
        for f in files:
            base = Path(f.filename or "").name
            if base.endswith((".mcap", ".db3")):
                stem = Path(base).stem
                break
    if not stem:
        stem = Path(files[0].filename or "bag").name or "bag"
        for ext in (".zip", ".tar.gz", ".tgz", ".mcap", ".db3", ".yaml", ".yml",
                    *video_indexer.VIDEO_EXTS):
            if stem.endswith(ext):
                stem = stem[: -len(ext)]
                break
    stem = re.sub(r"[^A-Za-z0-9_.-]", "_", stem).strip("_.") or "bag"

    bag_dir = RECORDINGS_DIR / stem
    bag_dir.mkdir(parents=True, exist_ok=True)
    for f in files:
        base = Path(f.filename or "").name          # flatten any folder structure
        if not base:
            continue
        with (bag_dir / base).open("wb") as buf:
            shutil.copyfileobj(f.file, buf)

    _extract_archives(bag_dir)
    root = bag_indexer.find_bag_root(bag_dir)
    ok, msg = _validate_bag_dir(root)
    if not ok:
        shutil.rmtree(bag_dir, ignore_errors=True)
        raise HTTPException(400, msg)

    session.set_bag(root)
    key, kind = _index_session(root, background_tasks)
    return {"status": "processing", "path": str(root), "note": msg, "kind": kind, "bag": key}


@router.get("/playback/status")
def playback_status(bag: Optional[str] = None):
    from app.services.recorder import recorder
    status = cache_manager.get_status(bag) if bag else session.status
    return {
        **status,
        "recording_active": recorder.state.is_active,
        "live_capture_active": live_capture.is_active(),
    }


@router.post("/playback/stop")
async def playback_stop():
    """Close the playback session."""
    session.set_status("idle")
    return {"status": "stopped"}


# ---------------------------------------------------------------------------
# Pre-processed topic archive (served from SESSION_OUT_DIR)
# ---------------------------------------------------------------------------

@router.get("/topics/index")
def topics_index(bag: Optional[str] = None):
    p = _cache_dir(bag) / "index.json"
    if not p.exists():
        return JSONResponse({"timestamp": 0, "t_start": 0, "t_end": 0, "topics": []})
    return JSONResponse(json.loads(p.read_text()))


@router.get("/topics/data/{slug}")
def topic_data(slug: str, t: Optional[float] = None, window: float = 10.0,
               raw: int = 1, limit: Optional[int] = None, bag: Optional[str] = None):
    """
    With t: entries from data.jsonl within [t - window, t + window/10],
    served from the incremental in-memory cache (binary search, no file
    re-parse). raw=0 strips the heavy _raw payload (chart panels only need
    the numeric fields); limit=N returns only the last N entries of the
    window (JSON/table panels only need the newest one).
    Without t: the latest.json snapshot.
    """
    tdir = _topic_dir(slug, bag)

    if t is not None:
        entries = session_cache.window(tdir / "data.jsonl", slug, t - window, t + window / 10)
        if limit is not None and limit > 0:
            entries = entries[-limit:]
        if not raw:
            entries = [{k: v for k, v in e.items() if k != "_raw"} for e in entries]
        return JSONResponse({"slug": slug, "t": t, "window": window, "entries": entries})

    latest = tdir / "latest.json"
    if not latest.exists():
        raise HTTPException(404, "No latest data")
    return JSONResponse(json.loads(latest.read_text()))


@router.get("/topics/image/{slug}")
def topic_image(slug: str, t: Optional[float] = None, frame: Optional[float] = None, bag: Optional[str] = None):
    tdir = _topic_dir(slug, bag)

    # Exact frame (video panel): the frame filename is `{ts:.3f}.jpg`.
    if frame is not None:
        exact = tdir / f"{frame:.3f}.jpg"
        if exact.exists():
            return FileResponse(str(exact), media_type="image/jpeg")

    if t is not None:
        best = session_cache.nearest_frame(tdir, slug, t)
        if best is not None:
            return FileResponse(str(best), media_type="image/jpeg")

    latest = tdir / "latest.jpg"
    if not latest.exists():
        raise HTTPException(404, "No image")
    return FileResponse(str(latest), media_type="image/jpeg")


@router.get("/topics/frames/{slug}")
def topic_frames(slug: str, bag: Optional[str] = None):
    """Sorted frame timestamps for an image topic (drives the video panel)."""
    tdir = _topic_dir(slug, bag)
    return {"slug": slug, "frames": session_cache.frame_times(tdir, slug)}


def _video_path(slug: str, bag: Optional[str] = None) -> Path:
    """Resolve a video topic slug to its file inside the session's folder."""
    idx = _cache_dir(bag) / "index.json"
    if not idx.exists():
        raise HTTPException(404, "No session loaded")
    try:
        topics = json.loads(idx.read_text()).get("topics", [])
    except (json.JSONDecodeError, OSError):
        raise HTTPException(404, "Session index unreadable")
    entry = next((t for t in topics if t.get("slug") == slug and t.get("file")), None)
    # The bag's own dir: from the cache manifest when keyed, else the legacy singleton.
    base = cache_manager.source_for(bag) if bag else session.bag_path
    if entry is None or base is None:
        raise HTTPException(404, f"No video for topic: {slug}")
    # `file` comes from our own index, but keep it contained anyway.
    p = (base / entry["file"]).resolve()
    if base.resolve() not in p.parents or not p.is_file():
        # videos may sit in a sub-folder of the upload
        matches = [v for v in video_indexer.find_videos(base) if v.name == entry["file"]]
        if not matches:
            raise HTTPException(404, f"Video file missing: {entry['file']}")
        p = matches[0]
    return p


@router.get("/topics/video/{slug}")
def topic_video(slug: str, request: Request, bag: Optional[str] = None):
    """Stream a session video, honouring Range requests.

    <video> relies on 206 partial responses to seek; without them the browser
    re-downloads from the start on every scrub, which breaks timeline sync.
    """
    path = _video_path(slug, bag)
    size = path.stat().st_size
    media = video_indexer.MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    range_header = request.headers.get("range") or request.headers.get("Range")

    if not range_header:
        return FileResponse(str(path), media_type=media,
                            headers={"Accept-Ranges": "bytes"})

    m = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        return FileResponse(str(path), media_type=media,
                            headers={"Accept-Ranges": "bytes"})
    if m.group(1):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    else:                                   # suffix range: last N bytes
        start = max(0, size - int(m.group(2)))
        end = size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    # Serve at most one chunk per request. A client asking for `bytes=0-` wants
    # the whole file, but answering with a bounded 206 (legal: a server may
    # return fewer bytes than asked) keeps memory flat and lets the browser
    # pull the rest. Returning an exact, fully-framed body avoids the
    # chunked-vs-Content-Length ambiguity that can make a player restart.
    end = min(end, start + VIDEO_CHUNK_BYTES - 1)
    with path.open("rb") as f:
        f.seek(start)
        payload = f.read(end - start + 1)
    return Response(content=payload, status_code=206, media_type=media, headers={
        "Content-Range": f"bytes {start}-{start + len(payload) - 1}/{size}",
        "Accept-Ranges": "bytes",
    })


@router.get("/topics/audio/{slug}")
def topic_audio(slug: str, bag: Optional[str] = None):
    """Serve the wrapped audio file (audio.wav, or a passthrough audio.<ext>)."""
    tdir = _topic_dir(slug, bag)
    media = {
        "wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac",
        "ogg": "audio/ogg", "opus": "audio/ogg", "aac": "audio/aac", "m4a": "audio/mp4",
    }
    for ext, mtype in media.items():
        f = tdir / f"audio.{ext}"
        if f.exists():
            return FileResponse(str(f), media_type=mtype)
    raise HTTPException(404, "No audio for this topic")


@router.get("/session/range")
def session_range(bag: Optional[str] = None):
    p = _cache_dir(bag) / "index.json"
    if not p.exists():
        return {"t_start": 0, "t_end": 0}
    d = json.loads(p.read_text())
    return {"t_start": d.get("t_start", 0), "t_end": d.get("t_end", 0)}


# ---------------------------------------------------------------------------
# Annotations of a session (annotations.json lives next to the bag)
# ---------------------------------------------------------------------------

def _annotations_file(bag: Optional[str]) -> Optional[Path]:
    """The bag dir for annotations: from the cache manifest when keyed, else
    the legacy singleton bag."""
    base = cache_manager.source_for(bag) if bag else session.bag_path
    return (base / "annotations.json") if base is not None else None


@router.get("/session/annotations")
def get_annotations(bag: Optional[str] = None):
    f = _annotations_file(bag)
    if f is None or not f.exists():
        return []
    try:
        return json.loads(f.read_text())
    except json.JSONDecodeError:
        return []


@router.post("/session/annotations")
def save_annotations(annotations: list[dict], bag: Optional[str] = None):
    f = _annotations_file(bag)
    if f is None:
        raise HTTPException(409, "No active session bag to attach annotations to.")
    if not f.parent.exists():
        raise HTTPException(409, f"Bag directory {f.parent} does not exist yet.")
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(annotations, indent=2), encoding="utf-8")
    tmp.replace(f)
    return {"ok": True, "path": str(f)}
