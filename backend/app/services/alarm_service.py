"""Persistence, publication and queries around the pure ``AlarmEngine``."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.api.schemas import AlarmDetail, AlarmEventOut, AlarmList, AlarmOut, RuleRef
from app.db import models as m
from app.domain.alarms import AlarmEngine, AlarmRecord, AlarmStateError, Transition
from app.domain.enums import AlarmKind, AlarmState, Severity
from app.realtime.hub import EventHub
from app.services.catalog import Catalog

log = logging.getLogger(__name__)


class AlarmNotFoundError(Exception):
    pass


@dataclass(slots=True)
class PersistedTransition:
    transition: Transition
    alarm: AlarmOut
    event: AlarmEventOut


def alarm_out(a: m.Alarm, catalog: Catalog) -> AlarmOut:
    eq = catalog.equipment_by_id[a.equipment_id]
    sensor = catalog.sensor_by_id.get(a.sensor_id) if a.sensor_id else None
    rule = catalog.rules.get(a.rule_id)
    return AlarmOut(
        id=a.id,
        rule=RuleRef(
            id=a.rule_id, code=rule.code if rule else str(a.rule_id), name=rule.name if rule else ""
        ),
        kind=AlarmKind(a.kind),
        severity=Severity(a.severity),
        state=AlarmState(a.state),
        condition_active=a.state in (AlarmState.ACTIVE_UNACK.value, AlarmState.ACTIVE_ACK.value),
        acknowledged=a.state in (AlarmState.ACTIVE_ACK.value, AlarmState.CLEARED.value),
        vessel_code=eq.vessel_code,
        vessel_name=catalog.vessels[eq.vessel_code].name,
        equipment_code=eq.code,
        equipment_name=eq.name,
        measurement=sensor.key if sensor else None,
        unit=sensor.unit if sensor else None,
        message=a.message,
        comparison=a.comparison,
        threshold=a.threshold,
        trigger_value=a.trigger_value,
        trigger_ts=a.trigger_ts,
        last_value=a.last_value,
        last_value_ts=a.last_value_ts,
        raised_at=a.raised_at,
        cleared_at=a.cleared_at,
        acknowledged_at=a.acknowledged_at,
        acknowledged_by=a.acknowledged_by,
        occurrence_count=a.occurrence_count,
    )


def event_out(e: m.AlarmEvent) -> AlarmEventOut:
    return AlarmEventOut(
        id=e.id,
        alarm_id=e.alarm_id,
        event_type=e.event_type,
        from_state=AlarmState(e.from_state) if e.from_state else None,
        to_state=AlarmState(e.to_state),
        ts=e.event_ts,
        recorded_at=e.recorded_at,
        actor=e.actor,
        value=e.value,
        note=e.note,
        details=e.details,
    )


class AlarmService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        catalog: Catalog,
        engine: AlarmEngine,
        hub: EventHub,
    ) -> None:
        self._sessionmaker = sessionmaker
        self.catalog = catalog
        self.engine = engine
        self.hub = hub
        self.lock = asyncio.Lock()  # serialises engine mutation + its database transaction

    # ------------------------------------------------------------------ startup recovery
    async def restore(self, now: datetime) -> int:
        async with self._sessionmaker() as session:
            rows = (
                await session.scalars(
                    select(m.Alarm).where(m.Alarm.state != AlarmState.CLEARED.value)
                )
            ).all()
        records: list[AlarmRecord] = []
        for a in rows:
            rule = self.catalog.rules.get(a.rule_id)
            if rule is None:
                continue
            records.append(
                AlarmRecord(
                    rule=rule,
                    equipment_id=a.equipment_id,
                    sensor_id=a.sensor_id,
                    state=AlarmState(a.state),
                    severity=Severity(a.severity),
                    message=a.message,
                    trigger_value=a.trigger_value,
                    trigger_ts=a.trigger_ts,
                    raised_at=a.raised_at,
                    last_value=a.last_value,
                    last_value_ts=a.last_value_ts,
                    cleared_at=a.cleared_at,
                    acknowledged_at=a.acknowledged_at,
                    acknowledged_by_id=a.acknowledged_by_id,
                    acknowledged_by=a.acknowledged_by,
                    occurrence_count=a.occurrence_count,
                    id=a.id,
                )
            )
        self.engine.restore(records)
        for eq in self.catalog.equipment_by_id.values():
            self.engine.register_equipment(eq.id, eq.type, eq.name, now)
        return len(records)

    # ------------------------------------------------------------------ persistence
    async def persist(
        self, session: AsyncSession, transitions: list[Transition]
    ) -> list[PersistedTransition]:
        """Write transitions inside the caller's transaction. Caller holds ``self.lock``."""
        out: list[PersistedTransition] = []
        for t in transitions:
            rec = t.alarm
            if rec.id is None:
                row = m.Alarm(
                    rule_id=rec.rule.id,
                    equipment_id=rec.equipment_id,
                    sensor_id=rec.sensor_id,
                    kind=rec.rule.kind.value,
                    severity=rec.severity.value,
                    state=rec.state.value,
                    message=rec.message,
                    threshold=rec.rule.threshold,
                    comparison=rec.rule.comparison.value,
                    trigger_value=rec.trigger_value,
                    trigger_ts=rec.trigger_ts,
                    last_value=rec.last_value,
                    last_value_ts=rec.last_value_ts,
                    raised_at=rec.raised_at,
                    occurrence_count=rec.occurrence_count,
                )
                session.add(row)
                await session.flush()
                rec.id = row.id
                self.engine.register_persisted(rec)
            else:
                existing = await session.get(m.Alarm, rec.id)
                if existing is None:  # pragma: no cover - would indicate manual DB tampering
                    raise AlarmNotFoundError(str(rec.id))
                row = existing
                row.state = rec.state.value
                row.message = rec.message
                row.cleared_at = rec.cleared_at
                row.acknowledged_at = rec.acknowledged_at
                row.acknowledged_by_id = rec.acknowledged_by_id
                row.acknowledged_by = rec.acknowledged_by
                row.occurrence_count = rec.occurrence_count
                row.trigger_value, row.trigger_ts = rec.trigger_value, rec.trigger_ts
                row.last_value, row.last_value_ts = rec.last_value, rec.last_value_ts
            ev = m.AlarmEvent(
                alarm_id=rec.id,
                event_type=t.event_type.value,
                from_state=t.from_state.value if t.from_state else None,
                to_state=t.to_state.value,
                event_ts=t.ts,
                actor=t.actor,
                actor_user_id=t.actor_user_id,
                value=t.value,
                note=t.note,
                details=t.details or None,
            )
            session.add(ev)
            await session.flush()
            await session.refresh(ev)
            await session.refresh(row)
            out.append(PersistedTransition(t, alarm_out(row, self.catalog), event_out(ev)))
        return out

    def publish(self, persisted: list[PersistedTransition]) -> None:
        for p in persisted:
            self.hub.publish(
                "alarm",
                {
                    "event": p.transition.event_type.value,
                    "alarm": p.alarm.model_dump(mode="json"),
                    "alarm_event": p.event.model_dump(mode="json"),
                },
            )

    # ------------------------------------------------------------------ operations
    async def tick(self, now: datetime) -> int:
        """Evaluate time-driven conditions (communication loss). Returns number of transitions."""
        async with self.lock:
            snap = self.engine.snapshot()
            transitions = self.engine.evaluate_time(now)
            if not transitions:
                return 0
            try:
                async with self._sessionmaker() as session, session.begin():
                    persisted = await self.persist(session, transitions)
            except Exception:
                self.engine.restore_snapshot(snap)
                raise
        self.publish(persisted)
        return len(persisted)

    async def acknowledge(
        self, alarm_id: int, user_id: int, username: str, note: str | None
    ) -> AlarmDetail:
        async with self.lock:
            async with self._sessionmaker() as session:
                exists = await session.scalar(select(m.Alarm.id).where(m.Alarm.id == alarm_id))
            if exists is None:
                raise AlarmNotFoundError(str(alarm_id))
            snap = self.engine.snapshot()
            try:
                transition = self.engine.acknowledge(
                    alarm_id, datetime.now(UTC), user_id, username, note
                )
                async with self._sessionmaker() as session, session.begin():
                    persisted = await self.persist(session, [transition])
            except AlarmStateError:
                self.engine.restore_snapshot(snap)
                raise
            except Exception:
                self.engine.restore_snapshot(snap)  # DB failure: engine must not diverge from DB
                raise
        self.publish(persisted)
        return await self.get_detail(alarm_id)

    # ------------------------------------------------------------------ queries
    async def list_alarms(
        self,
        *,
        states: list[AlarmState] | None,
        open_: bool | None,
        severities: list[Severity] | None,
        vessel: str | None,
        equipment: str | None,
        kind: AlarmKind | None,
        time_from: datetime | None,
        time_to: datetime | None,
        limit: int,
        offset: int,
    ) -> AlarmList:
        conds: list[Any] = []
        if states:
            conds.append(m.Alarm.state.in_([s.value for s in states]))
        if open_ is True:
            conds.append(m.Alarm.state != AlarmState.CLEARED.value)
        elif open_ is False:
            conds.append(m.Alarm.state == AlarmState.CLEARED.value)
        if severities:
            conds.append(m.Alarm.severity.in_([s.value for s in severities]))
        if kind:
            conds.append(m.Alarm.kind == kind.value)
        if time_from:
            conds.append(m.Alarm.raised_at >= time_from)
        if time_to:
            conds.append(m.Alarm.raised_at <= time_to)
        base = select(m.Alarm).join(m.Equipment, m.Alarm.equipment_id == m.Equipment.id)
        if vessel or equipment:
            base = base.join(m.Vessel, m.Equipment.vessel_id == m.Vessel.id)
            if vessel:
                conds.append(m.Vessel.code == vessel)
            if equipment:
                conds.append(m.Equipment.code == equipment)
        where = and_(*conds) if conds else None
        count_q = (
            select(func.count()).select_from(base.subquery())
            if where is None
            else (select(func.count()).select_from(base.where(where).subquery()))
        )
        # Open alarms first by severity/time is the UI's job; API returns newest raised first.
        q = base.order_by(m.Alarm.raised_at.desc(), m.Alarm.id.desc()).limit(limit).offset(offset)
        if where is not None:
            q = q.where(where)
        async with self._sessionmaker() as session:
            total = await session.scalar(count_q) or 0
            rows = (await session.scalars(q)).all()
        return AlarmList(
            items=[alarm_out(a, self.catalog) for a in rows],
            total=total,
            limit=limit,
            offset=offset,
        )

    async def get_detail(self, alarm_id: int) -> AlarmDetail:
        async with self._sessionmaker() as session:
            row = await session.scalar(
                select(m.Alarm).options(selectinload(m.Alarm.events)).where(m.Alarm.id == alarm_id)
            )
            if row is None:
                raise AlarmNotFoundError(str(alarm_id))
            base = alarm_out(row, self.catalog)
            events = [event_out(e) for e in row.events]
        return AlarmDetail(**base.model_dump(), events=events)

    async def open_counts(self) -> list[tuple[int, str, str]]:
        """(equipment_id, severity, state) of all open alarms."""
        async with self._sessionmaker() as session:
            rows = await session.execute(
                select(m.Alarm.equipment_id, m.Alarm.severity, m.Alarm.state).where(
                    m.Alarm.state != AlarmState.CLEARED.value
                )
            )
            return [(r[0], r[1], r[2]) for r in rows]
