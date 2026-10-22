"""Scratch TTL cleanup for uploaded data.

Per-upload scratch dirs hold user-submitted sequences. On a hosted beta they must
not accumulate — both to bound disk and so unpublished data doesn't linger. A
daemon thread sweeps dirs older than ``scratch_ttl_seconds`` and also runs once at
boot to clear anything left by a previous process.
"""

from __future__ import annotations

import shutil
import threading
import time

from app.config import settings


def sweep_once() -> int:
    """Delete scratch subdirs whose mtime is older than the TTL. Returns count removed."""
    root = settings.scratch_dir
    ttl = settings.scratch_ttl_seconds
    if ttl <= 0 or not root.exists():
        return 0
    cutoff = time.time() - ttl
    removed = 0
    for child in root.iterdir():
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
        except OSError:
            pass
    return removed


def _loop(interval: float) -> None:
    while True:
        time.sleep(interval)
        sweep_once()


_started = False


def start_scratch_sweeper() -> None:
    """Ensure the scratch dir exists, clear stale dirs, and start the sweeper thread."""
    global _started
    settings.scratch_dir.mkdir(parents=True, exist_ok=True)
    if _started or settings.scratch_ttl_seconds <= 0:
        return
    _started = True
    sweep_once()  # clear anything left over from a previous run
    interval = min(max(settings.scratch_ttl_seconds / 2, 60), 600)
    threading.Thread(target=_loop, args=(interval,), daemon=True).start()
