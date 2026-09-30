from pydantic import BaseModel


class TopicInfo(BaseModel):
    name: str
    types: list[str]  # ROS allows a topic to have multiple type announcements