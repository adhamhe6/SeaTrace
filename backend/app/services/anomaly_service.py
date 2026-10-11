"""Runs the explainable anomaly assessment on stored main-engine telemetry."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.schemas import AnomalyAssessment
from app.db import models as m
from app.domain.anomaly import AnomalyConfig, Sample, assess
from app.domain.enums import AlarmState, EquipmentType, Quality
from app.errors import not_found
from app.services.catalog import Catalog, LiveState

DISCLAIMER = (
    "Experimental statistical heuristic on simulated data. It is not a validated predictor of real "
    "equipment failure and must not be used for operational decisions."
)
_RELEVANT_STATES = {"RUNNING", "DEGRADED"}


class AnomalyService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        catalog: Catalog,
        live: LiveState,
        cfg: AnomalyConfig | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._catalog = catalog
        self._live = live
        self._cfg = cfg or AnomalyConfig()

    def vessels(self) -> list[str]:
        return list(self._catalog.vessels)

    async def assess_vessel(self, vessel: str) -> AnomalyAssessment:
        eq = next(
            (
                e
                for e in self._catalog.equipment_of_vessel(vessel)
                if e.type is EquipmentType.MAIN_ENGINE
            ),
            None,
        )
        if eq is None:
            raise not_found("Main engine of vessel", vessel)
        now = datetime.now(UTC)
        state = self._live.equipment.get(eq.id)
        vib, temp = eq.sensors["vibration"], eq.sensors["temperature"]
        if state is not None and state.state is not None and state.state not in _RELEVANT_STATES:
            return AnomalyAssessment(
                vessel_code=vessel,
                equipment_code=eq.code,
                status="not_applicable",
                score=0.0,
                explanation=f"Engine state is {state.state}; assessment applies to a running engine only.",
                features={},
                alarm_active=False,
                evaluated_at=now,
                disclaimer=DISCLAIMER,
            )
        since = now - timedelta(seconds=self._cfg.reference_s + self._cfg.recent_s + 15)
        usable = [Quality.GOOD.value, Quality.UNCERTAIN.value]
        async with self._sessionmaker() as session:
            rows = (
                await session.execute(
                    select(m.Telemetry.sensor_id, m.Telemetry.source_ts, m.Telemetry.value)
                    .where(
                        m.Telemetry.equipment_id == eq.id,
                        m.Telemetry.sensor_id.in_([vib.id, temp.id]),
                        m.Telemetry.source_ts >= since,
                        m.Telemetry.quality.in_(usable),
                        m.Telemetry.value.is_not(None),
                    )
                    .order_by(m.Telemetry.source_ts)
                )
            ).all()
            alarm_active = bool(
                await session.scalar(
                    select(m.Alarm.id)
                    .where(
                        m.Alarm.equipment_id == eq.id,
                        m.Alarm.kind == "condition",
                        m.Alarm.state.in_(
                            [AlarmState.ACTIVE_UNACK.value, AlarmState.ACTIVE_ACK.value]
                        ),
                        m.Alarm.sensor_id.in_([vib.id, temp.id]),
                    )
                    .limit(1)
                )
            )
        vib_s = [Sample(r[1], float(r[2])) for r in rows if r[0] == vib.id and r[2] is not None]
        temp_s = [Sample(r[1], float(r[2])) for r in rows if r[0] == temp.id and r[2] is not None]
        result = assess(vib_s, temp_s, now, self._cfg)
        return AnomalyAssessment(
            vessel_code=vessel,
            equipment_code=eq.code,
            status=result.status,
            score=result.score,
            explanation=result.explanation,
            features=result.features,
            alarm_active=alarm_active,
            evaluated_at=now,
            disclaimer=DISCLAIMER,
        )
