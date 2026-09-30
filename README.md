# HARIA Failure Analysis Dashboard

Web dashboard for ROS 2 (Jazzy) visualisation and recording of HRI sessions,
with annotations saved as JSON.

You can upload `.mcap`, `.db3`, a `.zip`/`.tar.gz` archive, or plain video files — one at a time or several together (e.g., multiple cameras of one run playback in sync on a shared timeline).

## Branches

- **`master`** — single user, one session at a time. For a personal Linux
  workstation: record from a live ROS 2 graph, and/or play back and annotate bags.
  
- **`multisession`** — Intended for a shared **Linux server** in the lab
  (near the robots, where recordings are made) maintaining a per-user state, so several people can use the same instance at once and resume their own work.

- **`docker`** — `multisession` packaged as a container for machines without a local
  ROS install (**Mac / Windows**), aimed at **playback and offline annotation**.
  

## Remote access & who can record

The dashboard is a web app, so **where recording runs is separate from how a person
reaches the UI**. Recording always happens on the machine that can see the live ROS 2
graph — the Linux server on the same network / `ROS_DOMAIN_ID` as the robot. Remote
users just drive it through the browser:

| Where you are | How you record |
| --- | --- |
| master/multisession | Directly — the server has the live ROS graph |
| docker + robots on the LAN | Open `http://<lab-server>:8000` in a browser and click Record — the **server** records, nothing runs on your laptop |
| docker + server not directly reachable | SSH-tunnel the web port, then open `http://localhost:8000` (recording still runs on the server) |


SSH tunnel (when the server isn't directly reachable on the network):

```bash
ssh -L 8000:localhost:8000 user@lab-server
# then open http://localhost:8000 in your browser
```

Note: SSH here only carries the browser session — it is not "recording over SSH".
What enables recording is the Linux server's access to the live robot topics.

## ROS 1 data

HARIA is ROS 2 only — it reads ROS 2 bags (`.mcap` / `.db3`) and introspects the
ROS 2 (DDS) graph. ROS 1 uses `.bag` files and a different transport, so convert or
bridge to ROS 2 first:

- **ROS 1 `.bag` files (offline)** — convert to a ROS 2 bag, then upload as usual:
  ```bash
  pip install rosbags                              # pure-Python, no ROS install needed
  rosbags-convert --src session.bag --dst session_ros2/


## Layout

```
├── app/
│ ├── main.py # FastAPI entry point, serves the frontend
│ ├── config.py # paths (override via env vars)
│ ├── ros_manager.py # rclpy lifecycle + shared executor
│ ├── schemas.py
│ ├── routers/
│ │ ├── session.py # upload, topic archive, playback status, session annotations
│ │ ├── recordings.py # record start/stop, bag list/info, categories, per-bag annotations
│ │ ├── topics.py # live ROS topic list (REST + WebSocket)
│ │ └── health.py
│ └── services/
│ ├── recorder.py # ros2 bag record subprocess (mcap)
│ ├── live_capture.py # live topic capture during recording
│ ├── bag_indexer.py # bag → JSONL/JPEG archive for scrubbing
│ ├── bag_reader.py # mcap introspection: time range + topic list
│ ├── video_indexer.py # video-only sessions → index.json (no bag)
│ ├── session_cache.py # in-memory window cache for fast /topics queries
│ └── session_state.py # current bag + annotations persistence
├── frontend/
│ ├── index.html
│ └── static/ # sidebar.js, panels.js, timeline.js, explorer.js, style.css
├── recordings/ # bags land here (gitignored)
├── session_out/ # scrubbable archive of the current session (gitignored)
├── requirements.txt
└── run.sh
```

## Running

```bash
source /opt/ros/jazzy/setup.bash
python3 -m venv --system-site-packages .venv   # first time only
source .venv/bin/activate
pip install -r requirements.txt               # first time only
./run.sh
```

Open http://localhost:8000

Paths are configurable via environment variables:

- `HARIA_RECORDINGS_DIR` — where bags are recorded/uploaded
(default dashboard-backend/recordings/)
- `HARIA_SESSION_DIR` — scratch dir for the current session's scrubbable archive
(default dashboard-backend/session_out/)
- `HARIA_DEPTH_RANGE_M` — near/far range used to colourise depth topics, as "lo,hi"
in metres (e.g. 0.3,2.0 for a tabletop scene). Default auto derives it from the
first frames of each depth topic. The range is fixed for the whole session on
purpose — autoscaling per frame makes depth video throb.

## How to Use

**Who's working** — on first use it asks your name (shown as the “hi _name_” chip,
top-right). It's remembered, used as the default annotation author, and each
folder keeps its own recent-sessions list per person.

**Pick / browse a folder** — the folder picker lists your subfolders and any
usable files:
- 🤖 a **rosbag** (a folder with a `.mcap`/`.db3`, or a `.mcap` file) — click to open
- 🎬 a **video**, 📦 a **`.zip`/`.tar.gz`** (click to unpack and open)
- 📁 subfolders — click to go deeper; **Use this folder** remembers it as your
  workspace, and the Home list then shows every bag inside it.

**Open a bag** → the dashboard loads. Left = **ROS Topics** (cameras, depth,
audio, sensors, other). Click a topic to open a panel. Middle = the panels you
can move/resize. Right = **Annotations**. Bottom = the **timeline**.

**Watch & navigate the timeline**
- **Space** = play / pause. Drag the playhead to scrub.
- **Scroll** to zoom in;
- **Shift-scroll** (or a trackpad's horizontal scroll) to  pan when zoomed.

**Annotate**
- Drag across a timeline lane to select a range (works either direction), or
  click **➕ Add annotation** to drop one at the playhead.
- Give it a **category** (Failure / Recovery / Intervention / Anomaly / Note, or
  make your own), a **label**, an optional **note** and **author**.
- Each annotation shows its label, category, author, time range, and which lane
  it's in. Start/end times are editable, and the block moves on the timeline.
- Add more **timelines (lanes)** with the **+ Timeline** button (e.g. per author
  or per video). Lanes from a loaded file are read-only (grey); your own are
  editable.
- Click **⤓ Save** to write everything to the bag's `annotations.json`. Sort the
  list by **bag time** or **added time**.
- (Playback only) **Import** a **codebook** (`.json`/`.csv`) of categories and
  labels to consult while annotating — it's session-only and never saved.

**Annotations explorer** (from Home) — browse annotations across all bags:
grouped by category → label, sortable, filterable by category / label / author /
bag, with CSV/JSON export. Click any occurrence to jump into that bag at that
moment.

**Recording** (from Home) - Choose from the available topics in the network, or leave it blank to record all topics available. Give your session a name and start recording.
STOP to stop and save recording.
