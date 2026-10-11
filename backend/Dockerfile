# syntax=docker/dockerfile:1
FROM python:3.13-slim AS build
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PIP_DISABLE_PIP_VERSION_CHECK=1
RUN pip install --no-cache-dir uv==0.13.0
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
# Dependencies first (cached layer), then the application
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./
RUN uv sync --frozen --no-dev

FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/app/.venv/bin:$PATH"
RUN groupadd --system --gid 10001 seatrace \
 && useradd --system --uid 10001 --gid seatrace --home-dir /app --shell /usr/sbin/nologin seatrace
WORKDIR /app
COPY --from=build --chown=seatrace:seatrace /app /app
USER seatrace
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/ready', timeout=3).status == 200 else 1)"
CMD ["uvicorn", "app.main:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--proxy-headers"]
