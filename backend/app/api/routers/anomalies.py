from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import ContainerDep, Viewer
from app.api.schemas import AnomalyAssessment

router = APIRouter(prefix="/anomalies", tags=["anomaly-detection (experimental)"])


@router.get(
    "",
    response_model=list[AnomalyAssessment],
    summary="Experimental combined vibration/temperature drift assessment per vessel",
)
async def list_assessments(container: ContainerDep, _user: Viewer) -> list[AnomalyAssessment]:
    return [await container.anomalies.assess_vessel(v) for v in container.anomalies.vessels()]


@router.get("/{vessel_code}", response_model=AnomalyAssessment, summary="Assessment for one vessel")
async def get_assessment(
    vessel_code: str, container: ContainerDep, _user: Viewer
) -> AnomalyAssessment:
    return await container.anomalies.assess_vessel(vessel_code)
