"""Shared domain enumerations (string-valued so they serialise naturally to JSON/DB)."""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    VIEWER = "viewer"
    OPERATOR = "operator"


class Quality(StrEnum):
    GOOD = "good"
    UNCERTAIN = "uncertain"
    BAD = "bad"  # source reported a Bad status code
    INVALID = "invalid"  # value failed backend plausibility validation
    STUCK = "stuck"  # flat-lined while the timestamp keeps advancing
    STALE = "stale"  # derived at read time; never stored

    @property
    def usable(self) -> bool:
        return self in (Quality.GOOD, Quality.UNCERTAIN)


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"

    @property
    def rank(self) -> int:
        return {"info": 0, "warning": 1, "critical": 2}[self.value]


class AlarmState(StrEnum):
    ACTIVE_UNACK = "active_unacknowledged"
    ACTIVE_ACK = "active_acknowledged"
    CLEARED_UNACK = "cleared_unacknowledged"  # condition gone, operator has not acknowledged yet
    CLEARED = "cleared"  # condition gone and acknowledged: closed


class AlarmEventType(StrEnum):
    RAISED = "raised"
    ACKNOWLEDGED = "acknowledged"
    CLEARED = "cleared"
    REACTIVATED = "reactivated"


class AlarmKind(StrEnum):
    CONDITION = "condition"
    DATA_QUALITY = "data_quality"
    COMMUNICATION = "communication"


class Comparison(StrEnum):
    GT = "gt"
    LT = "lt"
    BAD_QUALITY = "bad_quality"
    STALE = "stale"


class EquipmentType(StrEnum):
    MAIN_ENGINE = "main_engine"
    GENERATOR = "generator"
    COOLING_SYSTEM = "cooling_system"
    BILGE_SYSTEM = "bilge_system"


class Health(StrEnum):
    NORMAL = "normal"
    WARNING = "warning"
    CRITICAL = "critical"
    OFFLINE = "offline"


class Communication(StrEnum):
    ONLINE = "online"
    DEGRADED = "degraded"
    OFFLINE = "offline"
