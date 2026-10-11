"""Pydantic request/response models for the public REST + WebSocket API (all timestamps UTC, ISO-8601)."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.enums import (
    AlarmKind,
    AlarmState,
    Communication,
    Health,
    Quality,
    Role,
    Severity,
)


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------------- errors
class ErrorBody(ApiModel):
    code: str
    message: str
    details: list[dict[str, Any]] | None = None
    request_id: str | None = None


class ErrorResponse(ApiModel):
    error: ErrorBody


# ---------------------------------------------------------------------------- auth
class UserOut(ApiModel):
    id: int
    username: str
    role: Role


class LoginRequest(ApiModel):
    username: Annotated[str, Field(min_length=1, max_length=64)]
    password: Annotated[str, Field(min_length=1, max_length=256)]


class TokenResponse(ApiModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"  # noqa: S105
    expires_at: datetime
    user: UserOut


# ---------------------------------------------------------------------------- system
class HealthResponse(ApiModel):
    status: Literal["ok", "ready", "not_ready"]
    checks: dict[str, str] = Field(default_factory=dict)


class OpcUaStatus(ApiModel):
    state: Literal["disabled", "connecting", "connected", "disconnected", "backoff", "stopped"]
    endpoint: str
    security: Literal["none", "secure"]
    last_connected_at: datetime | None
    last_disconnected_at: datetime | None
    last_data_at: datetime | None = Field(
        description="Backend time of the last accepted telemetry sample"
    )
    reconnect_attempts: int
    monitored_items: int
    heartbeat: int | None
    last_error: str | None


class IngestionStats(ApiModel):
    queue_depth: int
    received: int
    accepted: int
    duplicates: int
    late: int
    invalid: int
    bad: int
    stuck: int
    dropped: int
    rejected_timestamp: int
    db_failures: int
    last_batch_at: datetime | None


class SystemStatus(ApiModel):
    version: str
    environment: str
    server_time: datetime
    simulated: Literal[True] = True
    disclaimer: str
    database: Literal["ok", "unavailable"]
    opcua: OpcUaStatus
    ingestion: IngestionStats
    websocket_clients: int
    stale_after_s: float


# ---------------------------------------------------------------------------- readings
class LatestReading(ApiModel):
    sensor_id: int
    vessel_code: str
    equipment_code: str
    measurement: str
    name: str
    unit: str
    value: float | None
    quality: Quality = Field(
        description="'stale' is derived when the reading is older than stale_after_s"
    )
    source_ts: datetime | None = Field(description="Time the source measured the value")
    ingested_ts: datetime | None = Field(description="Time the backend stored the value")
    age_s: float | None
    stale: bool
    nominal_min: float | None
    nominal_max: float | None


class EquipmentSummary(ApiModel):
    id: int
    code: str
    name: str
    type: str
    state: str | None
    state_since: datetime | None
    sensor_health: str | None
    health: Health
    communication: Communication
    open_alarms: int
    unacknowledged_alarms: int
    last_data_at: datetime | None


class EquipmentDetail(EquipmentSummary):
    vessel_code: str
    vessel_name: str
    readings: list[LatestReading]


class AlarmCounts(ApiModel):
    info: int = 0
    warning: int = 0
    critical: int = 0
    unacknowledged: int = 0


class VesselSummary(ApiModel):
    id: int
    code: str
    name: str
    vessel_type: str
    simulated: Literal[True] = True
    health: Health
    communication: Communication
    equipment_count: int
    open_alarms: AlarmCounts
    last_data_at: datetime | None


class VesselDetail(VesselSummary):
    equipment: list[EquipmentDetail]


class FleetSummary(ApiModel):
    vessels_total: int
    vessels_by_health: dict[str, int]
    equipment_total: int
    equipment_by_health: dict[str, int]
    communication: dict[str, int]
    open_alarms: AlarmCounts
    opcua_state: str
    last_data_at: datetime | None
    active_scenarios: int


class RecentEvent(ApiModel):
    id: str
    type: Literal["alarm", "scenario", "system"]
    at: datetime
    severity: Severity
    vessel_code: str | None
    equipment_code: str | None
    message: str
    alarm_id: int | None = None


# ---------------------------------------------------------------------------- telemetry history
class HistoryPoint(ApiModel):
    ts: datetime
    measurement: str
    value: float | None
    quality: Quality


class HistoryBucket(ApiModel):
    ts: datetime
    measurement: str
    avg: float | None
    min: float | None
    max: float | None
    samples: int


class HistoryResponse(ApiModel):
    vessel_code: str
    equipment_code: str
    from_: datetime = Field(alias="from")
    to: datetime
    bucket_s: int | None
    units: dict[str, str]
    items: list[HistoryPoint]
    buckets: list[HistoryBucket]
    next_cursor: str | None
    truncated: bool

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ---------------------------------------------------------------------------- alarms
class RuleRef(ApiModel):
    id: int
    code: str
    name: str


class AlarmOut(ApiModel):
    id: int
    rule: RuleRef
    kind: AlarmKind
    severity: Severity
    state: AlarmState
    condition_active: bool
    acknowledged: bool
    vessel_code: str
    vessel_name: str
    equipment_code: str
    equipment_name: str
    measurement: str | None
    unit: str | None
    message: str
    comparison: str
    threshold: float | None
    trigger_value: float | None
    trigger_ts: datetime
    last_value: float | None
    last_value_ts: datetime | None
    raised_at: datetime
    cleared_at: datetime | None
    acknowledged_at: datetime | None
    acknowledged_by: str | None
    occurrence_count: int


class AlarmEventOut(ApiModel):
    id: int
    alarm_id: int
    event_type: str
    from_state: AlarmState | None
    to_state: AlarmState
    ts: datetime = Field(
        description="When the transition happened (source time or operator action time)"
    )
    recorded_at: datetime
    actor: str
    value: float | None
    note: str | None
    details: dict[str, Any] | None


class AlarmDetail(AlarmOut):
    events: list[AlarmEventOut]


class AlarmList(ApiModel):
    items: list[AlarmOut]
    total: int
    limit: int
    offset: int


class AcknowledgeRequest(ApiModel):
    note: Annotated[str | None, Field(max_length=500)] = None


class AlarmRuleOut(ApiModel):
    id: int
    code: str
    name: str
    description: str
    kind: AlarmKind
    equipment_type: str | None
    measurement_key: str | None
    comparison: str
    threshold: float | None
    clear_threshold: float | None
    activate_after_s: float
    clear_after_s: float
    severity: Severity
    enabled: bool


# ---------------------------------------------------------------------------- incidents
class SeriesPoint(ApiModel):
    ts: datetime
    value: float | None
    quality: Quality


class SeriesOut(ApiModel):
    measurement: str
    name: str
    unit: str
    nominal_min: float | None
    nominal_max: float | None
    points: list[SeriesPoint]
    truncated: bool


class StatePoint(ApiModel):
    ts: datetime
    state: str


class DataGap(ApiModel):
    measurement: str
    from_: datetime = Field(alias="from")
    to: datetime
    seconds: float

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


class IncidentWindow(ApiModel):
    vessel_code: str
    vessel_name: str
    equipment_code: str
    equipment_name: str
    from_: datetime = Field(alias="from")
    to: datetime
    series: list[SeriesOut]
    state_changes: list[StatePoint]
    state_at_start: str | None
    alarm_events: list[AlarmEventOut]
    alarms: list[AlarmOut]
    gaps: list[DataGap]
    point_count: int
    first_ts: datetime | None
    last_ts: datetime | None
    focus_alarm_id: int | None = None

    model_config = ConfigDict(populate_by_name=True, from_attributes=True)


# ---------------------------------------------------------------------------- simulator
class ScenarioInfo(ApiModel):
    id: str
    name: str
    description: str
    category: Literal["equipment", "sensor", "communication"]
    target: str
    scope: Literal["vessel", "server"]
    default_duration_s: int
    max_duration_s: int
    expected_alarms: list[str]


class ActiveScenario(ApiModel):
    scenario_id: str
    vessel_code: str | None
    started_at: datetime | None
    ends_at: datetime | None


class SimulatorStatus(ApiModel):
    connected: bool
    opcua_state: str
    endpoint: str
    security: str
    heartbeat: int | None
    heartbeat_age_s: float | None
    active_scenarios: list[ActiveScenario]
    notice: str


class ScenarioCommand(ApiModel):
    vessel_code: Annotated[str | None, Field(max_length=32)] = None
    duration_s: Annotated[int | None, Field(ge=0, le=3600)] = None


class ScenarioResult(ApiModel):
    accepted: bool
    message: str
    simulator: SimulatorStatus


class SimulatorEventOut(ApiModel):
    id: int
    at: datetime
    actor: str
    action: str
    scenario_id: str | None
    vessel_code: str | None
    params: dict[str, Any] | None
    result: str
    message: str | None


# ---------------------------------------------------------------------------- anomaly detection
class AnomalyAssessment(ApiModel):
    vessel_code: str
    equipment_code: str
    status: Literal["insufficient_data", "normal", "watch", "anomaly", "not_applicable"]
    score: float = Field(ge=0, le=1, description="0 = nominal, 1 = strongest combined drift")
    explanation: str
    features: dict[str, float | None]
    alarm_active: bool = Field(
        description="True if a vibration/temperature alarm is already active"
    )
    evaluated_at: datetime
    disclaimer: str
