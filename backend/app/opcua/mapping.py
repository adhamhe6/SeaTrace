"""Mapping between the documented OPC UA address space and SeaTrace measurement keys."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

NAMESPACE_URI = "urn:seatrace:simulator"
ROOT_NAME = "SeaTrace"
VESSELS_NAME = "Vessels"
SIMULATOR_NAME = "Simulator"

BindingKind = Literal["measurement", "state", "sensor_health", "heartbeat", "active_scenarios"]

_NON_MEASUREMENT = {"State": "state", "SensorHealth": "sensor_health"}
_META_PROPERTIES = {"EquipmentType", "VesselId", "Name", "Unit"}


@dataclass(frozen=True, slots=True)
class Binding:
    kind: BindingKind
    vessel_code: str = ""
    equipment_code: str = ""
    key: str = ""


def measurement_key(browse_name: str) -> str:
    """PowerOutput -> power_output, WaterLevel -> water_level, Rpm -> rpm."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", browse_name).lower()


def classify_variable(browse_name: str, vessel: str, equipment: str) -> Binding | None:
    """Binding for a variable below an equipment object, or None for static metadata properties."""
    if browse_name in _META_PROPERTIES:
        return None
    kind = _NON_MEASUREMENT.get(browse_name)
    if kind is not None:
        return Binding(kind, vessel, equipment, browse_name)  # type: ignore[arg-type]
    return Binding("measurement", vessel, equipment, measurement_key(browse_name))


def to_utc(ts: datetime | None) -> datetime | None:
    if ts is None:
        return None
    return ts.replace(tzinfo=UTC) if ts.tzinfo is None else ts.astimezone(UTC)
