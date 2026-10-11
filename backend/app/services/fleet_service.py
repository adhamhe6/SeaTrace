"""Read models for the fleet overview, vessel and equipment pages."""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.schemas import (
    AlarmCounts,
    EquipmentDetail,
    EquipmentSummary,
    FleetSummary,
    LatestReading,
    RecentEvent,
    VesselDetail,
    VesselSummary,
)
from app.config import Settings
from app.db import models as m
from app.domain.enums import AlarmState, Communication, Health, Quality, Severity
from app.errors import not_found
from app.opcua.client import OpcUaSupervisor
from app.services.alarm_service import AlarmService
from app.services.catalog import Catalog, EquipmentInfo, LiveState

log = logging.getLogger(__name__)

_ACTIVE = (AlarmState.ACTIVE_UNACK.value, AlarmState.ACTIVE_ACK.value)
_HEALTH_RANK = {Health.NORMAL: 0, Health.WARNING: 1, Health.CRITICAL: 2, Health.OFFLINE: 3}


class FleetService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        catalog: Catalog,
        live: LiveState,
        alarms: AlarmService,
        supervisor: OpcUaSupervisor,
        settings: Settings,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._catalog = catalog
        self._live = live
        self._alarms = alarms
        self._sup = supervisor
        self._s = settings

    # ------------------------------------------------------------------ readings
    def reading(self, eq: EquipmentInfo, key: str, now: datetime) -> LatestReading:
        s = eq.sensors[key]
        r = self._live.readings.get(s.id)
        if r is None:
            return LatestReading(
                sensor_id=s.id,
                vessel_code=eq.vessel_code,
                equipment_code=eq.code,
                measurement=key,
                name=s.name,
                unit=s.unit,
                value=None,
                quality=Quality.STALE,
                source_ts=None,
                ingested_ts=None,
                age_s=None,
                stale=True,
                nominal_min=s.nominal_min,
                nominal_max=s.nominal_max,
            )
        age = max(0.0, (now - r.ingested_ts).total_seconds())
        stale = age > self._s.stale_after_s
        return LatestReading(
            sensor_id=s.id,
            vessel_code=eq.vessel_code,
            equipment_code=eq.code,
            measurement=key,
            name=s.name,
            unit=s.unit,
            value=r.value,
            quality=Quality.STALE if stale else r.quality,
            source_ts=r.source_ts,
            ingested_ts=r.ingested_ts,
            age_s=round(age, 1),
            stale=stale,
            nominal_min=s.nominal_min,
            nominal_max=s.nominal_max,
        )

    def latest(self, vessel: str | None, equipment: str | None) -> list[LatestReading]:
        now = datetime.now(UTC)
        out: list[LatestReading] = []
        for eq in self._catalog.equipment_by_id.values():
            if vessel and eq.vessel_code != vessel:
                continue
            if equipment and eq.code != equipment:
                continue
            out += [self.reading(eq, k, now) for k in eq.sensors]
        return out

    def _last_data(self, eq: EquipmentInfo) -> datetime | None:
        times = [
            self._live.readings[s.id].ingested_ts
            for s in eq.sensors.values()
            if s.id in self._live.readings
        ]
        return max(times) if times else None

    # ------------------------------------------------------------------ alarm aggregation
    async def _alarm_rows(self) -> tuple[dict[int, list[tuple[str, str]]], AlarmCounts]:
        rows = await self._alarms.open_counts()
        per_eq: dict[int, list[tuple[str, str]]] = defaultdict(list)
        total = AlarmCounts()
        for eq_id, sev, state in rows:
            per_eq[eq_id].append((sev, state))
            setattr(total, sev, getattr(total, sev) + 1)
            if state in (AlarmState.ACTIVE_UNACK.value, AlarmState.CLEARED_UNACK.value):
                total.unacknowledged += 1
        return per_eq, total

    def _equipment_summary(
        self, eq: EquipmentInfo, alarms: list[tuple[str, str]], now: datetime
    ) -> EquipmentSummary:
        last = self._last_data(eq)
        online = last is not None and (now - last).total_seconds() <= self._s.stale_after_s
        health = Health.NORMAL
        if not online:
            health = Health.OFFLINE
        else:
            active = [sev for sev, st in alarms if st in _ACTIVE]
            if Severity.CRITICAL.value in active:
                health = Health.CRITICAL
            elif active:
                health = Health.WARNING
        live = self._live.equipment.get(eq.id)
        return EquipmentSummary(
            id=eq.id,
            code=eq.code,
            name=eq.name,
            type=eq.type.value,
            state=live.state if live else None,
            state_since=live.state_ts if live else None,
            sensor_health=live.sensor_health if live else None,
            health=health,
            communication=Communication.ONLINE if online else Communication.OFFLINE,
            open_alarms=len(alarms),
            unacknowledged_alarms=sum(
                1
                for _, st in alarms
                if st in (AlarmState.ACTIVE_UNACK.value, AlarmState.CLEARED_UNACK.value)
            ),
            last_data_at=last,
        )

    def _vessel_summary(
        self, code: str, per_eq: dict[int, list[tuple[str, str]]], now: datetime
    ) -> tuple[VesselSummary, list[EquipmentSummary]]:
        v = self._catalog.vessels[code]
        eqs = self._catalog.equipment_of_vessel(code)
        summaries = [self._equipment_summary(e, per_eq.get(e.id, []), now) for e in eqs]
        counts = AlarmCounts()
        for e in eqs:
            for sev, st in per_eq.get(e.id, []):
                setattr(counts, sev, getattr(counts, sev) + 1)
                if st in (AlarmState.ACTIVE_UNACK.value, AlarmState.CLEARED_UNACK.value):
                    counts.unacknowledged += 1
        online = sum(1 for s in summaries if s.communication is Communication.ONLINE)
        comm = (
            Communication.ONLINE
            if online == len(summaries) and summaries
            else Communication.OFFLINE
            if online == 0
            else Communication.DEGRADED
        )
        health = max(
            (s.health for s in summaries), key=_HEALTH_RANK.__getitem__, default=Health.OFFLINE
        )
        if comm is Communication.OFFLINE:
            health = Health.OFFLINE
        last = max((s.last_data_at for s in summaries if s.last_data_at), default=None)
        return VesselSummary(
            id=v.id,
            code=v.code,
            name=v.name,
            vessel_type=v.vessel_type,
            health=health,
            communication=comm,
            equipment_count=len(eqs),
            open_alarms=counts,
            last_data_at=last,
        ), summaries

    # ------------------------------------------------------------------ queries
    async def vessels(self) -> list[VesselSummary]:
        per_eq, _ = await self._alarm_rows()
        now = datetime.now(UTC)
        return [self._vessel_summary(c, per_eq, now)[0] for c in self._catalog.vessels]

    async def vessel(self, code: str) -> VesselDetail:
        if code not in self._catalog.vessels:
            raise not_found("Vessel", code)
        per_eq, _ = await self._alarm_rows()
        now = datetime.now(UTC)
        vs, eq_summaries = self._vessel_summary(code, per_eq, now)
        details = [
            self._equipment_detail(e, s, now)
            for e, s in zip(self._catalog.equipment_of_vessel(code), eq_summaries, strict=True)
        ]
        return VesselDetail(**vs.model_dump(), equipment=details)

    async def equipment(self, vessel: str, code: str) -> EquipmentDetail:
        eq = self._catalog.equipment_by_code.get((vessel, code))
        if eq is None:
            raise not_found("Equipment", f"{vessel}/{code}")
        per_eq, _ = await self._alarm_rows()
        now = datetime.now(UTC)
        return self._equipment_detail(
            eq, self._equipment_summary(eq, per_eq.get(eq.id, []), now), now
        )

    def _equipment_detail(
        self, eq: EquipmentInfo, s: EquipmentSummary, now: datetime
    ) -> EquipmentDetail:
        return EquipmentDetail(
            **s.model_dump(),
            vessel_code=eq.vessel_code,
            vessel_name=self._catalog.vessels[eq.vessel_code].name,
            readings=[self.reading(eq, k, now) for k in eq.sensors],
        )

    async def summary(self, active_scenarios: int) -> FleetSummary:
        per_eq, total = await self._alarm_rows()
        now = datetime.now(UTC)
        v_health: dict[str, int] = dict.fromkeys((h.value for h in Health), 0)
        e_health: dict[str, int] = dict.fromkeys((h.value for h in Health), 0)
        comm: dict[str, int] = dict.fromkeys((c.value for c in Communication), 0)
        last: datetime | None = None
        for code in self._catalog.vessels:
            vs, eqs = self._vessel_summary(code, per_eq, now)
            v_health[vs.health.value] += 1
            comm[vs.communication.value] += 1
            for e in eqs:
                e_health[e.health.value] += 1
            if vs.last_data_at and (last is None or vs.last_data_at > last):
                last = vs.last_data_at
        return FleetSummary(
            vessels_total=len(self._catalog.vessels),
            vessels_by_health=v_health,
            equipment_total=len(self._catalog.equipment_by_id),
            equipment_by_health=e_health,
            communication=comm,
            open_alarms=total,
            opcua_state=self._sup.status.state,
            last_data_at=last,
            active_scenarios=active_scenarios,
        )

    async def recent_events(self, limit: int) -> list[RecentEvent]:
        out: list[RecentEvent] = []
        async with self._sessionmaker() as session:
            alarm_rows = await session.execute(
                select(m.AlarmEvent, m.Alarm.severity, m.Alarm.equipment_id, m.Alarm.message)
                .join(m.Alarm, m.Alarm.id == m.AlarmEvent.alarm_id)
                .order_by(m.AlarmEvent.event_ts.desc(), m.AlarmEvent.id.desc())
                .limit(limit)
            )
            for ev, sev, eq_id, msg in alarm_rows:
                eq = self._catalog.equipment_by_id[eq_id]
                out.append(
                    RecentEvent(
                        id=f"alarm-event-{ev.id}",
                        type="alarm",
                        at=ev.event_ts,
                        severity=Severity(sev),
                        vessel_code=eq.vessel_code,
                        equipment_code=eq.code,
                        message=f"Alarm {ev.event_type}: {msg}"
                        + (f" (by {ev.actor})" if ev.actor != "system" else ""),
                        alarm_id=ev.alarm_id,
                    )
                )
            sim_rows = (
                await session.scalars(
                    select(m.SimulatorEvent).order_by(m.SimulatorEvent.at.desc()).limit(limit)
                )
            ).all()
            for se in sim_rows:
                label = se.scenario_id or "all scenarios"
                out.append(
                    RecentEvent(
                        id=f"sim-event-{se.id}",
                        type="scenario",
                        at=se.at,
                        severity=Severity.WARNING if se.result == "failed" else Severity.INFO,
                        vessel_code=se.vessel_code,
                        equipment_code=None,
                        message=f"Scenario {se.action} '{label}' by {se.actor}: {se.result}",
                    )
                )
            sys_rows = (
                await session.scalars(
                    select(m.SystemEvent).order_by(m.SystemEvent.at.desc()).limit(limit)
                )
            ).all()
            for sy in sys_rows:
                out.append(
                    RecentEvent(
                        id=f"system-event-{sy.id}",
                        type="system",
                        at=sy.at,
                        severity=Severity(sy.severity),
                        vessel_code=None,
                        equipment_code=None,
                        message=sy.message,
                    )
                )
        out.sort(key=lambda e: e.at, reverse=True)
        return out[:limit]
