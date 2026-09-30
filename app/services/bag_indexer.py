"""
Pre-processes a recorded ROS 2 bag (.mcap or .db3) into a time-indexed
on-disk archive the frontend can scrub through freely:

    session_out/
    ├── index.json                # topic list + global time range
    └── <topic_slug>/
        ├── data.jsonl            # one JSON entry per message, keyed by "t"
        ├── latest.json           # most recent decoded message
        ├── <t>.jpg               # per-frame JPEGs (image topics)
        └── latest.jpg

Runs as a FastAPI background task; progress is reported through
`session_state.session.status` and polled by the frontend.
"""
from __future__ import annotations

import json
import re
import math
import shutil
import struct
import time
import traceback
from pathlib import Path
from typing import Any, Optional

from app.services.session_state import session

# Types too large / not useful to fully deserialise for the dashboard.
# Their timestamps are still written so the timeline shows coverage.
# (TFMessage is NOT skipped — the 3D/TF panel needs the transforms; it is
# stored compactly, not as full _raw.)
SKIP_TYPES = {
    "std_msgs/msg/String",              # robot_description URDF — huge
    "moveit_msgs/msg/PlanningScene",
    "moveit_msgs/msg/DisplayTrajectory",
    "moveit_msgs/msg/AttachedCollisionObject",
    "moveit_msgs/msg/CollisionObject",
    "rcl_interfaces/msg/ParameterEvent",
    "rosgraph_msgs/msg/Clock",
}

NUMERIC_HINTS = ["Float", "Int", "UInt", "Bool", "JointState", "Imu",
                 "Wrench", "Twist", "Pose", "Vector3", "Odometry", "NavSatFix"]


def is_tf_type(msg_type: str) -> bool:
    return "tf2_msgs/msg/TFMessage" in msg_type


def is_audio_data_type(msg_type: str) -> bool:
    return ("audio_common_msgs/msg/AudioData" in msg_type
            or "audio_common_msgs/msg/AudioDataStamped" in msg_type)


def is_audio_info_type(msg_type: str) -> bool:
    return "audio_common_msgs/msg/AudioInfo" in msg_type


def is_task_state_phase(topic: str) -> bool:
    """Matched by topic name: /task_state/phase is a std_msgs/String (which is
    otherwise skipped), whose .data is the current task phase."""
    return topic.endswith("/task_state/phase")


def slug(topic: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]", "_", topic).strip("_")


def is_numeric_type(msg_type: str) -> bool:
    return any(n in msg_type for n in NUMERIC_HINTS)


def wipe_dir(path: Path) -> None:
    """Empty a session output directory so archives never mix."""
    from app.services.session_cache import session_cache
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True, exist_ok=True)
    session_cache.invalidate()


def find_bag_root(base: Path) -> Path:
    """Locate the directory containing metadata.yaml inside an extracted archive."""
    if (base / "metadata.yaml").exists():
        return base
    for m in sorted(base.rglob("metadata.yaml")):
        return m.parent
    return base


# ---------------------------------------------------------------------------
# Entry point (run as a background task)
# ---------------------------------------------------------------------------

def preprocess_bag(bag_path: Path, out_dir: Path) -> None:
    session.set_status("processing", "Reading bag metadata…")
    try:
        storage_id = _detect_storage(bag_path)
        wipe_dir(out_dir)
        if storage_id == "mcap":
            _preprocess_mcap(bag_path, out_dir)
        elif storage_id == "sqlite3":
            _preprocess_sqlite(bag_path, out_dir)
        else:
            raise FileNotFoundError(
                f"No .mcap or .db3 files found in {bag_path}"
            )
        session.set_status("ready", "Done")
    except Exception:
        session.set_status("error", "", traceback.format_exc())


def _detect_storage(bag_path: Path) -> Optional[str]:
    meta_file = bag_path / "metadata.yaml"
    if meta_file.exists():
        import yaml
        meta = yaml.safe_load(meta_file.read_text())
        if isinstance(meta, dict):
            info = meta.get("rosbag2_bagfile_information", meta)
            if isinstance(info, dict) and info.get("storage_identifier"):
                return info["storage_identifier"]
    if list(bag_path.glob("*.mcap")):
        return "mcap"
    if list(bag_path.glob("*.db3")):
        return "sqlite3"
    return None


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------

