"""
Wraps `ros2 bag record` as a managed subprocess.

We keep state in a single module-level instance because there's only
ever one active recording per backend process.
"""
from __future__ import annotations

import asyncio
import os
import re
import signal
import shutil
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional, IO
import yaml

import json
import psutil


from app.config import RECORDINGS_DIR

STATE_FILE = RECORDINGS_DIR / ".recorder_state.json"

# Refuse to start a recording if the recordings volume has less than this free.
MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB

# Names allowed: letters, digits, dash, underscore, dot. No path separators, no leading dot.
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_\-.]+$")


def _write_state(state: RecordingState) -> None:
    if not state.is_active or state.process is None:
        try:
            STATE_FILE.unlink()
        except FileNotFoundError:
            pass
        return
    STATE_FILE.write_text(json.dumps({
        "pid": state.process.pid,
        "bag_path": str(state.bag_path) if state.bag_path else None,
        "topics": state.topics,
        "started_at": state.started_at.isoformat() if state.started_at else None,
    }))


def _pid_is_ros2_bag(pid: int) -> bool:
    try:
        p = psutil.Process(pid)
        cmdline = p.cmdline()
        return (
            len(cmdline) >= 3
            and cmdline[0].endswith("ros2")
            and cmdline[1] == "bag"
            and cmdline[2] == "record"
        )
    except (psutil.NoSuchProcess, psutil.AccessDenied, IndexError):
        return False


def _sanitize_name(name: str) -> str:
    """Reject anything that could escape RECORDINGS_DIR or look like a hidden file."""
    if not name or len(name) > 128:
        raise ValueError("Recording name must be between 1 and 128 characters.")
    if name.startswith(".") or not _SAFE_NAME_RE.match(name):
        raise ValueError(
            "Recording name may only contain letters, digits, '.', '_' and '-', "
            "and must not start with '.'."
        )
    # Final defence: ensure it's a single path component.
    if Path(name).name != name:
        raise ValueError("Recording name must not contain path separators.")
    return name

@dataclass
class ExternalProcess:
    """A subprocess we adopted from a previous backend run.
    We can't get back a real asyncio.subprocess.Process, so we fake the interface
    we actually use: .pid, .returncode, and .wait()."""
    pid: int
    _returncode: Optional[int] = None

    @property
    def returncode(self) -> Optional[int]:
        if self._returncode is not None:
            return self._returncode
        if not psutil.pid_exists(self.pid):
            self._returncode = -1
            return self._returncode
        return None

    async def wait(self) -> int:
        while psutil.pid_exists(self.pid):
            await asyncio.sleep(0.2)
        if self._returncode is None:
            self._returncode = -1
        return self._returncode


def _try_reattach() -> Optional[RecordingState]:
    if not STATE_FILE.exists():
        return None
    try:
        data = json.loads(STATE_FILE.read_text())
    except json.JSONDecodeError:
        STATE_FILE.unlink(missing_ok=True)
        return None

    pid = data.get("pid")
    if not pid or not _pid_is_ros2_bag(pid):
        STATE_FILE.unlink(missing_ok=True)
        return None

    return RecordingState(
        process=ExternalProcess(pid=pid),  # type: ignore[arg-type]
        bag_path=Path(data["bag_path"]) if data.get("bag_path") else None,
        topics=data.get("topics", []),
        started_at=datetime.fromisoformat(data["started_at"]) if data.get("started_at") else None,
        log_file=None,  # we didn't open it; don't try to close it on stop
    )



@dataclass
class RecordingState:
    process: Optional[asyncio.subprocess.Process] = None
    bag_path: Optional[Path] = None
    topics: list[str] = field(default_factory=list)
    started_at: Optional[datetime] = None
    log_file: Optional[IO[bytes]] = None  # kept so we can close it on stop

    @property
    def is_active(self) -> bool:
        return self.process is not None and self.process.returncode is None


