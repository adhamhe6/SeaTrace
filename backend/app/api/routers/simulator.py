from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.api.deps import ContainerDep, Operator, Viewer
from app.api.schemas import (
    ScenarioCommand,
    ScenarioInfo,
    ScenarioResult,
    SimulatorEventOut,
    SimulatorStatus,
)

router = APIRouter(prefix="/simulator", tags=["simulator"])


@router.get(
    "/status",
    response_model=SimulatorStatus,
    summary="Simulator / OPC UA connection and active scenarios",
)
async def status(container: ContainerDep, _user: Viewer) -> SimulatorStatus:
    return container.simulator.status()


@router.get("/scenarios", response_model=list[ScenarioInfo], summary="Available fault scenarios")
async def scenarios(container: ContainerDep, _user: Viewer) -> list[ScenarioInfo]:
    return container.simulator.scenarios()


@router.post(
    "/scenarios/{scenario_id}/activate",
    response_model=ScenarioResult,
    summary="Activate a fault scenario (operator only)",
)
async def activate(
    scenario_id: str, container: ContainerDep, user: Operator, body: ScenarioCommand | None = None
) -> ScenarioResult:
    body = body or ScenarioCommand()
    return await container.simulator.activate(
        scenario_id, body.vessel_code, body.duration_s, user.username
    )


@router.post(
    "/scenarios/{scenario_id}/clear",
    response_model=ScenarioResult,
    summary="Clear a fault scenario (operator only)",
)
async def clear(
    scenario_id: str, container: ContainerDep, user: Operator, body: ScenarioCommand | None = None
) -> ScenarioResult:
    body = body or ScenarioCommand()
    return await container.simulator.clear(scenario_id, body.vessel_code, user.username)


@router.post(
    "/reset", response_model=ScenarioResult, summary="Clear every active scenario (operator only)"
)
async def reset(container: ContainerDep, user: Operator) -> ScenarioResult:
    return await container.simulator.reset(user.username)


@router.get(
    "/events", response_model=list[SimulatorEventOut], summary="Audit trail of simulator commands"
)
async def events(
    container: ContainerDep, _user: Viewer, limit: Annotated[int, Query(ge=1, le=200)] = 50
) -> list[SimulatorEventOut]:
    return await container.simulator.events(limit)
