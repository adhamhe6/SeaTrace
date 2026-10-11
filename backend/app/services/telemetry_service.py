"""Historical telemetry queries (raw with keyset pagination, or time-bucketed aggregates)."""

from __future__ import annotations

import base64
import binascii
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.schemas import HistoryBucket, HistoryPoint, HistoryResponse
from app.config import Settings
from app.db import models as m
from app.domain.enums import Quality
from app.errors import AppError, not_found
from app.services.catalog import Catalog, EquipmentInfo

MAX_BUCKETS = 5000


def encode_cursor(ts: datetime, sensor_id: int) -> str:
    return base64.urlsafe_b64encode(f"{ts.isoformat()}|{sensor_id}".encode()).decode()


def decode_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts_s, sid_s = raw.rsplit("|", 1)
        return datetime.fromisoformat(ts_s), int(sid_s)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise AppError(422, "invalid_cursor", "The pagination cursor is not valid") from exc


def validate_range(time_from: datetime, time_to: datetime) -> tuple[datetime, datetime]:
    if time_from.tzinfo is None or time_to.tzinfo is None:
        raise AppError(
            422, "naive_datetime", "from/to must include a UTC offset, e.g. 2026-01-01T12:00:00Z"
        )
    time_from, time_to = time_from.astimezone(UTC), time_to.astimezone(UTC)
    if time_from >= time_to:
        raise AppError(422, "invalid_range", "'from' must be earlier than 'to'")
    return time_from, time_to


def resolve_equipment(catalog: Catalog, vessel: str, equipment: str) -> EquipmentInfo:
    if vessel not in catalog.vessels:
        raise not_found("Vessel", vessel)
    eq = catalog.equipment_by_code.get((vessel, equipment))
    if eq is None:
        raise not_found("Equipment", f"{vessel}/{equipment}")
    return eq


def resolve_measurements(eq: EquipmentInfo, measurements: list[str] | None) -> list[str]:
    if not measurements:
        return list(eq.sensors)
    unknown = [k for k in measurements if k not in eq.sensors]
    if unknown:
        raise AppError(
            422,
            "unknown_measurement",
            f"Unknown measurement(s) {unknown} for {eq.vessel_code}/{eq.code}; "
            f"available: {sorted(eq.sensors)}",
        )
    return list(dict.fromkeys(measurements))


class TelemetryService:
    def __init__(
        self, sessionmaker: async_sessionmaker[AsyncSession], catalog: Catalog, settings: Settings
    ) -> None:
        self._sessionmaker = sessionmaker
        self._catalog = catalog
        self._s = settings

    async def history(
        self,
        *,
        vessel: str,
        equipment: str,
        measurements: list[str] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int,
        cursor: str | None,
        bucket_s: int | None,
    ) -> HistoryResponse:
        eq = resolve_equipment(self._catalog, vessel, equipment)
        keys = resolve_measurements(eq, measurements)
        time_from, time_to = validate_range(time_from, time_to)
        limit = min(max(limit, 1), self._s.history_max_limit)
        sensor_ids = [eq.sensors[k].id for k in keys]
        by_id = {eq.sensors[k].id: k for k in keys}
        units = {k: eq.sensors[k].unit for k in keys}
        base = {
            "vessel_code": vessel,
            "equipment_code": equipment,
            "from_": time_from,
            "to": time_to,
            "bucket_s": bucket_s,
            "units": units,
        }

        if bucket_s:
            if (time_to - time_from).total_seconds() / bucket_s > MAX_BUCKETS:
                raise AppError(
                    422,
                    "too_many_buckets",
                    f"Range / bucket_s exceeds {MAX_BUCKETS} buckets; use a larger bucket_s",
                )
            if cursor:
                raise AppError(422, "cursor_not_supported", "Bucketed queries are not paginated")
            bucket = func.date_bin(
                timedelta(seconds=bucket_s), m.Telemetry.source_ts, datetime(2000, 1, 1, tzinfo=UTC)
            ).label("bucket")
            usable = m.Telemetry.quality.in_([Quality.GOOD.value, Quality.UNCERTAIN.value])
            q = (
                select(
                    m.Telemetry.sensor_id,
                    bucket,
                    func.avg(m.Telemetry.value).filter(usable),
                    func.min(m.Telemetry.value).filter(usable),
                    func.max(m.Telemetry.value).filter(usable),
                    func.count(),
                )
                .where(
                    m.Telemetry.equipment_id == eq.id,
                    m.Telemetry.sensor_id.in_(sensor_ids),
                    m.Telemetry.source_ts >= time_from,
                    m.Telemetry.source_ts <= time_to,
                )
                .group_by(m.Telemetry.sensor_id, bucket)
                .order_by(bucket, m.Telemetry.sensor_id)
            )
            async with self._sessionmaker() as session:
                rows = (await session.execute(q)).all()
            buckets = [
                HistoryBucket(
                    ts=r[1], measurement=by_id[r[0]], avg=r[2], min=r[3], max=r[4], samples=r[5]
                )
                for r in rows
            ]
            return HistoryResponse(
                **base, items=[], buckets=buckets, next_cursor=None, truncated=False
            )

        conds = [
            m.Telemetry.equipment_id == eq.id,
            m.Telemetry.sensor_id.in_(sensor_ids),
            m.Telemetry.source_ts >= time_from,
            m.Telemetry.source_ts <= time_to,
        ]
        if cursor:
            cts, csid = decode_cursor(cursor)
            conds.append(tuple_(m.Telemetry.source_ts, m.Telemetry.sensor_id) > tuple_(cts, csid))
        q = (
            select(
                m.Telemetry.sensor_id, m.Telemetry.source_ts, m.Telemetry.value, m.Telemetry.quality
            )
            .where(and_(*conds))
            .order_by(m.Telemetry.source_ts, m.Telemetry.sensor_id)
            .limit(limit + 1)
        )
        async with self._sessionmaker() as session:
            rows = (await session.execute(q)).all()
        truncated = len(rows) > limit
        rows = rows[:limit]
        items = [
            HistoryPoint(ts=r[1], measurement=by_id[r[0]], value=r[2], quality=Quality(r[3]))
            for r in rows
        ]
        next_cursor = encode_cursor(rows[-1][1], rows[-1][0]) if truncated and rows else None
        return HistoryResponse(
            **base, items=items, buckets=[], next_cursor=next_cursor, truncated=truncated
        )
