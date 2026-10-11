from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import select

from app.api.deps import ContainerDep, Operator, Viewer
from app.api.schemas import AcknowledgeRequest, AlarmDetail, AlarmList, AlarmRuleOut
from app.db import models as m
from app.domain.alarms import AlarmStateError
from app.domain.enums import AlarmKind, AlarmState, Severity
from app.errors import AppError, not_found
from app.services.alarm_service import AlarmNotFoundError
from app.services.telemetry_service import validate_range

router = APIRouter(tags=["alarms"])


@router.get("/alarms", response_model=AlarmList, summary="List alarms (active and historical)")
async def list_alarms(
    container: ContainerDep,
    _user: Viewer,
    state: Annotated[
        list[AlarmState] | None, Query(description="Repeatable lifecycle-state filter")
    ] = None,
    open: Annotated[
        bool | None, Query(description="true = not closed; false = closed (cleared & acknowledged)")
    ] = None,
    severity: Annotated[list[Severity] | None, Query()] = None,
    vessel: str | None = None,
    equipment: str | None = None,
    kind: AlarmKind | None = None,
    time_from: Annotated[
        datetime | None, Query(alias="from", description="raised_at >= from")
    ] = None,
    time_to: Annotated[datetime | None, Query(alias="to", description="raised_at <= to")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AlarmList:
    if vessel and vessel not in container.catalog.vessels:
        raise not_found("Vessel", vessel)
    if time_from and time_to:
        time_from, time_to = validate_range(time_from, time_to)
    elif (time_from and time_from.tzinfo is None) or (time_to and time_to.tzinfo is None):
        raise AppError(422, "naive_datetime", "from/to must include a UTC offset")
    return await container.alarms.list_alarms(
        states=state,
        open_=open,
        severities=severity,
        vessel=vessel,
        equipment=equipment,
        kind=kind,
        time_from=time_from,
        time_to=time_to,
        limit=limit,
        offset=offset,
    )


@router.get(
    "/alarms/{alarm_id}",
    response_model=AlarmDetail,
    summary="Alarm details with transition history",
)
async def get_alarm(alarm_id: int, container: ContainerDep, _user: Viewer) -> AlarmDetail:
    try:
        return await container.alarms.get_detail(alarm_id)
    except AlarmNotFoundError as exc:
        raise not_found("Alarm", alarm_id) from exc


@router.post(
    "/alarms/{alarm_id}/acknowledge",
    response_model=AlarmDetail,
    summary="Acknowledge an alarm (operator only)",
)
async def acknowledge(
    alarm_id: int, container: ContainerDep, user: Operator, body: AcknowledgeRequest | None = None
) -> AlarmDetail:
    try:
        return await container.alarms.acknowledge(
            alarm_id, user.user_id, user.username, body.note if body else None
        )
    except AlarmNotFoundError as exc:
        raise not_found("Alarm", alarm_id) from exc
    except AlarmStateError as exc:
        raise AppError(409, exc.code, exc.message) from exc


@router.get(
    "/alarm-rules", response_model=list[AlarmRuleOut], summary="Configured alarm rules (read-only)"
)
async def alarm_rules(container: ContainerDep, _user: Viewer) -> list[AlarmRuleOut]:
    async with container.sessionmaker() as session:
        rows = (await session.scalars(select(m.AlarmRule).order_by(m.AlarmRule.id))).all()
    return [AlarmRuleOut.model_validate(r) for r in rows]
