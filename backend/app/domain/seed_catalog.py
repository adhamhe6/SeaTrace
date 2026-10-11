"""Static seed data: fleet metadata, sensor catalogue and default alarm rules.

All numbers are **illustrative simulation parameters**, not operating limits of real equipment.
They are loaded into the database by the idempotent seeder (``app.services.seed``) and from then on
the database is the source of truth (rules can be tuned in the ``alarm_rules`` table).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.enums import AlarmKind, Comparison, EquipmentType, Severity


@dataclass(frozen=True)
class SensorSeed:
    key: str
    name: str
    unit: str
    plausible_min: float
    plausible_max: float
    nominal_min: float | None
    nominal_max: float | None
    flatline_check: bool = True


@dataclass(frozen=True)
class EquipmentSeed:
    code: str
    name: str
    type: EquipmentType
    sensors: tuple[SensorSeed, ...]


@dataclass(frozen=True)
class VesselSeed:
    code: str
    name: str
    vessel_type: str
    equipment: tuple[EquipmentSeed, ...]


@dataclass(frozen=True)
class RuleSeed:
    code: str
    name: str
    description: str
    kind: AlarmKind
    comparison: Comparison
    severity: Severity
    equipment_type: EquipmentType | None = None
    measurement_key: str | None = None
    threshold: float | None = None
    clear_threshold: float | None = None
    activate_after_s: float = 0.0
    clear_after_s: float = 0.0


def _equipment() -> tuple[EquipmentSeed, ...]:
    return (
        EquipmentSeed(
            "ME1",
            "Main engine",
            EquipmentType.MAIN_ENGINE,
            (
                SensorSeed("rpm", "Engine speed", "rpm", 0, 160, 90, 105),
                SensorSeed("temperature", "Engine temperature", "°C", -20, 250, 78, 88),
                SensorSeed("vibration", "Engine vibration", "mm/s", 0, 50, 2.0, 4.0),
                SensorSeed("load", "Engine load", "%", 0, 120, 60, 80),
            ),
        ),
        EquipmentSeed(
            "GEN1",
            "Generator 1",
            EquipmentType.GENERATOR,
            (
                SensorSeed("power_output", "Power output", "kW", 0, 1500, 300, 500),
                SensorSeed("load", "Generator load", "%", 0, 130, 50, 85),
                SensorSeed("frequency", "Frequency", "Hz", 0, 70, 49.8, 50.2),
            ),
        ),
        EquipmentSeed(
            "COOL1",
            "Cooling system",
            EquipmentType.COOLING_SYSTEM,
            (
                SensorSeed("pressure", "Cooling pressure", "bar", 0, 10, 2.2, 3.0),
                SensorSeed("temperature", "Cooling temperature", "°C", -20, 200, 60, 70),
            ),
        ),
        EquipmentSeed(
            "BILGE1",
            "Bilge system",
            EquipmentType.BILGE_SYSTEM,
            (SensorSeed("water_level", "Bilge water level", "cm", 0, 200, 3, 20),),
        ),
    )


FLEET: tuple[VesselSeed, ...] = (
    VesselSeed("VES-001", "MV Aurora Tide", "Bulk carrier (simulated)", _equipment()),
    VesselSeed("VES-002", "MV Baltic Meridian", "Container feeder (simulated)", _equipment()),
)

DEFAULT_RULES: tuple[RuleSeed, ...] = (
    RuleSeed(
        "ME_TEMP_HIGH",
        "High engine temperature",
        "Engine temperature above 95 °C for 5 s; clears below 90 °C for 5 s.",
        AlarmKind.CONDITION,
        Comparison.GT,
        Severity.WARNING,
        EquipmentType.MAIN_ENGINE,
        "temperature",
        95.0,
        90.0,
        5.0,
        5.0,
    ),
    RuleSeed(
        "ME_TEMP_HIGH_HIGH",
        "Very high engine temperature",
        "Engine temperature above 105 °C for 3 s; clears below 100 °C for 5 s.",
        AlarmKind.CONDITION,
        Comparison.GT,
        Severity.CRITICAL,
        EquipmentType.MAIN_ENGINE,
        "temperature",
        105.0,
        100.0,
        3.0,
        5.0,
    ),
    RuleSeed(
        "ME_VIB_HIGH",
        "Excessive engine vibration",
        "Vibration above 7.1 mm/s for 5 s; clears below 6.0 mm/s for 5 s.",
        AlarmKind.CONDITION,
        Comparison.GT,
        Severity.WARNING,
        EquipmentType.MAIN_ENGINE,
        "vibration",
        7.1,
        6.0,
        5.0,
        5.0,
    ),
    RuleSeed(
        "ME_VIB_HIGH_HIGH",
        "Severe engine vibration",
        "Vibration above 11 mm/s for 3 s; clears below 9 mm/s for 5 s.",
        AlarmKind.CONDITION,
        Comparison.GT,
        Severity.CRITICAL,
        EquipmentType.MAIN_ENGINE,
        "vibration",
        11.0,
        9.0,
        3.0,
        5.0,
    ),
    RuleSeed(
        "COOL_PRESS_LOW",
        "Low cooling pressure",
        "Cooling pressure below 1.8 bar for 5 s; clears above 2.0 bar for 5 s.",
        AlarmKind.CONDITION,
        Comparison.LT,
        Severity.WARNING,
        EquipmentType.COOLING_SYSTEM,
        "pressure",
        1.8,
        2.0,
        5.0,
        5.0,
    ),
    RuleSeed(
        "COOL_PRESS_LOW_LOW",
        "Very low cooling pressure",
        "Cooling pressure below 1.2 bar for 3 s; clears above 1.5 bar for 5 s.",
        AlarmKind.CONDITION,
        Comparison.LT,
        Severity.CRITICAL,
        EquipmentType.COOLING_SYSTEM,
        "pressure",
        1.2,
        1.5,
        3.0,
        5.0,
    ),
    RuleSeed(
        "BILGE_LEVEL_HIGH",
        "High bilge water level",
        "Bilge level above 40 cm for 5 s; clears below 30 cm for 5 s.",
        AlarmKind.CONDITION,
        Comparison.GT,
        Severity.WARNING,
        EquipmentType.BILGE_SYSTEM,
        "water_level",
        40.0,
        30.0,
        5.0,
        5.0,
    ),
    RuleSeed(
        "BILGE_LEVEL_HIGH_HIGH",
        "Very high bilge water level",
        "Bilge level above 70 cm for 3 s; clears below 55 cm for 5 s.",
        AlarmKind.CONDITION,
        Comparison.GT,
        Severity.CRITICAL,
        EquipmentType.BILGE_SYSTEM,
        "water_level",
        70.0,
        55.0,
        3.0,
        5.0,
    ),
    RuleSeed(
        "SENSOR_QUALITY",
        "Invalid sensor data",
        "A sensor reports bad status, an implausible value, or a flat-lined (stuck) signal for 3 s.",
        AlarmKind.DATA_QUALITY,
        Comparison.BAD_QUALITY,
        Severity.WARNING,
        None,
        None,
        None,
        None,
        3.0,
        5.0,
    ),
    RuleSeed(
        "SOURCE_COMM_LOSS",
        "Loss of communication with source",
        "No fresh telemetry from the equipment for more than 10 s.",
        AlarmKind.COMMUNICATION,
        Comparison.STALE,
        Severity.CRITICAL,
        None,
        None,
        10.0,
        None,
        0.0,
        3.0,
    ),
)
