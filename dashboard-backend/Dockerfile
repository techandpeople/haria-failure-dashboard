# HARIA Failure Analysis Dashboard — backend + frontend in one image.
#
# The backend links against the ROS 2 stack (rclpy, cv_bridge, rosbag2's mcap
# reader), which is Linux-only and comes from ROS apt packages, not pip — hence
# a ROS base image. Playback/analysis works on any OS via Docker; live recording
# needs Linux with host networking + device passthrough (see docker-compose.yml).
FROM ros:jazzy-ros-base

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PYTHONUNBUFFERED=1 \
    HARIA_ROOT=/data \
    HARIA_CACHE_DIR=/cache \
    HARIA_RECORDINGS_DIR=/data

# ROS / system deps the app imports (not available on pip):
#  - cv-bridge + python3-opencv  : image decoding (cv2, cv_bridge)
#  - rosbag2-storage-mcap        : reading .mcap bags
#  - audio-common-msgs           : audio topics (best-effort; skipped if absent)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ros-jazzy-cv-bridge \
        ros-jazzy-rosbag2-storage-mcap \
        python3-opencv \
        python3-pip \
    && (apt-get install -y --no-install-recommends ros-jazzy-audio-common-msgs || \
        echo "note: ros-jazzy-audio-common-msgs unavailable — audio topics limited") \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY frontend ./frontend

VOLUME ["/data", "/cache"]
EXPOSE 8000

# Source ROS then run uvicorn (mirrors run.sh, without --reload). exec so signals
# reach uvicorn for a clean container stop.
ENTRYPOINT ["/bin/bash", "-lc", "source /opt/ros/jazzy/setup.bash && exec python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log"]