class _TopicWriter:
    """Per-topic sink with a long-lived file handle. Opening data.jsonl per
    message (the previous approach) dominated indexing time on large bags;
    latest.json / latest.jpg are only written once, on close().

    Audio topics also stream chunk bytes to audio.raw and are wrapped into a
    playable file on close() using `audio_info` (shared dict, populated from
    the bag's AudioInfo topic if present)."""

    def __init__(self, out_dir: Path, topic: str, msg_type: str,
                 audio_info: Optional[dict] = None) -> None:
        self.topic    = topic
        self.msg_type = msg_type
        self.tdir     = out_dir / slug(topic)
        self.tdir.mkdir(parents=True, exist_ok=True)
        self._jsonl = (self.tdir / "data.jsonl").open("a", encoding="utf-8")
        self._last_entry: Optional[dict] = None
        self._last_img:   Optional[bytes] = None

        self.is_audio = is_audio_data_type(msg_type)
        self._audio_info = audio_info if audio_info is not None else {}
        self._audio_raw = (self.tdir / "audio.raw").open("wb") if self.is_audio else None
        self._audio_bytes = 0

        # Depth: the colour range must be constant across the session, so the
        # first frames are buffered until it is known, then flushed.
        self.is_depth = False
        self.depth_range_m: Optional[tuple] = None
        self._depth_range: Optional[tuple] = None
        self._depth_buf: list = []

    def timestamp_only(self, t: float) -> None:
        self._jsonl.write(json.dumps({"t": t}) + "\n")

    def add_audio(self, t: float, chunk: Optional[bytes]) -> None:
        if chunk and self._audio_raw is not None:
            self._audio_raw.write(chunk)
            self._audio_bytes += len(chunk)
        self._jsonl.write(json.dumps({"t": t, "type": "audio", "bytes": len(chunk or b"")}) + "\n")

    def add_depth(self, t: float, depth_mm) -> None:
        """A depth frame in millimetres. Buffered until the colour range is
        settled, then written as a colourised JPEG like any image frame."""
        self.is_depth = True
        if depth_mm is None:
            self.timestamp_only(t)
            return
        if self._depth_range is None:
            self._depth_buf.append((t, depth_mm))
            if len(self._depth_buf) >= DEPTH_RANGE_SAMPLES:
                self._settle_depth_range()
            return
        self._write_depth(t, depth_mm)

    def _settle_depth_range(self) -> None:
        from app.config import HARIA_DEPTH_RANGE_M
        cfg = str(HARIA_DEPTH_RANGE_M).strip().lower()
        rng = None
        if cfg and cfg != "auto":
            try:
                lo_m, hi_m = (float(x) for x in cfg.split(",", 1))
                if hi_m > lo_m >= 0:
                    rng = (lo_m * 1000.0, hi_m * 1000.0)
            except ValueError:
                rng = None
        if rng is None:
            rng = _depth_auto_range([f for _, f in self._depth_buf])
        self._depth_range = rng
        self.depth_range_m = (round(rng[0] / 1000.0, 2), round(rng[1] / 1000.0, 2))
        for bt, bf in self._depth_buf:
            self._write_depth(bt, bf)
        self._depth_buf.clear()

    def _write_depth(self, t: float, depth_mm) -> None:
        lo, hi = self._depth_range
        jpg = _colorize_depth(depth_mm, lo, hi)
        if jpg is None:
            self.timestamp_only(t)
            return
        (self.tdir / f"{t:.3f}.jpg").write_bytes(jpg)
        self._last_img = jpg
        self._jsonl.write(json.dumps({"t": t, "type": "depth",
                                      "frame": f"{t:.3f}.jpg"}) + "\n")

    def add(self, t: float, raw: Any, img_bytes: Optional[bytes] = None) -> None:
        if img_bytes is not None:
            (self.tdir / f"{t:.3f}.jpg").write_bytes(img_bytes)
            self._last_img = img_bytes
            entry = {"t": t, "type": "image", "frame": f"{t:.3f}.jpg"}
        elif is_tf_type(self.msg_type):
            # Compact per-frame transforms; no _raw (TF is high-frequency)
            entry = {"t": t, "tf": _extract_tf(raw)}
            self._last_entry = entry
        else:
            if not isinstance(raw, dict):
                raw = {"_raw_str": str(raw)}
            entry = {"t": t, "_raw": raw}
            if "JointState" in self.msg_type and "name" in raw:
                entry["__names"]  = raw.get("name", [])
                entry["position"] = raw.get("position", [])
                entry["velocity"] = raw.get("velocity", [])
                entry["effort"]   = raw.get("effort", [])
            elif is_numeric_type(self.msg_type):
                # Top-level numeric fields so chart panels can plot without _raw
                entry.update(_numeric_summary(raw))
            self._last_entry = entry
        self._jsonl.write(json.dumps(entry) + "\n")

    def close(self) -> None:
        # A short topic may never have reached DEPTH_RANGE_SAMPLES.
        if self._depth_buf:
            self._settle_depth_range()
        try:
            self._jsonl.close()
        except Exception:
            pass
        if self._audio_raw is not None:
            try:
                self._audio_raw.close()
            except Exception:
                pass
            _finalise_audio(self.tdir, self._audio_bytes, self._audio_info)
        if self._last_img is not None:
            (self.tdir / "latest.jpg").write_bytes(self._last_img)
        if self._last_entry is not None:
            (self.tdir / "latest.json").write_text(
                json.dumps({"t": self._last_entry["t"], "topic": self.topic,
                            "msg_type": self.msg_type, **self._last_entry}),
                encoding="utf-8",
            )


