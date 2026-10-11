from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import ContainerDep, Viewer
from app.api.schemas import (
    EquipmentDetail,
    FleetSummary,
    LatestReading,
    RecentEvent,
    VesselDetail,
    VesselSummary,
)

router = APIRouter(tags=["fleet"])


@router.get("/vessels", response_model=list[VesselSummary], summary="List vessels with status")
async def list_vessels(container: ContainerDep, _user: Viewer) -> list[VesselSummary]:
    return await container.fleet.vessels()


@router.get(
    "/vessels/{vessel_code}",
    response_model=VesselDetail,
    summary="Vessel with equipment, states and latest readings",
)
async def get_vessel(vessel_code: str, container: ContainerDep, _user: Viewer) -> VesselDetail:
    return await container.fleet.vessel(vessel_code)


@router.get(
    "/vessels/{vessel_code}/equipment/{equipment_code}",
    response_model=EquipmentDetail,
    summary="One equipment item with latest readings",
)
async def get_equipment(
    vessel_code: str, equipment_code: str, container: ContainerDep, _user: Viewer
) -> EquipmentDetail:
    return await container.fleet.equipment(vessel_code, equipment_code)


@router.get("/fleet/summary", response_model=FleetSummary, summary="Fleet-wide status summary")
async def fleet_summary(container: ContainerDep, _user: Viewer) -> FleetSummary:
    return await container.fleet.summary(len(container.supervisor.status.active_scenarios))


@router.get(
    "/events/recent",
    response_model=list[RecentEvent],
    summary="Recent alarm, scenario and connectivity events",
)
async def recent_events(
    container: ContainerDep, _user: Viewer, limit: Annotated[int, Query(ge=1, le=200)] = 30
) -> list[RecentEvent]:
    return await container.fleet.recent_events(limit)


@router.get(
    "/telemetry/latest",
    response_model=list[LatestReading],
    summary="Latest reading of every sensor (optionally filtered)",
)
async def latest(
    container: ContainerDep, _user: Viewer, vessel: str | None = None, equipment: str | None = None
) -> list[LatestReading]:
    if vessel and vessel not in container.catalog.vessels:
        from app.errors import not_found

        raise not_found("Vessel", vessel)
    return container.fleet.latest(vessel, equipment)
