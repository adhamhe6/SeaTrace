from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import ContainerDep, Viewer
from app.api.schemas import IncidentWindow
from app.errors import not_found
from app.services.alarm_service import AlarmNotFoundError

router = APIRouter(prefix="/incidents", tags=["incidents"])


@router.get(
    "/window",
    response_model=IncidentWindow,
    response_model_by_alias=True,
    summary="Stored telemetry, states and alarm events for a time window",
)
async def window(
    container: ContainerDep,
    _user: Viewer,
    vessel: str,
    equipment: str,
    time_from: Annotated[datetime, Query(alias="from")],
    time_to: Annotated[datetime, Query(alias="to")],
    measurement: Annotated[list[str] | None, Query()] = None,
) -> IncidentWindow:
    return await container.incidents.window(
        vessel=vessel,
        equipment=equipment,
        measurements=measurement,
        time_from=time_from,
        time_to=time_to,
    )


@router.get(
    "/alarm/{alarm_id}",
    response_model=IncidentWindow,
    response_model_by_alias=True,
    summary="Incident window centred on an alarm",
)
async def for_alarm(
    alarm_id: int,
    container: ContainerDep,
    _user: Viewer,
    before_s: Annotated[int, Query(ge=0, le=3600)] = 300,
    after_s: Annotated[int, Query(ge=0, le=3600)] = 300,
) -> IncidentWindow:
    try:
        return await container.incidents.for_alarm(alarm_id, before_s, after_s)
    except AlarmNotFoundError as exc:
        raise not_found("Alarm", alarm_id) from exc