class Recorder:
    def __init__(self) -> None:
        self._state = _try_reattach() or RecordingState()
        self._lock = asyncio.Lock()

    @property
    def state(self) -> RecordingState:
        return self._state

    async def start(self, topics: list[str], name: Optional[str] = None) -> RecordingState:
        async with self._lock:
            if self._state.is_active:
                raise RuntimeError("A recording is already in progress.")

            if shutil.which("ros2") is None:
                raise RuntimeError(
                    "`ros2` not found on PATH. Did you source /opt/ros/jazzy/setup.bash "
                    "before launching uvicorn?"
                )

            # Disk-space guard.
            free = shutil.disk_usage(RECORDINGS_DIR).free
            if free < MIN_FREE_BYTES:
                raise RuntimeError(
                    f"Refusing to start recording: only {free / 1e9:.1f} GB free on "
                    f"{RECORDINGS_DIR} (minimum {MIN_FREE_BYTES / 1e9:.1f} GB)."
                )

            bag_name = _sanitize_name(name) if name else datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            bag_path = RECORDINGS_DIR / bag_name

            if bag_path.exists():
                raise RuntimeError(f"A recording named {bag_name!r} already exists.")

            # Empty topic list = record everything (-a).
            cmd = [
                "ros2", "bag", "record",
                "-s", "mcap",
                "-o", str(bag_path),
                *(topics if topics else ["-a"]),
            ]

            # Redirect stdout+stderr to a log file next to the bag.
            # If we left these as PIPE, the OS pipe buffer (~64KB) would fill on a
            # long run and ros2 bag record would block on write().
            log_path = bag_path.with_name(bag_name + ".log")
            log_file = open(log_path, "wb")

            # start_new_session=True puts the child in its own process group,
            # so we can signal the whole group cleanly on stop.
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=log_file,
                    stderr=asyncio.subprocess.STDOUT,
                    start_new_session=True,
                )
            except Exception:
                log_file.close()
                raise

            self._state = RecordingState(
                process=proc,
                bag_path=bag_path,
                topics=list(topics),
                started_at=datetime.now(),
                log_file=log_file,
            )
            _write_state(self._state)

            return self._state

    async def stop(self, timeout: float = 5.0) -> RecordingState:
        async with self._lock:
            if not self._state.is_active:
                raise RuntimeError("No recording in progress.")

            proc = self._state.process
            assert proc is not None

            # SIGINT to the whole process group — ros2 bag flushes & writes metadata.yaml
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGINT)
            except ProcessLookupError:
                pass

            try:
                await asyncio.wait_for(proc.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass
                await proc.wait()

            # Close the log file handle if we own one (not the case for reattached procs).
            if self._state.log_file is not None:
                try:
                    self._state.log_file.close()
                except Exception:
                    pass

            finished = self._state
            self._state = RecordingState()
            _write_state(self._state)
            
            # Create empty annotations file if it doesn't exist yet
            if finished.bag_path:
                annotations_file = finished.bag_path / "annotations.json"
                if not annotations_file.exists():
                    annotations_file.write_text("[]")

            return finished
        


def _read_bag_times(bag_path: Path) -> dict:
    metadata_file = bag_path / "metadata.yaml"
    if not metadata_file.exists():
        return {"start_time_ns": None, "end_time_ns": None, "duration_ns": None}
    
    data = yaml.safe_load(metadata_file.read_text())
    info = data.get("rosbag2_bagfile_information", {})
    start_ns = info.get("starting_time", {}).get("nanoseconds_since_epoch", None)
    duration_ns = info.get("duration", {}).get("nanoseconds", None)
    
    return {
        "start_time_ns": start_ns,
        "end_time_ns": (start_ns + duration_ns) if (start_ns and duration_ns) else None,
        "duration_ns": duration_ns,
    }


def list_bags() -> list[dict]:
    bags = []
    for entry in sorted(RECORDINGS_DIR.iterdir()):  # no reverse — let frontend sort
        if not entry.is_dir():
            continue
        metadata = entry / "metadata.yaml"
        mcap_files = list(entry.glob("*.mcap"))
        ann_file = entry / "annotations.json"
        ann_count = 0
        if ann_file.exists():
            try:
                anns = json.loads(ann_file.read_text())
                ann_count = len(anns) if isinstance(anns, list) else 0
            except json.JSONDecodeError:
                pass
        bags.append({
            "name": entry.name,
            "has_metadata": metadata.exists(),
            "mcap_files": [f.name for f in mcap_files],
            "size_bytes": sum(f.stat().st_size for f in entry.rglob("*") if f.is_file()),
            "annotation_count": ann_count,
            **_read_bag_times(entry),   # adds start/end/duration
        })
    return bags

recorder = Recorder()
