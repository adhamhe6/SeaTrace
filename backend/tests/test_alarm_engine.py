"""Pure unit tests for the alarm engine (no database, no network, no clock)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from app.domain.alarms import AlarmEngine, AlarmStateError, RuleSpec, Sample
from app.domain.enums import (
    AlarmEventType,
    AlarmKind,
    AlarmState,
    Comparison,
    EquipmentType,
    Quality,
    Severity,
)

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)

HIGH_TEMP = RuleSpec(
    id=1,
    code="ME_TEMP_HIGH",
    name="High temp",
    kind=AlarmKind.CONDITION,
    comparison=Comparison.GT,
    severity=Severity.WARNING,
    equipment_type=EquipmentType.MAIN_ENGINE,
    measurement_key="temperature",
    threshold=95.0,
    clear_threshold=90.0,
    activate_after_s=5.0,
    clear_after_s=5.0,
)
LOW_PRESS = RuleSpec(
    id=2,
    code="COOL_PRESS_LOW",
    name="Low pressure",
    kind=AlarmKind.CONDITION,
    comparison=Comparison.LT,
    severity=Severity.CRITICAL,
    equipment_type=EquipmentType.COOLING_SYSTEM,
    measurement_key="pressure",
    threshold=1.8,
    clear_threshold=2.0,
    activate_after_s=0,
    clear_after_s=0,
)
QUALITY = RuleSpec(
    id=3,
    code="SENSOR_QUALITY",
    name="Sensor quality",
    kind=AlarmKind.DATA_QUALITY,
    comparison=Comparison.BAD_QUALITY,
    severity=Severity.WARNING,
    activate_after_s=3.0,
    clear_after_s=5.0,
)
STALE = RuleSpec(
    id=4,
    code="SOURCE_COMM_LOSS",
    name="Comm loss",
    kind=AlarmKind.COMMUNICATION,
    comparison=Comparison.STALE,
    severity=Severity.CRITICAL,
    threshold=10.0,
    activate_after_s=0,
    clear_after_s=3.0,
)


def temp(value: float | None, t: float, quality: Quality = Quality.GOOD) -> Sample:
    ts = T0 + timedelta(seconds=t)
    return Sample(
        1,
        EquipmentType.MAIN_ENGINE,
        "Main engine",
        10,
        "temperature",
        "Engine temperature",
        "°C",
        value,
        quality,
        ts,
        ts,
    )


def feed(engine: AlarmEngine, values: list[tuple[float, float]]) -> list:
    out = []
    for t, v in values:
        out += engine.evaluate_sample(temp(v, t))
    return out


def test_requires_persistence_before_activation() -> None:
    e = AlarmEngine([HIGH_TEMP])
    assert feed(e, [(0, 96), (1, 96), (4, 96)]) == []  # only 4 s of violation
    out = feed(e, [(5, 97)])
    assert [t.event_type for t in out] == [AlarmEventType.RAISED]
    alarm = out[0].alarm
    assert alarm.state is AlarmState.ACTIVE_UNACK
    assert alarm.trigger_value == 97 and alarm.raised_at == T0 + timedelta(seconds=5)
    assert out[0].details["condition_started_at"] == T0.isoformat()


def test_blip_below_persistence_does_not_alarm() -> None:
    e = AlarmEngine([HIGH_TEMP])
    assert (
        feed(e, [(0, 96), (2, 96), (3, 80), (4, 96), (8, 96)]) == []
    )  # pending timer restarted at t=4


def test_hysteresis_and_dwell_prevent_chatter() -> None:
    e = AlarmEngine([HIGH_TEMP])
    feed(e, [(0, 96), (5, 96)])
    # Falls into the dead band (90..95): condition still considered active.
    assert feed(e, [(6, 93), (12, 93)]) == []
    # Below clear threshold but not long enough
    assert feed(e, [(13, 89), (16, 89)]) == []
    # Bounces back into dead band: the clear timer restarts
    assert feed(e, [(17, 92), (18, 89)]) == []
    out = feed(e, [(23, 89)])
    assert [t.event_type for t in out] == [AlarmEventType.CLEARED]
    assert out[0].to_state is AlarmState.CLEARED_UNACK  # cleared but NOT acknowledged


def test_dedup_single_alarm_while_condition_persists() -> None:
    e = AlarmEngine([HIGH_TEMP])
    out = feed(e, [(i, 100) for i in range(0, 60)])
    assert len([t for t in out if t.event_type is AlarmEventType.RAISED]) == 1
    assert len(e.open_alarms()) == 1


def test_ack_then_clear_closes_alarm() -> None:
    e = AlarmEngine([HIGH_TEMP])
    raised = feed(e, [(0, 96), (5, 96)])[0].alarm
    raised.id = 7
    e.register_persisted(raised)
    ack = e.acknowledge(7, T0 + timedelta(seconds=6), user_id=2, username="operator", note="seen")
    assert (ack.from_state, ack.to_state) == (AlarmState.ACTIVE_UNACK, AlarmState.ACTIVE_ACK)
    assert ack.actor == "operator" and raised.acknowledged_by == "operator"
    assert raised.condition_active and raised.acknowledged
    out = feed(e, [(10, 80), (15, 80)])
    assert out[-1].to_state is AlarmState.CLEARED and out[-1].details["acknowledged_before_clear"]
    assert e.open_alarms() == []  # closed alarms leave the engine


def test_clear_then_ack_closes_alarm_and_ack_is_not_implied_by_clear() -> None:
    e = AlarmEngine([HIGH_TEMP])
    raised = feed(e, [(0, 96), (5, 96)])[0].alarm
    raised.id = 8
    e.register_persisted(raised)
    feed(e, [(10, 80), (15, 80)])
    assert raised.state is AlarmState.CLEARED_UNACK and raised.acknowledged_at is None
    assert not raised.condition_active
    ack = e.acknowledge(8, T0 + timedelta(seconds=30), 2, "operator")
    assert ack.to_state is AlarmState.CLEARED
    assert e.open_alarms() == []
    with pytest.raises(AlarmStateError):
        e.acknowledge(8, T0 + timedelta(seconds=31), 2, "operator")


def test_double_ack_rejected() -> None:
    e = AlarmEngine([HIGH_TEMP])
    a = feed(e, [(0, 96), (5, 96)])[0].alarm
    a.id = 9
    e.register_persisted(a)
    e.acknowledge(9, T0, 1, "op")
    with pytest.raises(AlarmStateError) as exc:
        e.acknowledge(9, T0, 1, "op")
    assert exc.value.code == "alarm_already_acknowledged"


def test_reactivation_of_unacknowledged_cleared_alarm_reuses_record() -> None:
    e = AlarmEngine([HIGH_TEMP])
    a = feed(e, [(0, 96), (5, 96)])[0].alarm
    a.id = 3
    e.register_persisted(a)
    feed(e, [(10, 80), (15, 80)])
    out = feed(e, [(20, 97), (25, 97)])
    assert [t.event_type for t in out] == [AlarmEventType.REACTIVATED]
    assert out[0].alarm is a and a.occurrence_count == 2 and a.state is AlarmState.ACTIVE_UNACK
    assert a.cleared_at is None


def test_new_alarm_after_closed_alarm() -> None:
    e = AlarmEngine([HIGH_TEMP])
    a = feed(e, [(0, 96), (5, 96)])[0].alarm
    a.id = 1
    e.register_persisted(a)
    e.acknowledge(1, T0, 1, "op")
    feed(e, [(10, 80), (15, 80)])
    out = feed(e, [(20, 97), (25, 97)])
    assert out[0].event_type is AlarmEventType.RAISED and out[0].alarm is not a


def test_low_threshold_rule_and_immediate_activation() -> None:
    e = AlarmEngine([LOW_PRESS])
    ts = T0
    s = Sample(
        5,
        EquipmentType.COOLING_SYSTEM,
        "Cooling",
        50,
        "pressure",
        "Cooling pressure",
        "bar",
        1.5,
        Quality.GOOD,
        ts,
        ts,
    )
    out = e.evaluate_sample(s)
    assert len(out) == 1 and out[0].alarm.severity is Severity.CRITICAL
    assert "below limit" in out[0].alarm.message


def test_unusable_samples_neither_raise_nor_clear_process_alarms() -> None:
    e = AlarmEngine([HIGH_TEMP])
    feed(e, [(0, 96), (5, 96)])
    out = []
    for t in range(6, 30):
        out += e.evaluate_sample(temp(None, t, Quality.BAD))
    assert out == []  # garbage does not clear the alarm
    assert e.open_alarms()[0].state is AlarmState.ACTIVE_UNACK


def test_late_and_duplicate_samples_are_ignored_by_alarm_logic() -> None:
    e = AlarmEngine([HIGH_TEMP])
    feed(e, [(0, 96), (5, 96)])
    assert e.evaluate_sample(temp(10, 3)) == []  # older than newest -> not replayed
    assert e.evaluate_sample(temp(10, 5)) == []  # duplicate timestamp
    assert e.late_samples == 2
    assert e.open_alarms()[0].state is AlarmState.ACTIVE_UNACK


def test_data_quality_alarm_per_sensor_and_recovery() -> None:
    e = AlarmEngine([QUALITY])
    out = []
    for t in range(0, 4):
        out += e.evaluate_sample(temp(None, t, Quality.INVALID))
    assert len(out) == 1 and out[0].alarm.kind is AlarmKind.DATA_QUALITY
    assert "invalid" in out[0].alarm.message
    out = []
    for t in range(4, 12):
        out += e.evaluate_sample(temp(50.0, t))
    assert out and out[-1].to_state is AlarmState.CLEARED_UNACK


def test_stuck_quality_raises_data_quality_alarm() -> None:
    e = AlarmEngine([QUALITY])
    out = []
    for t in range(0, 5):
        out += e.evaluate_sample(temp(80.0, t, Quality.STUCK))
    assert len(out) == 1


def test_communication_loss_and_recovery() -> None:
    e = AlarmEngine([STALE])
    e.register_equipment(1, EquipmentType.MAIN_ENGINE, "Main engine", T0)
    assert e.evaluate_time(T0 + timedelta(seconds=9)) == []
    out = e.evaluate_time(T0 + timedelta(seconds=11))
    assert len(out) == 1 and out[0].alarm.kind is AlarmKind.COMMUNICATION
    assert e.evaluate_time(T0 + timedelta(seconds=12)) == []  # de-duplicated
    # data resumes
    e.evaluate_sample(temp(80, 20))
    for sec in (20, 22):
        assert e.evaluate_time(T0 + timedelta(seconds=sec)) == []
    out = e.evaluate_time(T0 + timedelta(seconds=24))
    assert out and out[0].event_type is AlarmEventType.CLEARED


def test_restore_open_alarms_after_restart() -> None:
    e1 = AlarmEngine([HIGH_TEMP])
    a = feed(e1, [(0, 96), (5, 96)])[0].alarm
    a.id = 11
    e2 = AlarmEngine([HIGH_TEMP])
    e2.restore([a])
    assert e2.get_alarm(11) is a
    # no duplicate raised while the condition continues; clears normally
    assert feed(e2, [(10, 99), (11, 99)]) == []
    out = feed(e2, [(12, 80), (17, 80)])
    assert out[-1].event_type is AlarmEventType.CLEARED


def test_snapshot_restore_rolls_back_engine_state() -> None:
    e = AlarmEngine([HIGH_TEMP])
    feed(e, [(0, 96)])
    snap = e.snapshot()
    feed(e, [(5, 96)])
    assert len(e.open_alarms()) == 1
    e.restore_snapshot(snap)
    assert e.open_alarms() == []
    out = feed(e, [(5, 96)])
    assert len(out) == 1


def test_disabled_rules_are_ignored() -> None:
    from dataclasses import replace

    e = AlarmEngine([replace(HIGH_TEMP, enabled=False)])
    assert feed(e, [(0, 99), (10, 99)]) == []


def test_rule_without_clear_threshold_uses_threshold() -> None:
    from dataclasses import replace

    rule = replace(HIGH_TEMP, clear_threshold=None, clear_after_s=0, activate_after_s=0)
    e = AlarmEngine([rule])
    assert len(feed(e, [(0, 96)])) == 1
    out = feed(
        e, [(1, 95.0)]
    )  # equal to the threshold counts as recovered when no hysteresis is set
    assert [t.event_type for t in out] == [AlarmEventType.CLEARED]
