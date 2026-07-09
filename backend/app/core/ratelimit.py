"""Lightweight in-memory rate limiting (SPEC §14 / §15 abuse guards).

The hosted beta runs a single uvicorn worker (the job store is in-process), so a
per-process sliding window is sufficient and needs no Redis. Keyed on the client
IP, honouring ``X-Forwarded-For`` since the app sits behind the PaaS proxy.
"""

from __future__ import annotations

import time
from collections import deque
from threading import Lock

from fastapi import HTTPException, Request


class SlidingWindowLimiter:
    def __init__(self, max_events: int, window_seconds: float) -> None:
        self.max = max_events
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = Lock()

    def check(self, key: str) -> None:
        now = time.time()
        with self._lock:
            dq = self._hits.setdefault(key, deque())
            while dq and now - dq[0] > self.window:
                dq.popleft()
            if len(dq) >= self.max:
                retry = int(self.window - (now - dq[0])) + 1
                raise HTTPException(
                    status_code=429,
                    detail=f"Rate limit exceeded. Retry in {retry}s.",
                    headers={"Retry-After": str(retry)},
                )
            dq.append(now)


def client_key(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Uploads are cheap but bound disk churn; jobs launch the expensive alignment.
_upload_limiter = SlidingWindowLimiter(max_events=30, window_seconds=60)
_job_limiter = SlidingWindowLimiter(max_events=10, window_seconds=60)


def rate_limit_uploads(request: Request) -> None:
    _upload_limiter.check(client_key(request))


def rate_limit_jobs(request: Request) -> None:
    _job_limiter.check(client_key(request))
