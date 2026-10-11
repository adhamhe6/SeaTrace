from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from app.container import Container
from app.domain.raw import RawSample, RawState
from sqlalchemy import text

T0 = datetime(2026, 3, 1, 12, 0, 0, tzinfo=UTC)
GOOD = 0
BAD_SENSOR_FAILURE = 0x80300000
UNCERTAIN = 0x40950000


def sample(
    key: str,
    value: Any,
    ts: datetime,
    *,
    vessel: str = "VES-001",
    equipment: str = "ME1",
    status: int | None = GOOD,
    received: datetime | None = None,
) -> RawSample:
    return RawSample(vessel, equipment, key, value, status, ts, ts, received or datetime.now(UTC))


def state(value: str, ts: datetime, *, vessel: str = "VES-001", equipment: str = "ME1") -> RawState:
    return RawState(vessel, equipment, "state", value, ts, datetime.now(UTC))


async def feed_series(
    c: Container,
    key: str,
    values: list[float],
    *,
    start: datetime = T0,
    step_s: float = 1.0,
    vessel: str = "VES-001",
    equipment: str = "ME1",
) -> None:
    """Ingest consecutive samples; one batch each so alarm logic sees the per-sample progression."""
    for i, v in enumerate(values):
        ts = start + timedelta(seconds=i * step_s)
        await c.ingestion.process_batch([sample(key, v, ts, vessel=vessel, equipment=equipment)])


async def scalar(c: Container, sql: str, **params: Any) -> Any:
    async with c.engine.connect() as conn:
        return (await conn.execute(text(sql), params)).scalar()
