"""FastAPI application factory."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import __version__
from app.api.routers import alarms, auth, fleet, incidents, simulator, system, telemetry, ws
from app.api.schemas import ErrorBody, ErrorResponse
from app.config import Settings, get_settings
from app.container import Container
from app.errors import AppError
from app.logging import configure_logging, request_id_var

log = logging.getLogger("seatrace.http")

API_PREFIX = "/api/v1"


def _error(
    status: int,
    code: str,
    message: str,
    request: Request,
    details: list[dict[str, object]] | None = None,
) -> JSONResponse:
    body = ErrorResponse(
        error=ErrorBody(
            code=code, message=message, details=details, request_id=request_id_var.get()
        )
    )
    return JSONResponse(status_code=status, content=body.model_dump(exclude_none=True))


def create_app(settings: Settings | None = None, container: Container | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        c = container or Container(settings)
        app.state.container = c
        await c.start()
        try:
            yield
        finally:
            await c.stop()

    app = FastAPI(
        title="SeaTrace API",
        version=__version__,
        description=(
            "Maritime automation monitoring & incident replay — **simulated** vessels and telemetry. "
            "Independent portfolio project; not certified maritime software and not affiliated with or "
            "endorsed by NACOS Marine."
        ),
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        token = request_id_var.set(rid)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = rid
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        if not request.url.path.endswith("/health/live"):
            log.info(
                "request",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "request_id": rid,
                    "ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )
        return response

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        return _error(exc.status_code, exc.code, exc.message, request, exc.details)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {
                "loc": [str(p) for p in e.get("loc", ())],
                "message": e.get("msg", ""),
                "type": e.get("type", ""),
            }
            for e in exc.errors()
        ]
        return _error(422, "validation_error", "Request validation failed", request, details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {
            404: "not_found",
            405: "method_not_allowed",
            401: "unauthorized",
            403: "forbidden",
        }.get(exc.status_code, "http_error")
        return _error(exc.status_code, code, str(exc.detail), request)

    @app.exception_handler(OperationalError)
    @app.exception_handler(DBAPIError)
    @app.exception_handler(ConnectionError)
    async def _db(request: Request, exc: Exception) -> JSONResponse:
        log.error("database error", extra={"error": type(exc).__name__, "path": request.url.path})
        return _error(
            503, "database_unavailable", "The database is temporarily unavailable", request
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", extra={"path": request.url.path})
        return _error(500, "internal_error", "An internal error occurred", request)

    for router in (
        system.router,
        auth.router,
        fleet.router,
        telemetry.router,
        alarms.router,
        incidents.router,
        simulator.router,
        ws.router,
    ):
        app.include_router(router, prefix=API_PREFIX)
    return app


def app_factory() -> FastAPI:
    """Entry point for ``uvicorn app.main:app_factory --factory``."""
    return create_app()
