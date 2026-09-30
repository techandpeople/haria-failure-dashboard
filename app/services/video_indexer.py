"""
Builds a playable session from plain video files (no ROS bag involved).

Researchers often have a session recorded only as video — one file, or several
cameras filming the same run. Uploading those produces the same
`SESSION_OUT_DIR/index.json` contract the bag indexer writes, so the timeline,
annotations and panels work unchanged; the videos themselves are streamed from
disk rather than decoded into frames.

Duration is probed without decoding: ffprobe when it happens to be installed,
otherwise by reading the MP4/MOV `mvhd` header directly. If neither works the
duration is left at 0 and the frontend fills it in from the <video> element.
"""
from __future__ import annotations

import json
import re
import shutil
import struct
import subprocess
import time
from pathlib import Path
from typing import Optional

from app.services.session_state import session

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ogv"}

# Containers a browser <video> can generally play back directly. Anything else
# is still listed, but flagged so the panel can explain rather than show black.
BROWSER_PLAYABLE = {".mp4", ".m4v", ".webm", ".ogv", ".mov"}

MEDIA_TYPES = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".webm": "video/webm", ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo", ".ogv": "video/ogg",
}


def is_video(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTS


def find_videos(d: Path) -> list[Path]:
    """Video files in `d` (recursively), sorted by name for stable ordering."""
    return sorted((p for p in d.rglob("*") if p.is_file() and is_video(p)),
                  key=lambda p: p.name.lower())


def slug(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "_", name).strip("_")


# ---------------------------------------------------------------------------
# Duration probing
# ---------------------------------------------------------------------------

def _duration_ffprobe(path: Path) -> Optional[float]:
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip()) or None
    except Exception:
        return None


def _duration_mp4(path: Path) -> Optional[float]:
    """Read duration from the MP4/MOV `mvhd` box without decoding anything."""
    try:
        with path.open("rb") as f:
            def walk(end: int) -> Optional[float]:
                while f.tell() < end - 8:
                    head = f.read(8)
                    if len(head) < 8:
                        return None
                    size, kind = struct.unpack(">I4s", head)
                    start = f.tell()
                    if size == 1:                      # 64-bit extended size
                        size = struct.unpack(">Q", f.read(8))[0] - 8
                        start = f.tell()
                    elif size == 0:                    # extends to EOF
                        size = end - start + 8
                    body = size - 8
                    if body < 0:
                        return None
                    if kind == b"moov":
                        got = walk(start + body)
                        if got is not None:
                            return got
                    elif kind == b"mvhd":
                        ver = f.read(1)[0]
                        f.read(3)                      # flags
                        if ver == 1:
                            f.read(16)                 # created, modified (64-bit)
                            timescale = struct.unpack(">I", f.read(4))[0]
                            duration = struct.unpack(">Q", f.read(8))[0]
                        else:
                            f.read(8)                  # created, modified (32-bit)
                            timescale = struct.unpack(">I", f.read(4))[0]
                            duration = struct.unpack(">I", f.read(4))[0]
                        return duration / timescale if timescale else None
                    f.seek(start + body)
                return None
            return walk(path.stat().st_size)
    except Exception:
        return None


def probe_duration(path: Path) -> float:
    """Seconds, or 0.0 when it cannot be determined offline."""
    for probe in (_duration_ffprobe, _duration_mp4):
        d = probe(path)
        if d and d > 0:
            return float(d)
    return 0.0


# ---------------------------------------------------------------------------
# Entry point (mirrors bag_indexer.preprocess_bag)
# ---------------------------------------------------------------------------

def preprocess_videos(src_dir: Path, out_dir: Path) -> None:
    """Write index.json describing the videos in `src_dir`.

    The timeline runs 0 → longest video, so several cameras of the same run
    line up when the playhead drives them.
    """
    from app.services.bag_indexer import wipe_dir
    session.set_status("processing", "Reading video files…")
    try:
        videos = find_videos(src_dir)
        if not videos:
            raise FileNotFoundError(f"No video files found in {src_dir}")

        wipe_dir(out_dir)
        topics, longest = [], 0.0
        for i, v in enumerate(videos, 1):
            session.set_progress(f"Probing {v.name} ({i}/{len(videos)})…")
            dur = probe_duration(v)
            longest = max(longest, dur)
            ext = v.suffix.lower()
            topics.append({
                "topic": v.name,
                "slug": slug(v.stem),
                "msg_type": f"video{ext}",
                "count": 1,
                "t_start": 0.0,
                "t_end": dur,
                "last_msg": dur,
                "active": False,
                "is_image": False, "is_num": False, "is_table": False,
                "is_tf": False, "is_audio": False,
                "is_video_file": True,
                "playable": ext in BROWSER_PLAYABLE,
                "duration": dur,
                "file": v.name,
            })

        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.json").write_text(json.dumps({
            "timestamp": time.time(),
            "t_start": 0.0,
            "t_end": longest,
            "topics": topics,
            "phase_intervals": [],
            "session_kind": "video",
        }), encoding="utf-8")
        session.set_status("ready", "Done")
    except Exception:
        import traceback
        session.set_status("error", "", traceback.format_exc())
