"""Async job store. Runs the pipeline on an in-process thread pool; a multi-worker
deployment would need an external queue (e.g. RQ/Celery + Redis).
"""

from __future__ import annotations

import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from app.config import settings
from app.core.models import FigureData, JobRequest
from app.pipeline.run import run_pipeline


class JobState(str, Enum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


@dataclass
class Job:
    id: str
    request: JobRequest
    paths: list[str]
    status: JobState = JobState.queued
    progress: float = 0.0
    message: str = ""
    result: Optional[FigureData] = None
    error: Optional[str] = None
    created: float = field(default_factory=time.time)
    cancel_requested: bool = False

    def public(self) -> dict:
        return {
            "job_id": self.id,
            "status": self.status.value,
            "progress": self.progress,
            "message": self.message,
            "result": self.result.model_dump() if self.result else None,
            "error": self.error,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._pool = ThreadPoolExecutor(max_workers=settings.max_concurrent_jobs)

    def create(self, request: JobRequest, paths: list[str]) -> Job:
        job = Job(id=str(uuid.uuid4()), request=request, paths=list(paths))
        self._jobs[job.id] = job
        self._pool.submit(self._run, job)
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.status in (JobState.succeeded, JobState.failed, JobState.cancelled):
            return True
        job.cancel_requested = True
        if job.status == JobState.queued:
            job.status = JobState.cancelled
            job.message = "cancelled"
        return True

    def _run(self, job: Job) -> None:
        if job.cancel_requested:
            job.status = JobState.cancelled
            job.message = "cancelled"
            return
        job.status = JobState.running
        deadline = (
            time.time() + settings.job_timeout_seconds
            if settings.job_timeout_seconds > 0
            else None
        )
        try:
            def progress(fraction: float, message: str) -> None:
                # Cooperative cancel + timeout: the pipeline calls this frequently
                # during the expensive alignment loop, so raising here stops it
                # promptly without needing to kill the worker thread.
                if job.cancel_requested:
                    raise RuntimeError("job cancelled")
                if deadline is not None and time.time() > deadline:
                    raise TimeoutError(
                        f"Job exceeded the {settings.job_timeout_seconds}s time limit. "
                        "Try a smaller input, a higher identity cutoff, or fewer clusters."
                    )
                job.progress = fraction
                job.message = message

            job.result = run_pipeline(
                job.paths,
                engine=job.request.engine,
                mode=job.request.mode,
                identity_cutoff=job.request.identity_cutoff,
                evalue_cutoff=job.request.evalue_cutoff,
                progress=progress,
            )
            if job.cancel_requested:
                job.status = JobState.cancelled
                job.message = "cancelled"
                return
            job.status = JobState.succeeded
        except Exception as exc:  # noqa: BLE001 — surface any failure to the client
            if job.cancel_requested:
                job.status = JobState.cancelled
                job.message = "cancelled"
                job.error = None
                return
            job.status = JobState.failed
            job.message = "failed"
            job.error = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()


job_store = JobStore()