def _apply_depth_info(topic_info: dict, writers: dict) -> None:
    """Copy each depth topic's settled colour range into the index so the panel
    can draw a legend."""
    for topic, w in writers.items():
        if not getattr(w, "is_depth", False) or topic not in topic_info:
            continue
        topic_info[topic]["is_depth"] = True
        if w.depth_range_m:
            topic_info[topic]["depth_range_m"] = list(w.depth_range_m)


def _write_index(out_dir: Path, topic_info: dict, t_start: float, t_end: float,
                 phases: Optional[list] = None) -> None:
    topics = [
        {**ti, "topic": name, "active": False, "last_msg": ti.get("t_end", t_end)}
        for name, ti in topic_info.items()
    ]
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "index.json").write_text(json.dumps({
        "timestamp": time.time(),
        "t_start": t_start,
        "t_end": t_end,
        "topics": topics,
        "phase_intervals": _phase_intervals(phases or [], t_end),
    }), encoding="utf-8")


def _phase_intervals(values: list, bag_end: float) -> list:
    """Collapse a (t_seconds, phase) stream into [{phase, t_start, t_end}] by
    merging consecutive-equal phases; the last interval ends at bag_end.
    Ported from hri_curator/scanner.py:_phase_intervals (ns → seconds)."""
    if not values:
        return []
    values = sorted(values)
    compact = []
    for t, phase in values:
        if not compact or compact[-1][1] != phase:
            compact.append((t, phase))
    out = []
    for i, (t, phase) in enumerate(compact):
        end = compact[i + 1][0] if i + 1 < len(compact) else bag_end
        out.append({"phase": phase, "t_start": t, "t_end": end})
    return out


def _new_topic_info(msg_type: str, topic: str, t: float) -> dict:
    return {
        "msg_type": msg_type, "slug": slug(topic), "count": 0,
        "t_start": t, "t_end": t,
        "is_image": "Image" in msg_type,
        "is_num":   is_numeric_type(msg_type),
        "is_table": "JointState" in msg_type,
        "is_tf":    is_tf_type(msg_type),
        "is_audio": is_audio_data_type(msg_type),
        "is_depth": False,          # set once a depth frame is actually seen
    }


# ---------------------------------------------------------------------------
# MCAP
# ---------------------------------------------------------------------------

