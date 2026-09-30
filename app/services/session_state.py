"""
Tracks the bag the dashboard is currently working with (recording or
uploaded), plus the pre-processing status shown in the upload screen.

Annotations always live in `annotations.json` next to the bag's .mcap and
metadata.yaml, so they travel with the recording.
"""
from __future__ import annotations

import json
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

    # -- bag / annotations ---------------------------------------------------
    def set_bag(self, path: Optional[Path]) -> None:
        with self._lock:
            self.bag_path = path

    def annotations_file(self) -> Optional[Path]:
        with self._lock:
            if self.bag_path is None:
                return None
            return self.bag_path / "annotations.json"

    def load_annotations(self) -> list:
        f = self.annotations_file()
        if f is None or not f.exists():
            return []
        try:
            return json.loads(f.read_text())
        except json.JSONDecodeError:
            return []

    def save_annotations(self, annotations: list) -> Path:
        f = self.annotations_file()
        if f is None:
            raise RuntimeError("No active session bag to attach annotations to.")
        # Never create the bag dir ourselves — `ros2 bag record -o` fails if
        # its output directory already exists.
        if not f.parent.exists():
            raise RuntimeError(f"Bag directory {f.parent} does not exist yet.")
        # Atomic: write a sibling temp file then rename over the target. A plain
        # write_text truncates first, so a crash or full disk mid-write would
        # leave a truncated annotations.json — losing the session's work.
        tmp = f.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(annotations, indent=2), encoding="utf-8")
        tmp.replace(f)
        return f


session = SessionState()
