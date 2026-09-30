"""
Tracks the bag the dashboard is currently working with (recording or
uploaded), plus the pre-processing status shown in the upload screen.

Annotations always live in `annotations.json` next to the bag's .mcap and
metadata.yaml, so they travel with the recording.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Optional


class SessionState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.bag_path: Optional[Path] = None
        self.status: dict = {"state": "idle", "progress": "", "error": ""}

    # -- status ------------------------------------------------------------
    def set_status(self, state: str, progress: str = "", error: str = "") -> None:
        with self._lock:
            self.status = {"state": state, "progress": progress, "error": error}

    def set_progress(self, progress: str) -> None:
        with self._lock:
            self.status["progress"] = progress

    # -- bag ----------------------------------------------------------------
    # Annotation read/write now lives in the session router keyed per bag
    # (app/routers/session.py:_annotations_file), so the dashboard is
    # multi-session safe; this class only tracks the legacy "current" bag and
    # the single-slot processing status used as a fallback.
    def set_bag(self, path: Optional[Path]) -> None:
        with self._lock:
            self.bag_path = path


session = SessionState()
