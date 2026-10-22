"""HTTP API surface. Handlers are thin; heavy work lives in app.pipeline / app.core.jobs."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from app import __version__
from app.config import settings
from app.core.jobs import job_store
from app.core.models import JobRequest, ParseReport, ParseRequest
from app.core.ratelimit import rate_limit_jobs, rate_limit_uploads
from app.pipeline.parse import parse_files
from app.pipeline.similarity import diamond_available

router = APIRouter()

# Copy uploads in bounded chunks so we can abort the moment the combined size
# crosses the cap, without buffering a whole file in memory.
_UPLOAD_CHUNK = 1024 * 1024

SUPPORTED_UPLOAD_SUFFIXES = (
    ".gbk",
    ".gb",
    ".genbank",
    ".gbf",
    ".gbff",
    ".gff",
    ".gff3",
    ".gtf",
    ".fa",
    ".fna",
    ".fasta",
    ".fas",
    ".faa",
)


class UploadTextRequest(BaseModel):
    text: str
    filename: str = "pasted_input.gbk"


@router.get("/health")
def health():
    return {
        "status": "ok",
        "version": __version__,
        "limits": {
            "max_clusters": settings.max_clusters,
            "max_total_genes": settings.max_total_genes,
            "max_sequence_length": settings.max_sequence_length,
            "max_concurrent_jobs": settings.max_concurrent_jobs,
            "max_upload_bytes": settings.max_upload_bytes,
        },
        # Which alignment engines this deployment can actually run. The client
        # hides engine options it can't use (DIAMOND needs the binary on PATH).
        "engines": ["parasail"] + (["diamond"] if diamond_available() else []),
        "default_engine": settings.default_engine,
    }


@router.get("/examples")
def examples():
    files = sorted(p.name for p in settings.example_dir.glob("*.gbk"))
    return {"name": "test_data", "dir": str(settings.example_dir), "files": files}


@router.post("/upload", dependencies=[Depends(rate_limit_uploads)])
async def upload(files: list[UploadFile] = File(default=[])):
    token = str(uuid.uuid4())
    dest = settings.scratch_dir / token
    dest.mkdir(parents=True, exist_ok=True)

    saved: list[str] = []
    total = 0
    for f in files:
        name = Path(f.filename or "").name
        if not name or Path(name).suffix.lower() not in SUPPORTED_UPLOAD_SUFFIXES:
            continue
        out_path = dest / name
        with out_path.open("wb") as out:
            while chunk := await f.read(_UPLOAD_CHUNK):
                total += len(chunk)
                if total > settings.max_upload_bytes:
                    shutil.rmtree(dest, ignore_errors=True)
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"Upload exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit."
                        ),
                    )
                out.write(chunk)
        saved.append(name)

    if not saved:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(
            status_code=400,
            detail="No supported input files found (GenBank or GFF3/GTF+FASTA)",
        )
    return {"upload_token": token, "files": saved}


@router.post("/upload-text", dependencies=[Depends(rate_limit_uploads)])
def upload_text(req: UploadTextRequest):
    if len(req.text.encode("utf-8")) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Pasted input exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB limit.",
        )
    token = str(uuid.uuid4())
    dest = settings.scratch_dir / token
    dest.mkdir(parents=True, exist_ok=True)
    name = Path(req.filename).name or "pasted_input.gbk"
    suffix = Path(name).suffix.lower()
    if suffix not in SUPPORTED_UPLOAD_SUFFIXES:
        raise HTTPException(status_code=400, detail="Unsupported pasted input filename extension")
    (dest / name).write_text(req.text)
    return {"upload_token": token, "files": [name]}


def _resolve_paths(req: JobRequest) -> list[str]:
    if req.example:
        paths = sorted(str(p) for p in settings.example_dir.glob("*.gbk"))
        if not paths:
            raise HTTPException(status_code=404, detail="No example data available")
        return paths
    if req.upload_token:
        folder = settings.scratch_dir / req.upload_token
        paths = sorted(str(p) for p in folder.glob("*")) if folder.exists() else []
        if not paths:
            raise HTTPException(status_code=404, detail=f"No files for upload_token {req.upload_token}")
        return paths
    raise HTTPException(status_code=400, detail="Provide 'example' or 'upload_token'")


@router.post("/jobs", dependencies=[Depends(rate_limit_jobs)])
def create_job(req: JobRequest):
    paths = _resolve_paths(req)
    job = job_store.create(req, paths)
    return {"job_id": job.id, "status": job.status.value}


@router.post("/parse")
def parse(req: ParseRequest):
    paths = _resolve_paths(JobRequest(upload_token=req.upload_token, example=req.example))
    warnings: list[str] = []
    errors: list[str] = []
    try:
        clusters = parse_files(paths, as_separate_clusters=req.as_separate_clusters)
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))
        clusters = []
    report = ParseReport(
        files=[Path(p).name for p in paths],
        warnings=warnings,
        errors=errors,
    )
    return {
        "clusters": [c.model_dump() for c in clusters],
        "report": report.model_dump(),
    }


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = job_store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job.public()


@router.delete("/jobs/{job_id}")
def cancel_job(job_id: str):
    if not job_store.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    return {"job_id": job_id, "status": "cancel_requested"}
