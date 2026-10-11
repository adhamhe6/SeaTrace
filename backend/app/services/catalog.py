"""In-memory catalogue of vessels/equipment/sensors/rules and the live (latest-value) state.

The catalogue is loaded once from PostgreSQL after seeding. It lets hot paths (ingestion, WebSocket
payloads) resolve names and IDs without queries. ``LiveState`` holds the newest reading per sensor and is
rebuilt from the database on start-up so a backend restart does not lose "latest" values.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import models as m
from app.domain.alarms import RuleSpec
from app.domain.enums import AlarmKind, Comparison, EquipmentType, Quality, Severity


@dataclass(frozen=True, slots=True)
class SensorInfo:
    id: int
    equipment_id: int
    key: str
    name: str
    unit: str
    plausible_min: float
    plausible_max: float
    nominal_min: float | None
    nominal_max: float | None
    flatline_check: bool


@dataclass(slots=True)
class EquipmentInfo:
    id: int
    vessel_id: int
    vessel_code: str
    code: str
    name: str
    type: EquipmentType
    sensors: dict[str, SensorInfo] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class VesselInfo:
    id: int
    code: str
    name: str
    vessel_type: str


class Catalog:
    def __init__(self) -> None:
        self.vessels: dict[str, VesselInfo] = {}
        self.equipment_by_id: dict[int, EquipmentInfo] = {}
        self.equipment_by_code: dict[tuple[str, str], EquipmentInfo] = {}
        self.sensor_by_id: dict[int, SensorInfo] = {}
        self.rules: dict[int, RuleSpec] = {}

    def vessel_name(self, code: str) -> str:
        return self.vessels[code].name

    def equipment_of_vessel(self, vessel_code: str) -> list[EquipmentInfo]:
        return [e for e in self.equipment_by_id.values() if e.vessel_code == vessel_code]

    @classmethod
    async def load(cls, session: AsyncSession) -> Catalog:
        cat = cls()
        vessels = (await session.scalars(select(m.Vessel).order_by(m.Vessel.id))).all()
        by_vid: dict[int, VesselInfo] = {}
        for v in vessels:
            info = VesselInfo(v.id, v.code, v.name, v.vessel_type)
            cat.vessels[v.code] = info
            by_vid[v.id] = info
        for e in (await session.scalars(select(m.Equipment).order_by(m.Equipment.id))).all():
            ei = EquipmentInfo(
                e.id,
                e.vessel_id,
                by_vid[e.vessel_id].code,
                e.code,
                e.name,
                EquipmentType(e.equipment_type),
            )
            cat.equipment_by_id[e.id] = ei
            cat.equipment_by_code[(ei.vessel_code, ei.code)] = ei
        for s in (await session.scalars(select(m.Sensor).order_by(m.Sensor.id))).all():
            si = SensorInfo(
                s.id,
                s.equipment_id,
                s.key,
                s.name,
                s.unit,
                s.plausible_min,
                s.plausible_max,
                s.nominal_min,
                s.nominal_max,
                s.flatline_check,
            )
            cat.equipment_by_id[s.equipment_id].sensors[s.key] = si
            cat.sensor_by_id[s.id] = si
        for r in (await session.scalars(select(m.AlarmRule).order_by(m.AlarmRule.id))).all():
            cat.rules[r.id] = rule_spec(r)
        return cat


def rule_spec(r: m.AlarmRule) -> RuleSpec:
    return RuleSpec(
        id=r.id,
        code=r.code,
        name=r.name,
        kind=AlarmKind(r.kind),
        comparison=Comparison(r.comparison),
        severity=Severity(r.severity),
        equipment_type=EquipmentType(r.equipment_type) if r.equipment_type else None,
        measurement_key=r.measurement_key,
        threshold=r.threshold,
        clear_threshold=r.clear_threshold,
        activate_after_s=r.activate_after_s,
        clear_after_s=r.clear_after_s,
        enabled=r.enabled,
    )


@dataclass(slots=True)
class Reading:
    sensor_id: int
    value: float | None
    quality: Quality
    source_ts: datetime
    ingested_ts: datetime


@dataclass(slots=True)
class EquipmentLive:
    state: str | None = None
    state_ts: datetime | None = None
    sensor_health: str | None = None
    last_fresh: datetime | None = None  # backend wall clock of last fresh telemetry


class LiveState:
    def __init__(self) -> None:
        self.readings: dict[int, Reading] = {}
        self.equipment: dict[int, EquipmentLive] = {}

    def equipment_live(self, equipment_id: int) -> EquipmentLive:
        return self.equipment.setdefault(equipment_id, EquipmentLive())

    async def load(self, session: AsyncSession, catalog: Catalog) -> None:
        rows = await session.execute(
            text(
                """
            SELECT t.sensor_id, t.value, t.quality, t.source_ts, t.ingested_ts
            FROM sensors s
            CROSS JOIN LATERAL (
                SELECT sensor_id, value, quality, source_ts, ingested_ts FROM telemetry
                WHERE sensor_id = s.id ORDER BY source_ts DESC LIMIT 1
            ) t
            """
            )
        )
        for sid, value, quality, src, ing in rows:
            self.readings[sid] = Reading(sid, value, Quality(quality), src, ing)
        for eq in (await session.scalars(select(m.Equipment))).all():
            live = self.equipment_live(eq.id)
            live.state, live.state_ts = eq.current_state, eq.state_since