def _preprocess_mcap(bag_path: Path, out_dir: Path) -> None:
    from mcap.reader import make_reader
    from mcap_ros2.decoder import DecoderFactory

    mcap_files = sorted(bag_path.glob("*.mcap"))

    # Pass 1: count messages for progress reporting.
    session.set_progress("Counting messages…")
    total = 0
    for mf in mcap_files:
        with mf.open("rb") as f:
            summary = make_reader(f).get_summary()
            if summary and summary.statistics:
                total += summary.statistics.message_count
            else:
                for _ in make_reader(f).iter_messages():
                    total += 1

    topic_info: dict = {}
    writers: dict[str, _TopicWriter] = {}
    audio_info: dict = {}
    phases: list = []
    t_start = t_end = None
    processed = 0
    last_pct = -1

    try:
        for mf in mcap_files:
            with mf.open("rb") as f:
                reader = make_reader(f, decoder_factories=[DecoderFactory()])
                for schema, channel, message, decoded in reader.iter_decoded_messages():
                    processed += 1
                    pct = int(processed / max(1, total) * 100)
                    if pct != last_pct:
                        last_pct = pct
                        session.set_progress(f"Processing… {pct}% ({processed}/{total} msgs)")

                    t        = message.log_time / 1e9
                    topic    = channel.topic
                    msg_type = schema.name if schema else "unknown"

                    t_start = t if t_start is None else min(t_start, t)
                    t_end   = t if t_end   is None else max(t_end,   t)

                    ti = topic_info.setdefault(topic, _new_topic_info(msg_type, topic, t))
                    ti["count"] += 1
                    ti["t_start"] = min(ti["t_start"], t)
                    ti["t_end"]   = max(ti["t_end"],   t)

                    w = writers.get(topic)
                    if w is None:
                        w = writers[topic] = _TopicWriter(out_dir, topic, msg_type, audio_info)

                    _handle_message(w, t, msg_type, decoded, audio_info, phases)
    finally:
        for w in writers.values():
            w.close()

    _apply_depth_info(topic_info, writers)
    _write_index(out_dir, topic_info, t_start or 0, t_end or 0, phases)


# ---------------------------------------------------------------------------
# SQLite (.db3)
# ---------------------------------------------------------------------------

def _preprocess_sqlite(bag_path: Path, out_dir: Path) -> None:
    import sqlite3

    topic_info: dict = {}
    writers: dict[str, _TopicWriter] = {}
    msg_classes: dict[str, Any] = {}
    audio_info: dict = {}
    phases: list = []
    t_start = t_end = None

    try:
        for db_file in sorted(bag_path.glob("*.db3")):
            session.set_progress(f"Processing {db_file.name}…")
            conn = sqlite3.connect(str(db_file))
            cur = conn.cursor()

            cur.execute("SELECT id, name, type FROM topics")
            topics_map = {row[0]: (row[1], row[2]) for row in cur.fetchall()}

            cur.execute("SELECT topic_id, timestamp, data FROM messages ORDER BY timestamp")
            for topic_id, ts_ns, data in cur:
                if topic_id not in topics_map:
                    continue
                topic_name, msg_type = topics_map[topic_id]
                t = ts_ns / 1e9

                t_start = t if t_start is None else min(t_start, t)
                t_end   = t if t_end   is None else max(t_end,   t)

                ti = topic_info.setdefault(topic_name, _new_topic_info(msg_type, topic_name, t))
                ti["count"] += 1
                ti["t_start"] = min(ti["t_start"], t)
                ti["t_end"]   = max(ti["t_end"], t)

                w = writers.get(topic_name)
                if w is None:
                    w = writers[topic_name] = _TopicWriter(out_dir, topic_name, msg_type, audio_info)

                # Skip heavy types, but let /task_state/phase through so its
                # String payload can be decoded (it is in SKIP_TYPES otherwise).
                if msg_type in SKIP_TYPES and not is_task_state_phase(topic_name):
                    w.timestamp_only(t)
                    continue

                try:
                    from rclpy.serialization import deserialize_message
                    if msg_type not in msg_classes:
                        from rosidl_runtime_py.utilities import get_message
                        msg_classes[msg_type] = get_message(msg_type)
                    msg = deserialize_message(bytes(data), msg_classes[msg_type])
                except Exception:
                    w.timestamp_only(t)
                    continue

                _handle_message(w, t, msg_type, msg, audio_info, phases)

            conn.close()
    finally:
        for w in writers.values():
            w.close()

    _apply_depth_info(topic_info, writers)
    _write_index(out_dir, topic_info, t_start or 0, t_end or 0, phases)


