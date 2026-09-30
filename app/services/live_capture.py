"""
Live capture node — the dashboard's eyes during a recording.

Subscribes to every discoverable ROS 2 topic and mirrors the on-disk archive
format produced by `bag_indexer` (per-topic data.jsonl / latest.json / JPEG
frames + a periodically refreshed index.json), so the frontend can scrub a
session while it is still being recorded.

Runs inside the backend process on the shared `ros_manager` executor —
no subprocess to babysit.
"""
from __future__ import annotations

import json
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from rosidl_runtime_py.utilities import get_message

from app.ros_manager import ros_manager
from app.services.bag_indexer import (
    _COMPRESSED_AUDIO,
    _capture_audio_info,
    _extract_audio_bytes,
    is_audio_data_type,
    is_audio_info_type,
    is_numeric_type,
    slug,
    wipe_dir,
)

RING_BUFFER_SECONDS = 300   # 5 min in-memory per topic
DISCOVERY_INTERVAL  = 2.0   # seconds between topic sweeps
INDEX_INTERVAL      = 0.5   # seconds between index.json refreshes
SKIP_TOPICS = {"/parameter_events", "/rosout", "/clock"}


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def _atomic_write_text(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _is_image_type(t: str) -> bool:
    return "sensor_msgs/msg/Image" in t or "sensor_msgs/msg/CompressedImage" in t


def _msg_to_dict(msg: Any, depth: int = 0) -> Any:
    if depth > 5:
        return str(msg)
    if hasattr(msg, "get_fields_and_field_types"):
        return {f: _msg_to_dict(getattr(msg, f), depth + 1)
                for f in msg.get_fields_and_field_types()}
    if isinstance(msg, (list, tuple)):
        items = [_msg_to_dict(v, depth + 1) for v in msg]
        return items[:256]
    if isinstance(msg, bytes):
        return list(msg[:64])
    try:
        json.dumps(msg)
        return msg
    except (TypeError, ValueError):
        return str(msg)


def _extract_numeric(msg: Any, msg_type: str) -> Dict[str, List[float]]:
    result: Dict[str, List[float]] = {}
    if "JointState" in msg_type:
        if msg.name:
            result["__names"] = list(msg.name)
            if list(msg.position): result["position"] = list(msg.position)
            if list(msg.velocity): result["velocity"] = list(msg.velocity)
            if list(msg.effort):   result["effort"]   = list(msg.effort)
        return result
    if "Imu" in msg_type:
        result["angular_velocity"]    = [msg.angular_velocity.x, msg.angular_velocity.y, msg.angular_velocity.z]
        result["linear_acceleration"] = [msg.linear_acceleration.x, msg.linear_acceleration.y, msg.linear_acceleration.z]
        return result
    if "Wrench" in msg_type:
        w = msg.wrench if hasattr(msg, "wrench") else msg
        result["force"]  = [w.force.x,  w.force.y,  w.force.z]
        result["torque"] = [w.torque.x, w.torque.y, w.torque.z]
        return result
    if "Twist" in msg_type:
        tw = msg.twist if hasattr(msg, "twist") and hasattr(msg.twist, "linear") else msg
        result["linear"]  = [tw.linear.x,  tw.linear.y,  tw.linear.z]
        result["angular"] = [tw.angular.x, tw.angular.y, tw.angular.z]
        return result
    if "Odometry" in msg_type:
        result["position"] = [msg.pose.pose.position.x, msg.pose.pose.position.y, msg.pose.pose.position.z]
        result["velocity"] = [msg.twist.twist.linear.x, msg.twist.twist.linear.y, msg.twist.twist.linear.z]
        return result
    if hasattr(msg, "data"):
        d = msg.data
        if isinstance(d, (int, float, bool)):
            result["value"] = [float(d)]
        elif hasattr(d, "__iter__"):
            result["value"] = list(d)[:64]
    return result


def _depth_to_bgr(depth: Any) -> Optional[Any]:
    """Colorize a single-channel depth map (uint16 / float32) for preview.

    Zero and non-finite pixels are treated as "no reading" and rendered black;
    the rest are percentile-stretched and run through a JET colormap. This is a
    visualization, not metric depth — good enough to monitor a depth camera live.
    """
    import cv2
    import numpy as np
    d = np.asarray(depth)
    if d.ndim == 3:
        d = d[..., 0]
    d = d.astype(np.float32)
    valid = np.isfinite(d) & (d > 0)
    if not valid.any():
        return np.zeros((*d.shape, 3), dtype=np.uint8)
    lo = float(np.percentile(d[valid], 2))
    hi = float(np.percentile(d[valid], 98))
    if hi <= lo:
        hi = lo + 1.0
    norm = np.clip((d - lo) / (hi - lo), 0.0, 1.0)
    color = cv2.applyColorMap((norm * 255).astype(np.uint8), cv2.COLORMAP_JET)
    color[~valid] = 0
    return color


def _decode_compressed_depth(msg: Any, fmt: str) -> Optional[Any]:
    """Decode a compressed_depth_image_transport CompressedImage.

    The payload is a 12-byte ConfigHeader (int32 format enum + two float32
    quantization params) followed by the PNG (or RVL) bitstream. cv2 cannot
    decode RVL, so those are skipped.
    """
    import cv2
    import numpy as np
    if "rvl" in fmt:
        return None
    data = bytes(msg.data)
    if len(data) <= 12:
        return None
    raw = cv2.imdecode(np.frombuffer(data[12:], dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if raw is None:
        return None
    return _depth_to_bgr(raw)


_DEPTH_ENCODINGS = {"16uc1", "32fc1", "mono16"}


def _audio_peak(chunk: bytes, info: dict) -> float:
    """A 0..1 level for a PCM chunk (peak sample), for the live meter.

    Compressed streams (mp3/opus/…) can't be metered cheaply, so their mere
    presence is reported as full level while data is flowing.
    """
    if not chunk:
        return 0.0
    fmt = str(info.get("coding_format", "")).lower().strip()
    if fmt in _COMPRESSED_AUDIO:
        return 1.0
    try:
        import array
        a = array.array("h")
        n = len(chunk) - (len(chunk) % 2)
        if n <= 0:
            return 0.0
        a.frombytes(chunk[:n])
        peak = max((abs(x) for x in a), default=0)
        return min(1.0, peak / 32768.0)
    except Exception:
        return 0.0


def _encode_jpeg(msg: Any, msg_type: str) -> Optional[bytes]:
    try:
        import cv2
        import numpy as np
        frame = None
        if "Compressed" in msg_type:
            fmt = (getattr(msg, "format", "") or "").lower()
            if "compresseddepth" in fmt:
                frame = _decode_compressed_depth(msg, fmt)
            else:
                arr = np.frombuffer(msg.data, dtype=np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        else:
            from cv_bridge import CvBridge
            bridge = CvBridge()
            enc = (getattr(msg, "encoding", "") or "").lower()
            if enc in _DEPTH_ENCODINGS:
                depth = bridge.imgmsg_to_cv2(msg, desired_encoding="passthrough")
                frame = _depth_to_bgr(depth)
            else:
                frame = bridge.imgmsg_to_cv2(msg, desired_encoding="bgr8")
        if frame is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        return buf.tobytes() if ok else None
    except Exception:
        return None


class _TopicHandler:
    def __init__(self, topic: str, msg_type: str, out_dir: Path,
                 audio_info: Optional[dict] = None) -> None:
        self.closed   = False
        self.topic    = topic
        self.msg_type = msg_type
        self.slug     = slug(topic)
        self.is_image = _is_image_type(msg_type)
        self.is_audio = is_audio_data_type(msg_type)
        self.is_num   = is_numeric_type(msg_type) and not self.is_audio
        self.is_table = "JointState" in msg_type
        self.dir      = out_dir / self.slug
        self.dir.mkdir(parents=True, exist_ok=True)

        self._ring: Deque[dict] = deque()
        self._jsonl = (self.dir / "data.jsonl").open("a", encoding="utf-8")

        self.last_stamp: float = 0.0
        self.t_start:    float = 0.0
        self.count:      int   = 0

        # Audio: stream chunk bytes to audio.raw and keep a live level for the
        # meter; a playable audio.wav is (re)wrapped periodically by flush_wav.
        self._audio_info = audio_info if audio_info is not None else {}
        self._audio_raw = (self.dir / "audio.raw").open("wb") if self.is_audio else None
        self.audio_bytes: int = 0
        self.level: float = 0.0
        self._wav_bytes: int = -1
        self._wav_at: float = 0.0

    def flush_wav(self, force: bool = False) -> None:
        """Wrap the audio.raw accumulated so far into a playable file, keeping
        audio.raw in place so streaming continues. Self-throttled to ~2s
        (rewrapping is O(bytes)); force=True on close writes the final file."""
        if not self.is_audio or self._audio_raw is None:
            return
        if self.audio_bytes <= 0 or self.audio_bytes == self._wav_bytes:
            return
        now = time.time()
        if not force and (now - self._wav_at) < 2.0:
            return
        self._wav_at = now
        try:
            self._audio_raw.flush()
            raw = (self.dir / "audio.raw").read_bytes()
            fmt = str(self._audio_info.get("coding_format", "")).lower().strip()
            if fmt in _COMPRESSED_AUDIO:
                ext = "mp3" if fmt == "mpeg" else fmt
                _atomic_write(self.dir / f"audio.{ext}", raw)
            else:
                import io, wave
                ch   = int(self._audio_info.get("channels") or 1) or 1
                rate = int(self._audio_info.get("sample_rate") or 16000) or 16000
                fb   = 2 * ch
                if len(raw) % fb:
                    raw = raw[: len(raw) - (len(raw) % fb)]
                buf = io.BytesIO()
                with wave.open(buf, "wb") as wf:
                    wf.setnchannels(ch)
                    wf.setsampwidth(2)
                    wf.setframerate(rate)
                    wf.writeframes(raw)
                _atomic_write(self.dir / "audio.wav", buf.getvalue())
            self._wav_bytes = self.audio_bytes
        except Exception:
            pass

    def handle(self, msg: Any) -> None:
        # A subscription can outlive stop() if node teardown partially fails;
        # never write to the session archive after close().
        if self.closed:
            return
        now = time.time()
        if self.t_start == 0.0:
            self.t_start = now
        self.last_stamp = now
        self.count += 1

        if self.is_audio:
            chunk = _extract_audio_bytes(msg) or b""
            if chunk and self._audio_raw is not None:
                self._audio_raw.write(chunk)
                self.audio_bytes += len(chunk)
            self.level = _audio_peak(chunk, self._audio_info)
            entry = {"t": now, "type": "audio", "bytes": len(chunk),
                     "level": round(self.level, 4)}
            self._ring.append(entry)
            cutoff = now - RING_BUFFER_SECONDS
            while self._ring and self._ring[0]["t"] < cutoff:
                self._ring.popleft()
            self._jsonl.write(json.dumps(entry) + "\n")
            self._jsonl.flush()
            return

        if self.is_image:
            jpeg = _encode_jpeg(msg, self.msg_type)
            if jpeg:
                _atomic_write(self.dir / "latest.jpg", jpeg)
                (self.dir / f"{now:.3f}.jpg").write_bytes(jpeg)
            entry = {"t": now, "type": "image", "frame": f"{now:.3f}.jpg"}
        else:
            entry = {"t": now}
            if self.is_num:
                entry.update(_extract_numeric(msg, self.msg_type))
            entry["_raw"] = _msg_to_dict(msg)
            _atomic_write_text(self.dir / "latest.json", json.dumps(
                {"t": now, "topic": self.topic, "msg_type": self.msg_type, **entry}))

        self._ring.append(entry)
        cutoff = now - RING_BUFFER_SECONDS
        while self._ring and self._ring[0]["t"] < cutoff:
            self._ring.popleft()
        self._jsonl.write(json.dumps(entry) + "\n")
        self._jsonl.flush()

    def close(self) -> None:
        self.closed = True
        if self._audio_raw is not None:
            try:
                self.flush_wav(force=True)   # final wrap so the live cache is playable
            except Exception:
                pass
            try:
                self._audio_raw.close()
            except Exception:
                pass
        try:
            self._jsonl.close()
        except Exception:
            pass


class LiveCaptureNode(Node):
    def __init__(self, out_dir: Path) -> None:
        super().__init__("haria_live_capture")
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.handlers: Dict[str, _TopicHandler] = {}
        self._subs: dict = {}
        self._audio_info: dict = {}     # shared AudioInfo params (channels/rate/format)
        self._qos = QoSProfile(
            depth=10,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )
        self.create_timer(DISCOVERY_INTERVAL, self._discover)
        self.create_timer(INDEX_INTERVAL, self._write_index)
        self._discover()
        self.get_logger().info(f"Live capture started — writing to {self.out_dir}")

    def _discover(self) -> None:
        for topic, type_list in self.get_topic_names_and_types():
            if topic in self._subs or topic in SKIP_TOPICS or not type_list:
                continue
            msg_type_str = type_list[0]
            try:
                msg_class = get_message(msg_type_str)
            except Exception:
                continue
            # AudioInfo describes the stream (channels/rate/format) but isn't a
            # data topic — capture it into the shared dict, don't mirror it.
            if is_audio_info_type(msg_type_str):
                self._subs[topic] = self.create_subscription(
                    msg_class, topic,
                    lambda msg: _capture_audio_info(msg, self._audio_info),
                    self._qos,
                )
                self.get_logger().info(f"  ~ {topic}  [AudioInfo]")
                continue
            handler = _TopicHandler(topic, msg_type_str, self.out_dir, self._audio_info)
            self.handlers[topic] = handler
            self._subs[topic] = self.create_subscription(
                msg_class, topic,
                lambda msg, h=handler: h.handle(msg),
                self._qos,
            )
            self.get_logger().info(f"  + {topic}  [{msg_type_str}]")

    def _write_index(self) -> None:
        now = time.time()
        topics = []
        t_min, t_max = now, 0.0
        for h in self.handlers.values():
            if h.t_start > 0:
                t_min = min(t_min, h.t_start)
            t_max = max(t_max, h.last_stamp)
            active = (now - h.last_stamp) < 5.0 if h.last_stamp else False
            if h.is_audio:
                h.flush_wav()             # throttled by INDEX_INTERVAL (0.5s)
            topics.append({
                "topic":    h.topic,
                "msg_type": h.msg_type,
                "slug":     h.slug,
                "is_image": h.is_image,
                "is_audio": h.is_audio,
                "is_num":   h.is_num,
                "is_table": h.is_table,
                "last_msg": h.last_stamp,
                "count":    h.count,
                "active":   active,
                # Live mic level (0..1); only meaningful for active audio topics.
                "level":    round(h.level, 4) if h.is_audio and active else 0.0,
            })
        _atomic_write_text(self.out_dir / "index.json", json.dumps({
            "timestamp": now,
            "t_start":   t_min if topics else now,
            "t_end":     t_max if t_max > 0 else now,
            "topics":    topics,
        }))

    def close(self) -> None:
        # Tear down piecewise with per-step guards: destroy_node() can throw
        # (e.g. InvalidHandle racing the spinning executor), and a single
        # failure must not leave subscriptions or timers firing.
        for h in self.handlers.values():
            h.close()
        for sub in list(self._subs.values()):
            try:
                self.destroy_subscription(sub)
            except Exception:
                pass
        self._subs.clear()
        for timer in list(self.timers):
            try:
                self.destroy_timer(timer)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Module-level lifecycle (one live capture at a time)
# ---------------------------------------------------------------------------

_node: Optional[LiveCaptureNode] = None
_lock = threading.Lock()


def start(out_dir: Path) -> None:
    global _node
    with _lock:
        if _node is not None:
            return
        wipe_dir(out_dir)
        _node = LiveCaptureNode(out_dir)
        ros_manager.add_node(_node)


def stop() -> None:
    global _node
    with _lock:
        if _node is None:
            return
        node, _node = _node, None
        node.close()          # silence handlers + destroy subs/timers first
        ros_manager.remove_node(node)
        try:
            node.destroy_node()
        except Exception:
            pass


def is_active() -> bool:
    return _node is not None
