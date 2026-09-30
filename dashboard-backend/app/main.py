from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import FRONTEND_DIR
from app.ros_manager import ros_manager
from app.routers import folders, health, recordings, session, topics
from app.services import live_capture
from app.services.recorder import recorder


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    ros_manager.start()
    yield
    # Shutdown
    live_capture.stop()
    if recorder.state.is_active:
        try:
            await recorder.stop()
        except Exception:
            pass
    ros_manager.shutdown()


app = FastAPI(title="HARIA Dashboard API", version="0.2.0", lifespan=lifespan)

# The frontend is served by this app (same origin); CORS stays open for
# development setups that serve the UI elsewhere (e.g. Vite on :5173).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(topics.router)
app.include_router(recordings.router)
app.include_router(session.router)
app.include_router(folders.router)

app.mount("/static", StaticFiles(directory=FRONTEND_DIR / "static"), name="static")


@app.get("/", include_in_schema=False)
def serve_ui():
    return FileResponse(FRONTEND_DIR / "index.html")
