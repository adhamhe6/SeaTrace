from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import ContainerDep, Viewer
from app.api.schemas import HistoryResponse

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


@router.get(
    "/history",
    response_model=HistoryResponse,
    response_model_by_alias=True,
    summary="Stored telemetry for one equipment item and time range",
)
async def history(
    container: ContainerDep,
    _user: Viewer,
    vessel: Annotated[str, Query(description="Vessel code, e.g. VES-001")],
    equipment: Annotated[str, Query(description="Equipment code, e.g. ME1")],
    time_from: Annotated[
        datetime, Query(alias="from", description="Inclusive start (ISO-8601 with offset)")
    ],
    time_to: Annotated[
        datetime, Query(alias="to", description="Inclusive end (ISO-8601 with offset)")
    ],
    measurement: Annotated[
        list[str] | None, Query(description="Repeat to select several; default all")
    ] = None,
    limit: Annotated[int, Query(ge=1, le=20000)] = 5000,
    cursor: Annotated[str | None, Query(description="next_cursor of the previous page")] = None,
    bucket_s: Annotated[
        int | None, Query(ge=1, le=86400, description="Aggregate into buckets of N s")
    ] = None,
) -> HistoryResponse:
    return await container.telemetry.history(
        vessel=vessel,
        equipment=equipment,
        measurements=measurement,
        time_from=time_from,
        time_to=time_to,
        limit=limit,
        cursor=cursor,
        bucket_s=bucket_s,
    )
