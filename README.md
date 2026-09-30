# HARIA Failure Analysis Dashboard

A dashboard for reviewing and annotating robot (ROS 2 / Jazzy) recordings — and,
on Linux, recording live sessions. You open a folder of recordings ("bags"),
watch the cameras / depth / audio / sensor data on a synced timeline, and mark
what happened. Annotations are saved as a plain `annotations.json` right next to
each recording, so they travel with the data.

---

## Get started

You need **Docker Desktop** installed once — everything else is a double-click.

1. **Install Docker Desktop** → https://www.docker.com/products/docker-desktop/ → Windows also needs WSL2
2. Open it once and wait until it says it's running.
3. **Download** this project and unzip it.
4. **Double-click the launcher** in the `launch/<operating_system>` folder:
   - **macOS** → `HARIA.command` — first time, macOS may block it: right-click →
     **Open** → **Open** (it's unsigned).
   - **Windows** → `HARIA.bat`
   - **Linux** → `haria.sh`
5. The first time, it asks you to **choose your folder of recordings**. Pick the
   folder that contains your bags.
6. Your default browser opens the dashboard at **http://localhost:8000**.

To **stop** it, double-click `stop-HARIA` or use the docker to stop it.
To **change the working folder** later, click **Change folder** in the dashboard,
or edit the `BAGS=` line in the `.env` file next to `docker-compose.yml`.

> First launch downloads the app image once (a few hundred MB); later launches
> are fast. If the launcher says Docker isn't running, start Docker Desktop and
> try again.

---

## Using the dashboard

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
- **Scroll** to zoom in; **Shift-scroll** (or a trackpad's horizontal scroll) to
  pan when zoomed.

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

---

## Recording from a robot (Linux only)

Recording live needs ROS 2 network discovery and access to local camera/mic
devices, which only work on a **Linux** machine (host networking + device
passthrough). On macOS/Windows the dashboard is **playback/analysis only**.

On Linux, start the record profile:

```bash
BAGS=/path/to/save  docker compose --profile record up -d
# or: launch/record-haria.sh
```

Then in the dashboard choose **Record**, pick the topics to capture, and start.
The recording is written **inside your working folder**. (You can also run the
backend natively on the robot's Ubuntu machine — see **For developers**.)

---

## Remote / shared use

Run HARIA on one Linux machine and open it from any browser at
`http://<that-machine>:8000`. To keep the port private, tunnel over SSH:

```bash
ssh -L 8000:localhost:8000 user@that-machine    # then browse http://localhost:8000
```

On a shared server, set `HARIA_LOCK_ROOT=1` so users can only browse inside the
mounted folder.

---

## Troubleshooting

- **"Docker isn't running"** — open Docker Desktop, wait until it's ready, relaunch.
- **Nothing opens / port busy** — something else may be using `:8000`; stop it, or
  change the port mapping in `docker-compose.yml` (`"8001:8000"`) and open `:8001`.
- **My bags don't show** — make sure you pointed at the folder that *contains* the
  bag folders. A folder counts as a bag if it has a `.mcap`/`.db3` (or video). A
  `.zip`/`.tar.gz` shows with an **import** action to unpack it.
- **Change folder** — **Change folder** in the dashboard, or edit `BAGS=` in `.env`.
- **macOS "can't be opened"** — right-click `HARIA.command` → **Open** → **Open**.
- **Files owned by root (Linux)** — the container runs as root, so recordings and
  `.haria/` written into your folder are root-owned. `sudo chown -R $USER:$USER
  <folder>` to reclaim them, or run the backend natively (see below).
- **Wrong colours on depth** — set `HARIA_DEPTH_RANGE_M` (see below).

---

## For developers

Run from source on Linux with ROS 2 Jazzy installed:

```bash
source /opt/ros/jazzy/setup.bash
python3 -m venv --system-site-packages .venv   # first time only
source .venv/bin/activate
pip install -r requirements.txt               # first time only
./run.sh                                       # → http://localhost:8000
```

Build/run the container locally instead of pulling:

```bash
docker compose build && BAGS=/path/to/bags docker compose up
```

The image is published to `ghcr.io/pipsrocha/hariadashboard` by
`.github/workflows/docker-publish.yml`.

> **Maintainer:** so end users can pull without logging in, set the GHCR package
> to **Public** once (GitHub → repo → Packages → the image → Package settings →
> Change visibility → Public). Otherwise `docker compose pull` returns 401.

### Configuration (environment variables)

- `HARIA_ROOT` — folder the browser starts in (Docker: `/data`)
- `HARIA_CACHE_DIR` — persistent per-bag processed cache (Docker: `/cache`)
- `HARIA_STATE_DIR` — per-user pointer state (default under the cache dir)
- `HARIA_LOCK_ROOT` — `1` to confine browsing/opening to `HARIA_ROOT` (shared servers)
- `HARIA_RECORDINGS_DIR` — where recordings/uploads land when no folder is chosen
- `HARIA_DEPTH_RANGE_M` — depth colour range as `"lo,hi"` metres (e.g. `0.3,2.0`);
  default `auto` derives it from the first frames. Fixed per session so depth
  video doesn't throb.

### Layout

```
dashboard-backend/
├── app/
│   ├── main.py              # FastAPI entry point, serves the frontend
│   ├── config.py            # paths (override via env vars)
│   ├── ros_manager.py       # rclpy lifecycle + shared executor
│   ├── routers/             # session, recordings, folders, topics, health
│   └── services/            # recorder, live_capture, bag_indexer,
│                            # cache_manager, user_state, session_cache, …
├── frontend/                # index.html + static/ (sidebar, panels, timeline, explorer)
├── Dockerfile               # ROS 2 Jazzy + the app
├── requirements.txt
└── run.sh
docker-compose.yml           # playback (any OS) + record (Linux) profiles
launch/                      # double-click launchers per OS
```

Notes: annotations live in `annotations.json` next to each bag. The dashboard
processes each bag once into a per-bag cache (`HARIA_CACHE_DIR`) so reopening is
instant and different people can view different bags at the same time.
