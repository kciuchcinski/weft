# Weft — single-image build (parasail-only, no conda).
# Stage 1 builds the client; stage 2 is a stock slim-python runtime that serves
# both the /api and the built client from one origin. DIAMOND is intentionally
# absent (see SPEC / README); the engine is gated at runtime.

# ---- Stage 1: build the frontend ----
FROM node:20-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: backend runtime ----
FROM python:3.11-slim
WORKDIR /app/backend

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY test_data /app/test_data
# Built client — config.py's STATIC_DIR default resolves to /app/frontend/dist.
COPY --from=frontend /frontend/dist /app/frontend/dist

# The PaaS injects PORT; default for local `docker run` (and HF Spaces app_port).
ENV PORT=8000
# Uploads/temp go here — /tmp is writable on every host (incl. HF Spaces, which
# may run the container as a non-root user). Auto-purged by the TTL sweeper.
ENV SCRATCH_DIR=/tmp/weft-scratch
EXPOSE 8000

# Single worker: the job store is in-process/in-memory (see core/jobs.py).
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 1
