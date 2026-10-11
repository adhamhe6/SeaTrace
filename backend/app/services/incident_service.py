"""Incident investigation: stored telemetry + equipment states + alarm events for a time window.

Everything returned is read from PostgreSQL; nothing is interpolated or synthesised. Gaps in the data are
reported explicitly so the replay UI can show them instead of drawing a misleading continuous line.
"""

from __future__ import annotations

import statistics
from datetime import UTC, datetime, timedelta
from itertools import pairwise

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.schemas import (
    DataGap,
    IncidentWindow,
    SeriesOut,
    SeriesPoint,
    StatePoint,
)
from app.config import Settings
from app.db import models as m
from app.domain.enums import Quality
from app.errors import AppError
from app.services.alarm_service import AlarmService, alarm_out, event_out
from app.services.catalog import Catalog
from app.services.telemetry_service import resolve_equipment, resolve_measurements, validate_range

MIN_GAP_S = 3.0
GAP_FACTOR = 5.0
MAX_POINTS_PER_SERIES = 20000


class IncidentService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        catalog: Catalog,
        alarms: AlarmService,
        settings: Settings,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._catalog = catalog
        self._alarms = alarms
        self._s = settings

    async def window(
        self,
        *,
        vessel: str,
        equipment: str,
        measurements: list[str] | None,
        time_from: datetime,
        time_to: datetime,
        focus_alarm_id: int | None = None,
    ) -> IncidentWindow:
        eq = resolve_equipment(self._catalog, vessel, equipment)
        keys = resolve_measurements(eq, measurements)
        time_from, time_to = validate_range(time_from, time_to)
        max_s = self._s.incident_max_window_s
        if (time_to - time_from).total_seconds() > max_s:
            raise AppError(
                422,
                "window_too_large",
                f"Replay windows are limited to {max_s} s ({max_s // 60} min) so the data stays "
                "playable; narrow the window or page through consecutive windows.",
            )
        sensors = [eq.sensors[k] for k in keys]
        by_id = {s.id: s for s in sensors}
        async with self._sessionmaker() as session:
            rows = (
                await session.execute(
                    select(
                        m.Telemetry.sensor_id,
                        m.Telemetry.source_ts,
                        m.Telemetry.value,
                        m.Telemetry.quality,
                    )
                    .where(
                        m.Telemetry.equipment_id == eq.id,
                        m.Telemetry.sensor_id.in_(list(by_id)),
                        m.Telemetry.source_ts >= time_from,
                        m.Telemetry.source_ts <= time_to,
                    )
                    .order_by(m.Telemetry.source_ts, m.Telemetry.sensor_id)
                    .limit(MAX_POINTS_PER_SERIES * len(sensors) + 1)
                )
            ).all()
            state_rows = (
                await session.execute(
                    select(m.EquipmentStateChange.source_ts, m.EquipmentStateChange.state)
                    .where(
                        m.EquipmentStateChange.equipment_id == eq.id,
                        m.EquipmentStateChange.source_ts >= time_from,
                        m.EquipmentStateChange.source_ts <= time_to,
                    )
                    .order_by(m.EquipmentStateChange.source_ts)
                )
            ).all()
            state_before = await session.scalar(
                select(m.EquipmentStateChange.state)
                .where(
                    m.EquipmentStateChange.equipment_id == eq.id,
                    m.EquipmentStateChange.source_ts < time_from,
                )
                .order_by(m.EquipmentStateChange.source_ts.desc())
                .limit(1)
            )
            alarm_rows = (
                await session.scalars(
                    select(m.Alarm)
                    .where(
                        m.Alarm.equipment_id == eq.id,
                        m.Alarm.raised_at <= time_to,
                        or_(
                            m.Alarm.cleared_at.is_(None),
                            m.Alarm.cleared_at >= time_from,
                            m.Alarm.state != "cleared",
                        ),
                    )
                    .order_by(m.Alarm.raised_at)
                )
            ).all()
            alarm_ids = [a.id for a in alarm_rows]
            event_rows: list[m.AlarmEvent] = []
            if alarm_ids:
                event_rows = list(
                    await session.scalars(
                        select(m.AlarmEvent)
                        .where(
                            and_(
                                m.AlarmEvent.alarm_id.in_(alarm_ids),
                                m.AlarmEvent.event_ts >= time_from,
                                m.AlarmEvent.event_ts <= time_to,
                            )
                        )
                        .order_by(m.AlarmEvent.event_ts, m.AlarmEvent.id)
                    )
                )
            if focus_alarm_id is not None and focus_alarm_id not in alarm_ids:
                focus_alarm_id = None

        points: dict[int, list[SeriesPoint]] = {s.id: [] for s in sensors}
        for sid, ts, value, quality in rows:
            points[sid].append(SeriesPoint(ts=ts, value=value, quality=Quality(quality)))
        series: list[SeriesOut] = []
        gaps: list[DataGap] = []
        for s in sensors:
            pts = points[s.id]
            truncated = len(pts) > MAX_POINTS_PER_SERIES
            pts = pts[:MAX_POINTS_PER_SERIES]
            series.append(
                SeriesOut(
                    measurement=s.key,
                    name=s.name,
                    unit=s.unit,
                    nominal_min=s.nominal_min,
                    nominal_max=s.nominal_max,
                    points=pts,
                    truncated=truncated,
                )
            )
            gaps += find_gaps(s.key, [p.ts for p in pts])
        all_ts = [p.ts for s_ in series for p in s_.points]
        return IncidentWindow(
            vessel_code=vessel,
            vessel_name=self._catalog.vessels[vessel].name,
            equipment_code=equipment,
            equipment_name=eq.name,
            from_=time_from,
            to=time_to,
            series=series,
            state_changes=[StatePoint(ts=t, state=st) for t, st in state_rows],
            state_at_start=state_before,
            alarm_events=[event_out(e) for e in event_rows],
            alarms=[alarm_out(a, self._catalog) for a in alarm_rows],
            gaps=gaps,
            point_count=len(all_ts),
            first_ts=min(all_ts, default=None),
            last_ts=max(all_ts, default=None),
            focus_alarm_id=focus_alarm_id,
        )

    async def for_alarm(self, alarm_id: int, before_s: int, after_s: int) -> IncidentWindow:
        detail = await self._alarms.get_detail(alarm_id)
        end_anchor = detail.cleared_at or max(
            (e.ts for e in detail.events), default=detail.raised_at
        )
        if detail.cleared_at is None:
            end_anchor = max(
                end_anchor, min(datetime.now(UTC), detail.raised_at + timedelta(minutes=10))
            )
        time_from = detail.raised_at - timedelta(seconds=before_s)
        time_to = end_anchor + timedelta(seconds=after_s)
        max_s = self._s.incident_max_window_s
        if (time_to - time_from).total_seconds() > max_s:
            time_to = time_from + timedelta(
                seconds=max_s
            )  # long incidents: start of the incident first
        return await self.window(
            vessel=detail.vessel_code,
            equipment=detail.equipment_code,
            measurements=None,
            time_from=time_from,
            time_to=time_to,
            focus_alarm_id=alarm_id,
        )


def find_gaps(measurement: str, times: list[datetime]) -> list[DataGap]:
    """Intervals between consecutive stored points that are much longer than the series' typical cadence."""
    if len(times) < 3:
        return []
    pairs = list(pairwise(times))
    deltas = [(b - a).total_seconds() for a, b in pairs]
    typical = statistics.median(deltas)
    limit = max(MIN_GAP_S, GAP_FACTOR * typical)
    return [
        DataGap(measurement=measurement, from_=a, to=b, seconds=round(d, 3))
        for (a, b), d in zip(pairs, deltas, strict=True)
        if d > limit
    ]
