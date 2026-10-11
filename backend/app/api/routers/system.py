from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app import __version__
from app.api.deps import ContainerDep, Viewer
from app.api.schemas import HealthResponse, SystemStatus
from app.services.simulator_service import NOTICE

router = APIRouter(tags=["system"])


@router.get("/health/live", response_model=HealthResponse, summary="Liveness probe")
async def live() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get(
    "/health/ready",
    response_model=HealthResponse,
    summary="Readiness probe",
    responses={503: {"model": HealthResponse}},
)
async def ready(container: ContainerDep) -> HealthResponse | JSONResponse:
    db_ok = await container.database_ok()
    started = getattr(container, "ingestion", None) is not None
    checks = {
        "database": "ok" if db_ok else "unavailable",
        "application": "ok" if started else "starting",
        # OPC UA being down degrades data freshness but must not make the API unready.
        "opcua": container.opcua_status().state if started else "starting",
    }
    if db_ok and started:
        return HealthResponse(status="ready", checks=checks)
    return JSONResponse(
        status_code=503, content=HealthResponse(status="not_ready", checks=checks).model_dump()
    )


@router.get(
    "/system/status", response_model=SystemStatus, summary="System and source-connectivity status"
)
async def system_status(container: ContainerDep, _user: Viewer) -> SystemStatus:
    return SystemStatus(
        version=__version__,
        environment=container.settings.env,
        server_time=datetime.now(UTC),
        disclaimer=NOTICE,
        database="ok" if await container.database_ok() else "unavailable",
        opcua=container.opcua_status(),
        ingestion=container.ingestion.snapshot_stats(),
        websocket_clients=container.hub.client_count,
        stale_after_s=container.settings.stale_after_s,
    )
