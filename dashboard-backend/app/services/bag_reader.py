"""
Reads .mcap bags for the HARIA dashboard.

Only bag *introspection* lives here — time range and topic list, used by the
recordings router. The WebSocket streaming/serialisation half was removed as
dead code: nothing in the frontend ever connected to it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from mcap.reader import make_reader            # mcap

log = logging.getLogger(__name__)


@dataclass
class BagInfo:
    start_time_ns: int
    end_time_ns:   int
    duration_ns:   int
    topics: list[TopicInfo]


@dataclass
class TopicInfo:
    name:          str
    msg_type:      str
    message_count: int


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_bag_info(bag_path: Path) -> BagInfo:
    """
    Return time range and topic list without streaming any messages.
    Called once when the user opens a recording — populates the timeline
    and the topic selector.
    """
    with open(bag_path / _find_mcap(bag_path), "rb") as f:
        reader = make_reader(f)
        # A bag whose recorder was killed (rather than stopped) can lack the
        # summary section entirely; .statistics can also be absent. Degrade to
        # zeros instead of raising AttributeError on None.
        summary  = reader.get_summary()
        stats    = getattr(summary, "statistics", None) if summary else None
        channels = summary.channels if summary else {}
        schemas  = {s.id: s for s in summary.schemas.values()} if summary else {}

        start_ns = stats.message_start_time if stats else 0
        end_ns   = stats.message_end_time if stats else 0

        topics: list[TopicInfo] = []
        for ch in channels.values():
            schema   = schemas.get(ch.schema_id)
            msg_type = schema.name if schema else "unknown"
            count    = stats.channel_message_counts.get(ch.id, 0) if stats else 0
            topics.append(TopicInfo(
                name=ch.topic,
                msg_type=msg_type,
                message_count=count,
            ))

    return BagInfo(
        start_time_ns=start_ns,
        end_time_ns=end_ns,
        duration_ns=end_ns - start_ns,
        topics=topics,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_mcap(bag_path: Path) -> str:
    """
    Return the name of the .mcap file inside the bag directory.
    Raises if none or more than one found (ambiguous).
    """
    mcap_files = list(bag_path.glob("*.mcap"))
    if not mcap_files:
        raise FileNotFoundError(f"No .mcap file found in {bag_path}")
    if len(mcap_files) > 1:
        # ros2 bag record splits files over a size threshold — use the first shard
        mcap_files.sort()
        log.warning(
            "%d .mcap shards found in %s — streaming from first shard only. "
            "Multi-shard support is not yet implemented.",
            len(mcap_files), bag_path,
        )
    return mcap_files[0].name
