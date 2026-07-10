# Weft

Browser-based **gene cluster comparison figures**. A new, standalone app (not a fork of clinker):
a FastAPI backend does parsing + alignment; a canvas-first React client renders and refines the figure.

See **[SPEC.md](SPEC.md)** for the full functional specification and MVP build order.

## Status

Working end to end on real data. The **backend pipeline** (GenBank/GFF parse → DIAMOND **or**
parasail all-vs-all → homology grouping → synteny ordering → figure JSON) is implemented and
exposed as an async job API. The **canvas renderer and full control panel are built** — upload,
metric selection + live thresholds, colour system, arrangement, styling, and SVG/PNG/CSV export,
with session save/load and localStorage autosave.

**Alignment engines.** DIAMOND is fast; parasail is an exact O(N²) pairwise aligner and is
therefore CPU-bound. **Both ship in the image** (DIAMOND from bioconda via pixi) and DIAMOND is
the default — it's what makes a fraction-of-a-CPU free host usable. The engine is **gated at
runtime**: `/api/health` advertises what this deployment can actually run, and the client hides,
and falls back from, any engine whose binary is absent. A parasail-only build therefore still
works with no code change.

## Layout

```
backend/    FastAPI app (parse → similarity → grouping → ordering → figure JSON)
frontend/   React + TypeScript + Vite, canvas-first UI
SPEC.md     Functional specification
```

## Run (dev)

Backend (managed with [pixi](https://pixi.sh) — contains Python deps **and** the DIAMOND binary):

```bash
cd backend
pixi install                 # solves a project-local env incl. DIAMOND (from bioconda)
pixi run dev                 # http://localhost:8000  (interactive docs at /docs)
pixi run example             # run the pipeline on ../test_data → sample_data.json
```

> DIAMOND is pulled from bioconda **into the pixi env** — no system install required. `pixi run example`
> also writes `frontend/public/sample_data.json` for the renderer to consume.

Frontend:

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173  (proxies /api to the backend)
```

## Deploy (hosted beta)

The whole app ships as **one Docker image**: stage 1 builds the client, stage 2 is a pixi/conda
runtime (carrying the DIAMOND binary) that serves both `/api` and the built client from a single
origin — so there's no CORS to configure.

```bash
docker build -t weft .
docker run -p 8000:8000 weft          # → http://localhost:8000
```

**Render's free plan** is the recommended zero-cost host: no credit card, Docker supported.
[`render.yaml`](render.yaml) declares the web service and its `/api/health` check — push the
repo, point Render at the blueprint, and it builds and serves on HTTPS. Fly.io works
equivalently from the same Dockerfile.

Free-plan realities worth knowing: roughly **0.1 CPU / 512 MB**, spin-down after 15 minutes idle
(~1 min cold start), and 750 instance-hours a month. Alignment is CPU-bound, which is why
DIAMOND ships and `MAX_CONCURRENT_JOBS` is 1. WebSockets aren't available on free — fine, the
client polls `/api/jobs/{id}`. The job store is in-process, so in-flight jobs don't survive a
spin-down; acceptable for a beta.

> Hugging Face Spaces was the original target, but HF moved the **Docker SDK to paid** in 2026,
> so its free tier no longer fits a FastAPI + React app.

**Configuration** is entirely via environment variables (defaults in
[`backend/app/config.py`](backend/app/config.py)). For an **open public beta** the important
guards are:

| Env var | Default | Purpose |
|---|---|---|
| `MAX_TOTAL_GENES` | `6000` | Reject oversized inputs before alignment runs |
| `MAX_CLUSTERS` | `100` | Cap input clusters |
| `MAX_SEQUENCE_LENGTH` | `20000` | Cap per-protein length |
| `MAX_CONCURRENT_JOBS` | `2` | Bound parallel alignment jobs |
| `JOB_TIMEOUT_SECONDS` | `300` | Fail a job that runs too long |
| `MAX_UPLOAD_BYTES` | `52428800` | Reject uploads over 50 MB |
| `SCRATCH_TTL_SECONDS` | `1800` | Auto-delete uploaded files after N seconds |

Because the job store is in-process, run **one uvicorn worker** (the image already does);
`MAX_CONCURRENT_JOBS` handles parallelism within it. Jobs are lost on restart — acceptable for a
beta. Uploaded sequences are auto-deleted on the `SCRATCH_TTL_SECONDS` schedule.

[`backend/requirements.txt`](backend/requirements.txt) is a pip-only mirror of the conda deps
**minus DIAMOND**; CI uses it to run the tests without conda (the DIAMOND tests self-skip when
the binary is absent).
