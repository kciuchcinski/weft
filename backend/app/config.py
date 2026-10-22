"""Application settings and resource limits (SPEC §14).

Defaults suit local dev; every field can be overridden by an environment variable
so the same image is safe to run as an open, hosted beta (see ``render.yaml`` /
the Deploy section of the README). Beta caps are deliberately conservative because
the default engine, parasail, is exact O(N²) pairwise.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
REPO_ROOT = BACKEND_DIR.parent


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw) if raw else default


def _env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    return raw if raw else default


def _env_list(name: str, default: list[str]) -> list[str]:
    """Comma-separated env override (e.g. CORS_ORIGINS="https://a,https://b")."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:
    # Only relevant when the API and client are served from different origins.
    # The single-origin container build (FastAPI serves the built client) needs none.
    cors_origins: list[str] = field(
        default_factory=lambda: _env_list("CORS_ORIGINS", ["http://localhost:5173"])
    )

    repo_root: Path = REPO_ROOT
    scratch_dir: Path = field(default_factory=lambda: _env_path("SCRATCH_DIR", BACKEND_DIR / "scratch"))
    example_dir: Path = field(default_factory=lambda: _env_path("EXAMPLE_DIR", REPO_ROOT / "test_data"))
    # Directory holding the built frontend (dist). Empty/absent → API-only (dev).
    static_dir: Path = field(default_factory=lambda: _env_path("STATIC_DIR", REPO_ROOT / "frontend" / "dist"))

    # Resource guards. Conservative for an open beta on a small instance; raise
    # via env on a bigger box or with DEFAULT_ENGINE=diamond.
    max_clusters: int = field(default_factory=lambda: _env_int("MAX_CLUSTERS", 100))
    max_total_genes: int = field(default_factory=lambda: _env_int("MAX_TOTAL_GENES", 6_000))
    max_sequence_length: int = field(default_factory=lambda: _env_int("MAX_SEQUENCE_LENGTH", 20_000))
    max_concurrent_jobs: int = field(default_factory=lambda: _env_int("MAX_CONCURRENT_JOBS", 2))
    job_timeout_seconds: int = field(default_factory=lambda: _env_int("JOB_TIMEOUT_SECONDS", 300))

    # Reject an upload whose combined body exceeds this many bytes.
    max_upload_bytes: int = field(default_factory=lambda: _env_int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024))

    # Auto-delete per-upload scratch dirs older than this (privacy + disk). 0 disables.
    scratch_ttl_seconds: int = field(default_factory=lambda: _env_int("SCRATCH_TTL_SECONDS", 1_800))

    default_engine: str = field(default_factory=lambda: _env_str("DEFAULT_ENGINE", "parasail"))


settings = Settings()