# ---------------------------------------------------------------------------
# Per-message dispatch (shared by the mcap and sqlite paths)
# ---------------------------------------------------------------------------

def _handle_message(w: "_TopicWriter", t: float, msg_type: str,
                    decoded: Any, audio_info: dict, phases: list) -> None:
    # Phase topic first: /task_state/phase is a std_msgs/String (which SKIP_TYPES
    # would otherwise drop), but its .data is the task phase we want to keep.
    if is_task_state_phase(w.topic):
        phases.append((t, str(getattr(decoded, "data", "") or "")))
        w.timestamp_only(t)
        return
    if msg_type in SKIP_TYPES:
        w.timestamp_only(t)
        return
    if is_audio_data_type(msg_type):
        w.add_audio(t, _extract_audio_bytes(decoded))
        return
    if is_audio_info_type(msg_type):
        _capture_audio_info(decoded, audio_info)
        w.timestamp_only(t)
        return

    raw = {}
    try:
        raw = _decoded_to_dict(decoded)
    except Exception:
        pass

    if is_depth_message(decoded, msg_type):
        w.add_depth(t, _decode_depth_frame(decoded, msg_type))
        return

    img_bytes = None
    if "Image" in msg_type:
        img_bytes = _decode_image_bytes(decoded, msg_type)

    w.add(t, raw, img_bytes)


# ---------------------------------------------------------------------------
# TF extraction
# ---------------------------------------------------------------------------

def _extract_tf(raw: Any) -> list:
    """Compact TFMessage → [[parent, child, x,y,z, qx,qy,qz,qw], …].
    `raw` is the dict from _decoded_to_dict; float precision is preserved."""
    out = []
    if not isinstance(raw, dict):
        return out
    for tr in (raw.get("transforms") or []):
        if not isinstance(tr, dict):
            continue
        parent = ((tr.get("header") or {}).get("frame_id")) or ""
        child  = tr.get("child_frame_id") or ""
        tf = tr.get("transform") or {}
        tl = tf.get("translation") or {}
        rt = tf.get("rotation") or {}
        try:
            out.append([
                str(parent), str(child),
                float(tl.get("x", 0.0)), float(tl.get("y", 0.0)), float(tl.get("z", 0.0)),
                float(rt.get("x", 0.0)), float(rt.get("y", 0.0)),
                float(rt.get("z", 0.0)), float(rt.get("w", 1.0)),
            ])
        except (TypeError, ValueError):
            continue
    return out


# ---------------------------------------------------------------------------
# Audio extraction
# ---------------------------------------------------------------------------

def _to_bytes(data: Any) -> Optional[bytes]:
    if data is None:
        return None
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    try:
        import numpy as np
        if isinstance(data, np.ndarray):
            return data.tobytes()
    except ImportError:
        pass
    try:
        # array('B', …) or a list/tuple of ints
        return bytes(bytearray(data))
    except (TypeError, ValueError):
        return None


def _extract_audio_bytes(decoded: Any) -> Optional[bytes]:
    """Raw chunk bytes from AudioData / AudioDataStamped."""
    data = getattr(decoded, "data", None)
    if data is None:
        audio = getattr(decoded, "audio", None)     # AudioDataStamped
        if audio is not None:
            data = getattr(audio, "data", None)
    return _to_bytes(data)


def _capture_audio_info(decoded: Any, audio_info: dict) -> None:
    """Populate the shared audio params dict from an AudioInfo message."""
    ch   = getattr(decoded, "channels", None)
    rate = getattr(decoded, "sample_rate", None)
    fmt  = getattr(decoded, "coding_format", None)
    if ch:
        try: audio_info["channels"] = int(ch)
        except (TypeError, ValueError): pass
    if rate:
        try: audio_info["sample_rate"] = int(rate)
        except (TypeError, ValueError): pass
    if fmt:
        audio_info["coding_format"] = str(fmt)


# Container formats we cannot rewrap as WAV — keep the concatenated stream.
_COMPRESSED_AUDIO = {"mp3", "mpeg", "flac", "ogg", "opus", "aac", "m4a"}


