import asyncio

from fastapi import WebSocket, WebSocketDisconnect, APIRouter

from app.ros_manager import ros_manager
from app.schemas import TopicInfo

router = APIRouter(prefix="/topics", tags=["topics"])


@router.get("/live", response_model=list[TopicInfo])
def list_live_topics() -> list[TopicInfo]:
    """Return all topics currently visible on the ROS 2 graph."""
    node = ros_manager.introspection_node
    raw = node.get_topic_names_and_types()
    return [TopicInfo(name=name, types=types) for name, types in raw]


@router.websocket("/live/ws")
async def live_topics_ws(ws: WebSocket) -> None:
    await ws.accept()
    node = ros_manager.introspection_node
    try:
        previous: list[tuple[str, tuple[str, ...]]] = []
        while True:
            current = [(n, tuple(t)) for n, t in node.get_topic_names_and_types()]
            if current != previous:
                await ws.send_json(
                    [{"name": n, "types": list(t)} for n, t in current]
                )
                previous = current
            await asyncio.sleep(2.0)
    except WebSocketDisconnect:
        return