"""Weft API entry point.

Serves the JSON API under ``/api`` and, when a built frontend is present
(``STATIC_DIR``), the single-page client from the same origin — so the whole app
ships as one container with no CORS to configure.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.config import settings
from app.api.routes import router
from app.core.cleanup import start_scratch_sweeper


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scratch_sweeper()
    yield


app = FastAPI(title="Weft API", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")

# Serve the built client from the same origin when present. Mounted last so the
# /api routes (and /docs) take precedence. The app has no client-side routing,
# so StaticFiles(html=True) — index at "/", assets + bundled JSON by path — is
# all that's needed.
_static = settings.static_dir
if _static.is_dir() and (_static / "index.html").exists():
    app.mount("/", StaticFiles(directory=str(_static), html=True), name="static")
else:
    @app.get("/")
    def root():
        return {"name": "Weft API", "version": __version__, "docs": "/docs"}
