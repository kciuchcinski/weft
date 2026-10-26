# Weft — single-image build.
# Stage 1 builds the client. Stage 2 is a pixi/conda runtime that serves both the
# /api and the built client from one origin, and carries the DIAMOND binary from
# bioconda. DIAMOND matters here: free hosts give a fraction of a CPU, and the
# default parasail engine is exact O(N²) pairwise. The engine is gated at runtime (see
# /api/health), so the app still works anywhere the binary is absent.

# ---- Stage 1: build the frontend ----
# Runs on the *build* machine's native arch: its output is plain JS/CSS, so there's
# no reason to emulate it just because the runtime stage is amd64.
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: backend runtime (Python + DIAMOND + parasail, via pixi) ----
# Pinned to amd64: pixi.lock only solves for linux-64 (bioconda has no DIAMOND for
# linux-aarch64), and it's what Render runs. Without this pin, `docker build` on an
# ARM machine targets linux/arm64 and `pixi install --locked` fails. Building this
# stage on an ARM host is therefore emulated, and slow — that's expected.
FROM --platform=linux/amd64 debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PIXI_HOME=/opt/pixi
ENV PATH=/opt/pixi/bin:$PATH
RUN curl -fsSL https://pixi.sh/install.sh | bash

WORKDIR /app/backend

# Solve the env from the lock alone, before copying source, so edits under app/
# don't invalidate this (slow) layer. --locked fails loudly if pixi.lock has
# drifted from pixi.toml rather than silently re-solving.
COPY backend/pixi.toml backend/pixi.lock ./
RUN pixi install --locked && pixi clean cache --yes

COPY backend/app ./app
# Built client — config.py's STATIC_DIR default resolves to /app/frontend/dist.
COPY --from=frontend /frontend/dist /app/frontend/dist

# The PaaS injects PORT; default for local `docker run`.
ENV PORT=8000
# Uploads/temp go here — /tmp is writable on every host. Purged by the TTL sweeper.
ENV SCRATCH_DIR=/tmp/weft-scratch
EXPOSE 8000

# Single worker: the job store is in-process/in-memory (see core/jobs.py).
CMD ["/bin/sh", "-c", "pixi run --frozen uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
