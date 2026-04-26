# syntax=docker/dockerfile:1.7

# ---------- Stage 1: build frontend ----------
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: backend runtime ----------
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    DATA_DIR=/data \
    RULESETS_DIR=/app/rulesets \
    STATIC_DIR=/app/frontend/dist

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for cache.
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
      "fastapi>=0.115" "uvicorn[standard]>=0.32" "duckdb>=1.1" \
      "httpx>=0.27" "apscheduler>=3.10" "pyyaml>=6.0" "pydantic>=2.9" \
      "beautifulsoup4>=4.12" "lxml>=5.3"

COPY backend/ ./backend/
COPY rulesets/ ./rulesets/
COPY --from=frontend /app/frontend/dist ./frontend/dist

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT}"]
