from datetime import datetime
from typing import Optional
import json
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import RECORDINGS_DIR, SESSION_OUT_DIR
from app.services.recorder import recorder, list_bags
from app.services.bag_reader import get_bag_info
from app.services.session_state import session
from app.services import live_capture

router = APIRouter(prefix="/recordings", tags=["recordings"])


def _bag_dir(name: str) -> Path:
    """Resolve a recording name to a directory *inside* RECORDINGS_DIR.

    `name` comes straight from the URL, and one of these endpoints writes, so
    contain it the same way session.py::_topic_dir does rather than trusting
    the router not to hand us traversal.
    """
    p = (RECORDINGS_DIR / name).resolve()
    if RECORDINGS_DIR.resolve() not in p.parents or not p.is_dir():
        raise HTTPException(status_code=404, detail=f"Recording {name!r} not found")
    return p


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class StartRequest(BaseModel):
    topics: list[str] = Field(default_factory=list,
                              description="Topics to record; empty = record all",
                              examples=[["/chatter", "/tf"]])
    name: Optional[str] = Field(None, description="Optional bag folder name")


class StatusResponse(BaseModel):
    active: bool
    bag_path: Optional[str] = None
    topics: list[str] = []
    started_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Recorder control
# ---------------------------------------------------------------------------

@router.get("/status", response_model=StatusResponse)
async def status():
    s = recorder.state
    return StatusResponse(
        active=s.is_active,
        bag_path=str(s.bag_path) if s.bag_path else None,
        topics=s.topics,
        started_at=s.started_at,
    )


@router.post("/start", response_model=StatusResponse)
async def start(req: StartRequest):
    try:
        s = await recorder.start(req.topics, name=req.name)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    # Mirror the live graph into the session archive so the dashboard can
    # visualise the session while it's being recorded.
    session.set_bag(s.bag_path)
    live_capture.start(SESSION_OUT_DIR)
    return StatusResponse(
        active=s.is_active,
        bag_path=str(s.bag_path) if s.bag_path else None,
        topics=s.topics,
        started_at=s.started_at,
    )


@router.post("/stop", response_model=StatusResponse)
async def stop():
    live_capture.stop()
    try:
        s = await recorder.stop()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return StatusResponse(
        active=False,
        bag_path=str(s.bag_path) if s.bag_path else None,
        topics=s.topics,
        started_at=s.started_at,
    )


# ---------------------------------------------------------------------------
# Listing & metadata
# ---------------------------------------------------------------------------

@router.get("")
def list_recordings():
    return list_bags()


# ---------------------------------------------------------------------------
# Annotation categories
# ---------------------------------------------------------------------------

# Built-in taxonomy; user-created categories are appended to a dotfile next
# to the recordings so they travel with the data set.
DEFAULT_CATEGORIES = [
    {"id": "failure",      "label": "Failure",           "color": "#e8554e"},
    {"id": "recovery",     "label": "Recovery",          "color": "#3fb27f"},
    {"id": "intervention", "label": "Intervention",      "color": "#f5a623"},
    {"id": "anomaly",      "label": "Anomaly",           "color": "#9b6dff"},
    {"id": "note",         "label": "Note",              "color": "#5b8def"},
]
CATEGORIES_FILE = RECORDINGS_DIR / ".categories.json"

_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class CategoryRequest(BaseModel):
    label: str = Field(..., min_length=1, max_length=40)
    color: str = Field(..., description="Hex color, e.g. #e8554e")


def _load_custom_categories() -> list[dict]:
    if not CATEGORIES_FILE.exists():
        return []
    try:
        data = json.loads(CATEGORIES_FILE.read_text())
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def _all_categories() -> list[dict]:
    seen = {c["id"] for c in DEFAULT_CATEGORIES}
    merged = list(DEFAULT_CATEGORIES)
    for c in _load_custom_categories():
        if isinstance(c, dict) and c.get("id") and c["id"] not in seen:
            merged.append(c)
            seen.add(c["id"])
    return merged


@router.get("/annotations/categories")
def get_categories():
    return _all_categories()


@router.post("/annotations/categories")
def add_category(req: CategoryRequest):
    if not _HEX_COLOR_RE.match(req.color):
        raise HTTPException(400, "Color must be a hex value like #e8554e")
    cat_id = re.sub(r"[^a-z0-9]+", "_", req.label.strip().lower()).strip("_")
    if not cat_id:
        raise HTTPException(400, "Label must contain letters or digits")
    if any(c["id"] == cat_id for c in _all_categories()):
        raise HTTPException(409, f"Category {cat_id!r} already exists")

    custom = _load_custom_categories()
    custom.append({"id": cat_id, "label": req.label.strip(), "color": req.color})
    CATEGORIES_FILE.write_text(json.dumps(custom, indent=2))
    return _all_categories()


@router.get("/annotations")
def all_annotations():
    """Flat list of every annotation across all recordings, for the
    annotations explorer (filter/count by name across sessions)."""
    out = []
    for entry in sorted(RECORDINGS_DIR.iterdir()):
        ann_file = entry / "annotations.json"
        if not entry.is_dir() or not ann_file.exists():
            continue
        try:
            anns = json.loads(ann_file.read_text())
        except json.JSONDecodeError:
            continue
        if not isinstance(anns, list):
            continue
        from app.services.recorder import _read_bag_times
        times = _read_bag_times(entry)
        for a in anns:
            if not isinstance(a, dict):
                continue
            out.append({
                "recording": entry.name,
                "recording_start_ns": times.get("start_time_ns"),
                "id":       a.get("id"),
                "label":    a.get("label") or a.get("name") or a.get("category") or "unnamed",
                "category": a.get("category"),
                "t1":       a.get("t1"),
                "t2":       a.get("t2"),
                "note":       a.get("note"),
                "category_label": a.get("category_label"),
                "category_color": a.get("category_color"),
                "author":     a.get("author"),
                "created_at": a.get("created_at"),
            })
    return out


@router.get("/{name}/info")
def recording_info(name: str):
    bag_path = _bag_dir(name)
    info = get_bag_info(bag_path)
    return {
        "start_time_ns": info.start_time_ns,
        "end_time_ns":   info.end_time_ns,
        "duration_ns":   info.duration_ns,
        "topics": [
            {
                "name":          t.name,
                "msg_type":      t.msg_type,
                "message_count": t.message_count,
            }
            for t in info.topics
        ],
    }


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------

@router.get("/{name}/annotations")
def get_annotations(name: str):
    ann_file = _bag_dir(name) / "annotations.json"
    if not ann_file.exists():
        return []
    try:
        return json.loads(ann_file.read_text())
    except (json.JSONDecodeError, OSError):
        # Match all_annotations(): a corrupt file reads as empty rather than 500.
        return []


@router.post("/{name}/annotations")
def save_annotations(name: str, annotations: list[dict]):
    bag_path = _bag_dir(name)
    ann_file = bag_path / "annotations.json"
    # Atomic (see session_state.save_annotations): a truncating write that dies
    # halfway loses every annotation for this recording.
    tmp = ann_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(annotations, indent=2), encoding="utf-8")
    tmp.replace(ann_file)
    return {"ok": True}