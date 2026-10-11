"""Alarm engine: explicit, I/O-free domain logic.

The engine is a state machine keyed by ``(rule, equipment, sensor)``.  It never touches the database,
the network or the clock: callers feed it samples (``evaluate_sample``), the passage of wall-clock time
(``evaluate_time``) and operator actions (``acknowledge``) and persist the ``Transition`` objects it
returns.  See ``docs/alarm-lifecycle.md`` for the lifecycle diagram and the exact semantics.

Lifecycle (ISA-18.2 inspired)::

    (none) --condition persists for activate_after_s--> ACTIVE_UNACK
    ACTIVE_UNACK --operator ack--> ACTIVE_ACK
    ACTIVE_UNACK --condition cleared (hysteresis + clear_after_s)--> CLEARED_UNACK
    ACTIVE_ACK   --condition cleared--> CLEARED (closed)
    CLEARED_UNACK --operator ack--> CLEARED (closed)
    CLEARED_UNACK --condition returns (persistence again)--> ACTIVE_UNACK (same alarm, occurrence+1)

Clearing never implies acknowledgement and acknowledging never implies the condition is gone.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.enums import (
    AlarmEventType,
    AlarmKind,
    AlarmState,
    Comparison,
    EquipmentType,
    Quality,
    Severity,
)

SYSTEM_ACTOR = "system"
_BAD_QUALITIES = frozenset({Quality.BAD, Quality.INVALID, Quality.STUCK})


class AlarmStateError(Exception):
    """Raised for an operation that is not valid in the alarm's current state."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class RuleSpec:
    id: int
    code: str
    name: str
    kind: AlarmKind
    comparison: Comparison
    severity: Severity
    equipment_type: EquipmentType | None = None
    measurement_key: str | None = None
    threshold: float | None = None
    clear_threshold: float | None = None
    activate_after_s: float = 0.0
    clear_after_s: float = 0.0
    enabled: bool = True


@dataclass(frozen=True, slots=True)
class Sample:
    """A validated, classified measurement as seen by the alarm engine."""

    equipment_id: int
    equipment_type: EquipmentType
    equipment_name: str
    sensor_id: int
    key: str
    sensor_name: str
    unit: str
    value: float | None
    quality: Quality
    source_ts: datetime
    received_at: datetime  # backend wall clock when the sample arrived


@dataclass(slots=True)
class AlarmRecord:
    """In-memory alarm; mirrors the ``alarms`` table. ``id`` is None until persisted."""

    rule: RuleSpec
    equipment_id: int
    sensor_id: int | None
    state: AlarmState
    severity: Severity
    message: str
    trigger_value: float | None
    trigger_ts: datetime
    raised_at: datetime
    last_value: float | None = None
    last_value_ts: datetime | None = None
    cleared_at: datetime | None = None
    acknowledged_at: datetime | None = None
    acknowledged_by_id: int | None = None
    acknowledged_by: str | None = None
    occurrence_count: int = 1
    id: int | None = None

    @property
    def kind(self) -> AlarmKind:
        return self.rule.kind

    @property
    def condition_active(self) -> bool:
        return self.state in (AlarmState.ACTIVE_UNACK, AlarmState.ACTIVE_ACK)

    @property
    def acknowledged(self) -> bool:
        return self.state in (AlarmState.ACTIVE_ACK, AlarmState.CLEARED)


@dataclass(slots=True)
class Transition:
    event_type: AlarmEventType
    alarm: AlarmRecord
    from_state: AlarmState | None
    to_state: AlarmState
    ts: datetime
    actor: str = SYSTEM_ACTOR
    actor_user_id: int | None = None
    value: float | None = None
    note: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class _Track:
    pending_since: datetime | None = None
    ok_since: datetime | None = None
    pending_value: float | None = None
    alarm: AlarmRecord | None = None


@dataclass(slots=True)
class _EquipmentInfo:
    equipment_type: EquipmentType
    name: str
    last_fresh: datetime  # wall clock of the last fresh (non-late) sample


_Key = tuple[int, int, int | None]
EngineSnapshot = tuple[
    dict[_Key, _Track], dict[int, AlarmRecord], dict[int, datetime], dict[int, _EquipmentInfo], int
]


