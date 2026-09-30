"""
In-memory cache of the session archive for fast time-window queries.

The dashboard polls /topics/data and /topics/image several times a second
per panel; re-reading and re-parsing whole JSONL files (or re-globbing the
frame directory) on every request costs O(file size) and stalls the whole
backend once a few panels are open. This cache parses each data.jsonl once,
tails only appended bytes on subsequent requests (live recording keeps
growing the files), and answers window queries with a binary search.

Memory note: decoded entries for the whole session are kept resident. For
typical HRI sessions this is tens of MB; if bags grow far beyond that, an
eviction strategy belongs here.
"""
from __future__ import annotations

import json
import threading
import time
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class _TopicData:
    ino: int = -1          # file identity — a wiped/recreated file resets the cache
    offset: int = 0        # bytes already consumed
    entries: list = field(default_factory=list)
    ts: list = field(default_factory=list)   # parallel array of entry["t"] for bisect


@dataclass
class _FrameIndex:
    mtime_ns: int = -1
    ts: list = field(default_factory=list)
    names: list = field(default_factory=list)
    checked_at: float = 0.0   # monotonic time of the last directory scan


# While a recording is live the frame directory's mtime changes constantly, so
# a plain mtime check re-globs the whole directory on every poll — O(frames)
# several times a second, which dominates once a session has thousands of
# frames. Re-scan at most this often; playback (static mtime) never rescans.
FRAME_RESCAN_INTERVAL = 0.3   # seconds


class SessionCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, _TopicData] = {}
        self._frames: dict[str, _FrameIndex] = {}

    def invalidate(self, prefix: Optional[str] = None) -> None:
        """Drop cached entries. With a path prefix, drop only entries under that
        directory (keys are file paths), so rebuilding one bag doesn't clear the
        in-memory caches of other bags open in concurrent sessions."""
        with self._lock:
            if prefix is None:
                self._data.clear()
                self._frames.clear()
                return
            for store in (self._data, self._frames):
                for k in [k for k in store if k.startswith(prefix)]:
                    store.pop(k, None)

    # -- windowed data -------------------------------------------------------

    def window(self, jsonl: Path, slug: str, lo_t: float, hi_t: float) -> list:
        """Entries with lo_t <= t <= hi_t, parsing only bytes appended since
        the previous call. Entries are appended in time order by both the
        indexer and the live-capture node."""
        # Key by the file path, not the bare slug, so the same slug in two
        # different bag caches (multi-session) never collide.
        key = str(jsonl)
        with self._lock:
            try:
                st = jsonl.stat()
            except FileNotFoundError:
                self._data.pop(key, None)
                return []

            c = self._data.get(key)
            if c is None or st.st_ino != c.ino or st.st_size < c.offset:
                c = self._data[key] = _TopicData(ino=st.st_ino)

            if st.st_size > c.offset:
                with jsonl.open("rb") as f:
                    f.seek(c.offset)
                    chunk = f.read()
                # A live writer may be mid-line at EOF — consume whole lines only.
                nl = chunk.rfind(b"\n")
                if nl >= 0:
                    for line in chunk[:nl].split(b"\n"):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            e = json.loads(line)
                        except ValueError:
                            continue
                        c.entries.append(e)
                        c.ts.append(e.get("t", 0.0))
                    c.offset += nl + 1

            lo = bisect_left(c.ts, lo_t)
            hi = bisect_right(c.ts, hi_t)
            return c.entries[lo:hi]

    # -- image frames --------------------------------------------------------

    def _frame_index(self, tdir: Path, slug: str) -> Optional[_FrameIndex]:
        """Return the cached frame index, rescanning only when mtime changes."""
        # Key by the directory path, not the bare slug (multi-session safe).
        key = str(tdir)
        try:
            mt = tdir.stat().st_mtime_ns
        except FileNotFoundError:
            self._frames.pop(key, None)
            return None

        c = self._frames.get(key)
        now = time.monotonic()
        # Live recording bumps mtime constantly; reuse the index until the
        # rescan interval elapses instead of re-globbing on every poll.
        if c is not None and mt != c.mtime_ns and now - c.checked_at < FRAME_RESCAN_INTERVAL:
            return c
        if c is None or mt != c.mtime_ns:
            pairs = []
            for f in tdir.glob("*.jpg"):
                if f.stem == "latest":
                    continue
                try:
                    pairs.append((float(f.stem), f.name))
                except ValueError:
                    continue
            pairs.sort()
            c = self._frames[key] = _FrameIndex(
                mtime_ns=mt,
                ts=[p[0] for p in pairs],
                names=[p[1] for p in pairs],
                checked_at=now,
            )
        return c

    def nearest_frame(self, tdir: Path, slug: str, t: float) -> Optional[Path]:
        """Path of the JPEG frame closest to t, rescanning the directory only
        when its mtime changes."""
        with self._lock:
            c = self._frame_index(tdir, slug)
            if c is None or not c.ts:
                return None
            i = bisect_left(c.ts, t)
            best = min(
                (j for j in (i - 1, i) if 0 <= j < len(c.ts)),
                key=lambda j: abs(c.ts[j] - t),
            )
            return tdir / c.names[best]

    def frame_times(self, tdir: Path, slug: str) -> list:
        """Sorted list of frame timestamps for a topic (for the video panel)."""
        with self._lock:
            c = self._frame_index(tdir, slug)
            return list(c.ts) if c else []


session_cache = SessionCache()
