---
title: Weft
emoji: 🧬
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 8000
pinned: false
short_description: Publication-quality gene cluster comparison figures
---

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

**Alignment engines.** DIAMOND is fast but ships as a bioconda binary (via pixi); parasail is an
exact O(N²) pairwise aligner that installs as a plain pip wheel. The **hosted image ships
parasail only** so it can build on a stock `python:slim` base with no conda. The DIAMOND code
path is retained and lights up automatically wherever the `diamond` binary is on `PATH` (local
pixi dev, or a future conda-based image) — the API advertises available engines at
`/api/health` and the client hides options it can't run.

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

The whole app ships as **one Docker image** (parasail-only): stage 1 builds the client, stage 2
is a stock `python:3.11-slim` runtime that serves both `/api` and the built client from a single
origin — so there's no CORS to configure.

```bash
docker build -t weft .
docker run -p 8000:8000 weft          # → http://localhost:8000
```

**Hugging Face Spaces** (free, no card) is the recommended zero-cost host: the YAML
frontmatter at the top of this README configures a Docker Space (`sdk: docker`,
`app_port: 8000`). Create a Space, add it as a git remote, and `git push` — HF builds the
Dockerfile and serves it. The container writes only to `/tmp` (`SCRATCH_DIR`), so it runs
fine under the Space's sandbox. Note: free Spaces sleep after inactivity, and the in-memory
job store means running jobs don't survive a sleep/restart — fine for a beta.

Alternatively, on a managed PaaS [`render.yaml`](render.yaml) defines a Docker web service
with a `/api/health` check (Fly.io works equivalently). Push the repo, point the platform at
the blueprint, and it builds + serves on HTTPS.

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

To re-enable DIAMOND later, build on a conda/pixi base with the `diamond` binary and add
`linux-64` to `platforms` in [`backend/pixi.toml`](backend/pixi.toml) — no application-code
change is needed.