class AlarmEngine:
    def __init__(self, rules: list[RuleSpec]) -> None:
        self._rules = [r for r in rules if r.enabled]
        self._tracks: dict[_Key, _Track] = {}
        self._by_id: dict[int, AlarmRecord] = {}
        self._last_ts: dict[int, datetime] = {}  # sensor_id -> newest source_ts evaluated
        self._equipment: dict[int, _EquipmentInfo] = {}
        self.late_samples = 0

    # ------------------------------------------------------------------ setup / recovery
    def register_equipment(
        self, equipment_id: int, equipment_type: EquipmentType, name: str, now: datetime
    ) -> None:
        self._equipment.setdefault(equipment_id, _EquipmentInfo(equipment_type, name, now))

    def restore(self, alarms: list[AlarmRecord]) -> None:
        """Re-adopt open alarms after a restart. Pending/clear timers are intentionally not restored."""
        for alarm in alarms:
            if alarm.state is AlarmState.CLEARED:
                continue
            key = (alarm.rule.id, alarm.equipment_id, alarm.sensor_id)
            self._tracks[key] = _Track(alarm=alarm)
            if alarm.id is not None:
                self._by_id[alarm.id] = alarm

    def snapshot(self) -> EngineSnapshot:
        return copy.deepcopy(
            (self._tracks, self._by_id, self._last_ts, self._equipment, self.late_samples)
        )

    def restore_snapshot(self, snap: EngineSnapshot) -> None:
        (self._tracks, self._by_id, self._last_ts, self._equipment, self.late_samples) = (
            copy.deepcopy(snap)
        )

    def open_alarms(self) -> list[AlarmRecord]:
        return [t.alarm for t in self._tracks.values() if t.alarm is not None]

    def get_alarm(self, alarm_id: int) -> AlarmRecord | None:
        return self._by_id.get(alarm_id)

    def register_persisted(self, alarm: AlarmRecord) -> None:
        """Called by the persistence layer once a freshly raised alarm received its database id."""
        if alarm.id is not None:
            self._by_id[alarm.id] = alarm

    # ------------------------------------------------------------------ evaluation
    def evaluate_sample(self, s: Sample) -> list[Transition]:
        last = self._last_ts.get(s.sensor_id)
        if last is not None and s.source_ts <= last:
            self.late_samples += (
                1  # stored in history by the caller, but never replayed into alarms
            )
            return []
        self._last_ts[s.sensor_id] = s.source_ts
        info = self._equipment.get(s.equipment_id)
        if info is None:
            self._equipment[s.equipment_id] = _EquipmentInfo(
                s.equipment_type, s.equipment_name, s.received_at
            )
        else:
            info.last_fresh = s.received_at

        out: list[Transition] = []
        for rule in self._rules:
            if rule.equipment_type is not None and rule.equipment_type != s.equipment_type:
                continue
            if rule.comparison in (Comparison.GT, Comparison.LT):
                if rule.measurement_key != s.key or not s.quality.usable or s.value is None:
                    continue  # unusable data neither raises nor clears a process alarm
                violating = _breaches(rule, s.value)
                ok = _recovered(rule, s.value)
                key: _Key = (rule.id, s.equipment_id, s.sensor_id)
                text = _threshold_message(rule, s)
            elif rule.comparison is Comparison.BAD_QUALITY:
                if rule.measurement_key not in (None, s.key):
                    continue
                violating = s.quality in _BAD_QUALITIES
                ok = s.quality.usable
                key = (rule.id, s.equipment_id, s.sensor_id)
                text = (
                    f"{s.equipment_name} {s.sensor_name}: sensor data quality '{s.quality.value}'"
                )
            else:
                continue
            out += self._step(
                key, rule, s.equipment_id, s.sensor_id, violating, ok, s.source_ts, s.value, text
            )
        return out

    def evaluate_time(self, now: datetime) -> list[Transition]:
        """Evaluate wall-clock driven conditions (communication loss)."""
        out: list[Transition] = []
        for rule in self._rules:
            if rule.comparison is not Comparison.STALE or rule.threshold is None:
                continue
            for eq_id, info in self._equipment.items():
                if rule.equipment_type is not None and rule.equipment_type != info.equipment_type:
                    continue
                age = (now - info.last_fresh).total_seconds()
                violating = age > rule.threshold
                ok = not violating
                text = (
                    f"{info.name}: no telemetry received for {age:.0f} s "
                    f"(limit {rule.threshold:.0f} s)"
                )
                out += self._step(
                    (rule.id, eq_id, None), rule, eq_id, None, violating, ok, now, age, text
                )
        return out

    def acknowledge(
        self,
        alarm_id: int,
        at: datetime,
        user_id: int | None,
        username: str,
        note: str | None = None,
    ) -> Transition:
        alarm = self._by_id.get(alarm_id)
        if alarm is None:
            raise AlarmStateError(
                "alarm_not_open", "Alarm is closed or unknown to the alarm engine"
            )
        old = alarm.state
        if old in (AlarmState.ACTIVE_ACK, AlarmState.CLEARED):
            raise AlarmStateError("alarm_already_acknowledged", "Alarm is already acknowledged")
        new = AlarmState.ACTIVE_ACK if old is AlarmState.ACTIVE_UNACK else AlarmState.CLEARED
        alarm.state = new
        alarm.acknowledged_at = at
        alarm.acknowledged_by_id = user_id
        alarm.acknowledged_by = username
        if new is AlarmState.CLEARED:
            self._close(alarm)
        return Transition(
            AlarmEventType.ACKNOWLEDGED,
            alarm,
            old,
            new,
            at,
            actor=username,
            actor_user_id=user_id,
            value=alarm.last_value,
            note=note,
            details={"condition_active": new is AlarmState.ACTIVE_ACK},
        )

    # ------------------------------------------------------------------ internals
    def _close(self, alarm: AlarmRecord) -> None:
        self._tracks.pop((alarm.rule.id, alarm.equipment_id, alarm.sensor_id), None)
        if alarm.id is not None:
            self._by_id.pop(alarm.id, None)

    def _step(
        self,
        key: _Key,
        rule: RuleSpec,
        equipment_id: int,
        sensor_id: int | None,
        violating: bool,
        ok: bool,
        ts: datetime,
        value: float | None,
        text: str,
    ) -> list[Transition]:
        track = self._tracks.get(key)
        if track is None:
            if not violating:
                return []
            track = self._tracks[key] = _Track()
        alarm = track.alarm
        out: list[Transition] = []

        if alarm is None or not alarm.condition_active:
            # Not currently active: debounce the (re)activation.
            if violating:
                if track.pending_since is None:
                    track.pending_since = ts
                    track.pending_value = value
                if (ts - track.pending_since) >= timedelta(seconds=rule.activate_after_s):
                    out.append(
                        self._activate(track, rule, equipment_id, sensor_id, ts, value, text)
                    )
            else:
                track.pending_since = None
            if alarm is not None and alarm.state is AlarmState.CLEARED_UNACK:
                alarm.last_value, alarm.last_value_ts = value, ts
            if alarm is None and track.alarm is None and track.pending_since is None:
                self._tracks.pop(key, None)
            return out

        # Active alarm: track the latest value and look for recovery (hysteresis + dwell time).
        alarm.last_value, alarm.last_value_ts = value, ts
        if ok:
            if track.ok_since is None:
                track.ok_since = ts
            if (ts - track.ok_since) >= timedelta(seconds=rule.clear_after_s):
                out.append(self._clear(track, alarm, ts, value))
        else:
            track.ok_since = None
        return out

    def _activate(
        self,
        track: _Track,
        rule: RuleSpec,
        equipment_id: int,
        sensor_id: int | None,
        ts: datetime,
        value: float | None,
        text: str,
    ) -> Transition:
        details: dict[str, Any] = {
            "rule": rule.code,
            "condition_started_at": track.pending_since.isoformat()
            if track.pending_since
            else None,
            "condition_started_value": track.pending_value,
        }
        track.pending_since = None
        track.pending_value = None
        track.ok_since = None
        existing = track.alarm
        if (
            existing is not None
        ):  # CLEARED_UNACK -> ACTIVE_UNACK, same alarm record (de-duplication)
            old = existing.state
            existing.state = AlarmState.ACTIVE_UNACK
            existing.cleared_at = None
            existing.occurrence_count += 1
            existing.trigger_value, existing.trigger_ts = value, ts
            existing.last_value, existing.last_value_ts = value, ts
            existing.message = text
            details["occurrence"] = existing.occurrence_count
            return Transition(
                AlarmEventType.REACTIVATED,
                existing,
                old,
                existing.state,
                ts,
                value=value,
                details=details,
            )
        alarm = AlarmRecord(
            rule=rule,
            equipment_id=equipment_id,
            sensor_id=sensor_id,
            state=AlarmState.ACTIVE_UNACK,
            severity=rule.severity,
            message=text,
            trigger_value=value,
            trigger_ts=ts,
            raised_at=ts,
            last_value=value,
            last_value_ts=ts,
        )
        track.alarm = alarm
        return Transition(
            AlarmEventType.RAISED, alarm, None, alarm.state, ts, value=value, details=details
        )

    def _clear(
        self, track: _Track, alarm: AlarmRecord, ts: datetime, value: float | None
    ) -> Transition:
        old = alarm.state
        alarm.cleared_at = ts
        track.ok_since = None
        if old is AlarmState.ACTIVE_ACK:
            alarm.state = AlarmState.CLEARED
            self._close(alarm)
        else:
            alarm.state = AlarmState.CLEARED_UNACK
        return Transition(
            AlarmEventType.CLEARED,
            alarm,
            old,
            alarm.state,
            ts,
            value=value,
            details={"acknowledged_before_clear": old is AlarmState.ACTIVE_ACK},
        )


# ---------------------------------------------------------------------- helpers
def _breaches(rule: RuleSpec, value: float) -> bool:
    assert rule.threshold is not None
    return value > rule.threshold if rule.comparison is Comparison.GT else value < rule.threshold


def _recovered(rule: RuleSpec, value: float) -> bool:
    assert rule.threshold is not None
    limit = rule.clear_threshold if rule.clear_threshold is not None else rule.threshold
    if rule.comparison is Comparison.GT:
        return value < limit if rule.clear_threshold is not None else value <= limit
    return value > limit if rule.clear_threshold is not None else value >= limit


def _threshold_message(rule: RuleSpec, s: Sample) -> str:
    word = "above" if rule.comparison is Comparison.GT else "below"
    return (
        f"{s.equipment_name} {s.sensor_name} {word} limit: "
        f"{s.value:.1f} {s.unit} (limit {rule.threshold:g} {s.unit})"
    )


def utcnow() -> datetime:
    return datetime.now(UTC)