def _finalise_audio(tdir: Path, nbytes: int, audio_info: dict) -> None:
    """Wrap the streamed audio.raw into a playable file. PCM streams become
    audio.wav (16-bit) using AudioInfo params when present; compressed
    streams (mp3/…) are kept as-is with the right extension."""
    raw_path = tdir / "audio.raw"
    if nbytes <= 0:
        raw_path.unlink(missing_ok=True)
        return

    fmt = str(audio_info.get("coding_format", "")).lower().strip()
    if fmt in _COMPRESSED_AUDIO:
        ext = "mp3" if fmt == "mpeg" else fmt
        raw_path.replace(tdir / f"audio.{ext}")
        return

    import wave
    ch   = int(audio_info.get("channels") or 1) or 1
    rate = int(audio_info.get("sample_rate") or 16000) or 16000
    pcm  = raw_path.read_bytes()
    frame_bytes = 2 * ch
    if len(pcm) % frame_bytes:
        pcm = pcm[: len(pcm) - (len(pcm) % frame_bytes)]
    try:
        with wave.open(str(tdir / "audio.wav"), "wb") as wf:
            wf.setnchannels(ch)
            wf.setsampwidth(2)
            wf.setframerate(rate)
            wf.writeframes(pcm)
        raw_path.unlink(missing_ok=True)
    except Exception:
        # Leave audio.raw in place if wrapping failed
        pass


def _numeric_summary(raw: Any, prefix: str = "", out: Optional[dict] = None,
                     depth: int = 0) -> dict:
    """Flatten numeric fields of a decoded message into dotted top-level keys
    (e.g. wrench.force.x). Header timestamps are skipped — they'd pollute
    every chart with epoch-sized values."""
    if out is None:
        out = {}
    if depth > 4 or len(out) >= 24:
        return out
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k.startswith("_") or k == "header":
                continue
            _numeric_summary(v, f"{prefix}{k}." if isinstance(v, dict) else f"{prefix}{k}",
                             out, depth + 1)
    elif isinstance(raw, bool):
        out[prefix.rstrip(".") or "value"] = float(raw)
    elif isinstance(raw, (int, float)):
        out[prefix.rstrip(".") or "value"] = raw
    elif isinstance(raw, list) and raw and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in raw[:8]):
        out[prefix.rstrip(".") or "value"] = raw[:64]
    return out


# ---------------------------------------------------------------------------
# Decoding helpers
# ---------------------------------------------------------------------------

def _decoded_to_dict(msg: Any) -> dict:
    def _conv(v: Any, d: int = 0) -> Any:
        if d > 5:
            return str(v)
        if hasattr(v, "get_fields_and_field_types"):
            return {f: _conv(getattr(v, f), d + 1) for f in v.get_fields_and_field_types()}
        if hasattr(v, "__slots__") and not isinstance(v, (str, bytes)):
            # mcap_ros2 decoded messages expose __slots__, not the rclpy API
            return {s.lstrip("_"): _conv(getattr(v, s), d + 1) for s in v.__slots__}
        if isinstance(v, (list, tuple)):
            return [_conv(x, d + 1) for x in v][:256]
        if isinstance(v, bytes):
            return list(v[:64])
        try:
            json.dumps(v)
            return v
        except (TypeError, ValueError):
            return str(v)

    result = _conv(msg)
    return result if isinstance(result, dict) else {"_value": result}


# ---------------------------------------------------------------------------
# Depth images
# ---------------------------------------------------------------------------
# image_transport's compressedDepth payload is a 12-byte ConfigHeader followed
# by a 16-bit PNG — not a normal image, which is why feeding the whole buffer to
# imdecode(IMREAD_COLOR) yields nothing. Depth is distance, so we map it to
# colour ourselves against a FIXED range: per-frame autoscaling makes the video
# throb as objects move.

DEPTH_ENCODINGS = ("16uc1", "32fc1", "mono16")
DEPTH_RANGE_SAMPLES = 12          # frames pooled before fixing an auto range
_DEPTH_HEADER_BYTES = 12


def is_depth_message(msg: Any, msg_type: str) -> bool:
    if "Image" not in msg_type:
        return False
    if "Compressed" in msg_type:
        return "compresseddepth" in str(getattr(msg, "format", "")).lower()
    return str(getattr(msg, "encoding", "")).lower() in DEPTH_ENCODINGS


