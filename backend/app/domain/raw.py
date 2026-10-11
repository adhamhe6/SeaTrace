"""Transport-neutral raw inputs produced by the OPC UA client and consumed by ingestion."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True, slots=True)
class RawSample:
    vessel_code: str
    equipment_code: str
    key: str
    value: Any  # whatever the source delivered; validated by ingestion
    status_code: int | None
    source_ts: datetime | None
    server_ts: datetime | None
    received_at: datetime


@dataclass(frozen=True, slots=True)
class RawState:
    vessel_code: str
    equipment_code: str
    kind: str  # "state" | "sensor_health"
    value: Any
    source_ts: datetime | None
    received_at: datetime