def _decode_depth_frame(msg: Any, msg_type: str):
    """Depth in millimetres as a numpy array (0 = no return), or None."""
    try:
        import cv2
        import numpy as np

        if "Compressed" in msg_type:
            data = bytes(msg.data)
            fmt = str(getattr(msg, "format", "")).lower()
            if "rvl" in fmt:
                return None            # newer RVL transport — not a PNG payload
            if len(data) <= _DEPTH_HEADER_BYTES:
                return None
            _, quant_a, quant_b = struct.unpack("<iff", data[:_DEPTH_HEADER_BYTES])
            raw = cv2.imdecode(np.frombuffer(data[_DEPTH_HEADER_BYTES:], np.uint8),
                               cv2.IMREAD_UNCHANGED)
            if raw is None:
                return None
            if "32fc1" in fmt:
                # inverse-depth quantised: metres = A / (px - B)
                out = np.zeros(raw.shape, dtype=np.float32)
                valid = raw > 0
                denom = raw.astype(np.float32) - quant_b
                np.divide(quant_a, denom, out=out, where=valid & (denom != 0))
                return out * 1000.0
            return raw.astype(np.float32)          # 16UC1 is already millimetres
        else:
            from cv_bridge import CvBridge
            raw = CvBridge().imgmsg_to_cv2(msg, desired_encoding="passthrough")
            enc = str(getattr(msg, "encoding", "")).lower()
            arr = np.asarray(raw)
            return arr.astype(np.float32) * (1000.0 if enc == "32fc1" else 1.0)
    except Exception:
        return None


def _depth_auto_range(frames: list) -> tuple:
    """(lo_mm, hi_mm) from pooled valid pixels — 5th/95th percentile, rounded
    outward to 0.1 m so the legend reads cleanly."""
    import numpy as np
    vals = []
    for f in frames:
        v = f[np.isfinite(f) & (f > 0)]
        if v.size:
            vals.append(v[:: max(1, v.size // 20000)])     # subsample for speed
    if not vals:
        return 300.0, 5000.0
    pool = np.concatenate(vals)
    lo, hi = float(np.percentile(pool, 5)), float(np.percentile(pool, 95))
    lo = max(0.0, math.floor(lo / 100.0) * 100.0)
    hi = math.ceil(hi / 100.0) * 100.0
    if hi - lo < 200.0:
        hi = lo + 200.0
    return lo, hi


def _colorize_depth(depth_mm, lo_mm: float, hi_mm: float) -> Optional[bytes]:
    """Metric depth -> TURBO-coloured JPEG; invalid pixels render black."""
    try:
        import cv2
        import numpy as np
        span = max(1.0, hi_mm - lo_mm)
        norm = np.clip((depth_mm - lo_mm) / span, 0.0, 1.0)
        d8 = (norm * 255.0).astype(np.uint8)
        cmap = getattr(cv2, "COLORMAP_TURBO", cv2.COLORMAP_JET)   # TURBO needs cv2>=4.1
        colour = cv2.applyColorMap(d8, cmap)
        colour[~(np.isfinite(depth_mm) & (depth_mm > 0))] = 0
        ok, buf = cv2.imencode(".jpg", colour, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        return buf.tobytes() if ok else None
    except Exception:
        return None


def _decode_image_bytes(msg: Any, msg_type: str) -> Optional[bytes]:
    """JPEG bytes for an Image/CompressedImage message. CompressedImage
    frames that are already JPEG are passed through untouched — decoding and
    re-encoding them dominated indexing time on camera-heavy bags. Returns
    None if the OpenCV / cv_bridge stack isn't available (dashboard degrades
    gracefully)."""
    try:
        if "Compressed" in msg_type:
            fmt = str(getattr(msg, "format", "")).lower()
            if "jpeg" in fmt or "jpg" in fmt:
                return bytes(msg.data)
        import cv2
        import numpy as np
        if "Compressed" in msg_type:
            arr = np.frombuffer(bytes(msg.data), dtype=np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        else:
            from cv_bridge import CvBridge
            frame = CvBridge().imgmsg_to_cv2(msg, desired_encoding="bgr8")
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        return buf.tobytes() if ok else None
    except Exception:
        return None
