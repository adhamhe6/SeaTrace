"""SQLAlchemy ORM models. All timestamps are timezone-aware UTC (``timestamptz``)."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Double,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

TS = DateTime(timezone=True)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("role IN ('viewer','operator')", name="role_valid"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16))
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())


class Vessel(Base):
    __tablename__ = "vessels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    vessel_type: Mapped[str] = mapped_column(String(64))
    is_simulated: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())

    equipment: Mapped[list[Equipment]] = relationship(
        back_populates="vessel", order_by="Equipment.id"
    )


class Equipment(Base):
    __tablename__ = "equipment"
    __table_args__ = (UniqueConstraint("vessel_id", "code", name="uq_equipment_vessel_code"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    vessel_id: Mapped[int] = mapped_column(ForeignKey("vessels.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(128))
    equipment_type: Mapped[str] = mapped_column(String(32))
    current_state: Mapped[str | None] = mapped_column(String(32))
    state_since: Mapped[datetime | None] = mapped_column(TS)

    vessel: Mapped[Vessel] = relationship(back_populates="equipment")
    sensors: Mapped[list[Sensor]] = relationship(back_populates="equipment", order_by="Sensor.id")


class Sensor(Base):
    """Measurement catalogue entry: one measured quantity of one equipment item."""

    __tablename__ = "sensors"
    __table_args__ = (
        UniqueConstraint("equipment_id", "key", name="uq_sensors_equipment_key"),
        UniqueConstraint("id", "equipment_id", name="uq_sensors_id_equipment"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(48))
    name: Mapped[str] = mapped_column(String(128))
    unit: Mapped[str] = mapped_column(String(16))
    plausible_min: Mapped[float] = mapped_column(Double)
    plausible_max: Mapped[float] = mapped_column(Double)
    nominal_min: Mapped[float | None] = mapped_column(Double)
    nominal_max: Mapped[float | None] = mapped_column(Double)
    flatline_check: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))

    equipment: Mapped[Equipment] = relationship(back_populates="sensors")


class Telemetry(Base):
    """Time-series measurements. (sensor_id, source_ts) is the idempotency key."""

    __tablename__ = "telemetry"
    __table_args__ = (
        ForeignKeyConstraint(
            ["sensor_id", "equipment_id"],
            ["sensors.id", "sensors.equipment_id"],
            name="fk_telemetry_sensor_equipment",
        ),
        CheckConstraint(
            "quality IN ('good','uncertain','bad','invalid','stuck')", name="quality_valid"
        ),
        Index("ix_telemetry_equipment_source_ts", "equipment_id", "source_ts"),
    )

    sensor_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_ts: Mapped[datetime] = mapped_column(TS, primary_key=True)
    equipment_id: Mapped[int] = mapped_column(Integer)
    ingested_ts: Mapped[datetime] = mapped_column(TS)
    value: Mapped[float | None] = mapped_column(Double)
    quality: Mapped[str] = mapped_column(String(16))
    status_code: Mapped[int | None] = mapped_column(BigInteger)


class EquipmentStateChange(Base):
    __tablename__ = "equipment_state_changes"
    __table_args__ = (
        UniqueConstraint("equipment_id", "source_ts", name="uq_state_changes_equipment_ts"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id", ondelete="CASCADE"))
    state: Mapped[str] = mapped_column(String(32))
    source_ts: Mapped[datetime] = mapped_column(TS)
    ingested_ts: Mapped[datetime] = mapped_column(TS)


class AlarmRule(Base):
    __tablename__ = "alarm_rules"
    __table_args__ = (
        CheckConstraint("kind IN ('condition','data_quality','communication')", name="kind_valid"),
        CheckConstraint("severity IN ('info','warning','critical')", name="severity_valid"),
        CheckConstraint("comparison IN ('gt','lt','bad_quality','stale')", name="comparison_valid"),
        CheckConstraint("activate_after_s >= 0 AND clear_after_s >= 0", name="durations_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(48), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(16))
    equipment_type: Mapped[str | None] = mapped_column(String(32))
    measurement_key: Mapped[str | None] = mapped_column(String(48))
    comparison: Mapped[str] = mapped_column(String(16))
    threshold: Mapped[float | None] = mapped_column(Double)
    clear_threshold: Mapped[float | None] = mapped_column(Double)
    activate_after_s: Mapped[float] = mapped_column(Double, server_default=text("0"))
    clear_after_s: Mapped[float] = mapped_column(Double, server_default=text("0"))
    severity: Mapped[str] = mapped_column(String(16))
    enabled: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TS, server_default=func.now(), onupdate=func.now())


class Alarm(Base):
    __tablename__ = "alarms"
    __table_args__ = (
        CheckConstraint(
            "state IN ('active_unacknowledged','active_acknowledged',"
            "'cleared_unacknowledged','cleared')",
            name="state_valid",
        ),
        CheckConstraint("severity IN ('info','warning','critical')", name="severity_valid"),
        # At most one open (not closed) alarm per rule/equipment/sensor => de-duplication in the database.
        Index(
            "uq_alarms_open_per_source",
            "rule_id",
            "equipment_id",
            text("COALESCE(sensor_id, 0)"),
            unique=True,
            postgresql_where=text("state <> 'cleared'"),
        ),
        Index("ix_alarms_equipment_raised_at", "equipment_id", "raised_at"),
        Index("ix_alarms_raised_at", "raised_at"),
        Index("ix_alarms_state", "state"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    rule_id: Mapped[int] = mapped_column(ForeignKey("alarm_rules.id"))
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id"))
    sensor_id: Mapped[int | None] = mapped_column(ForeignKey("sensors.id"))
    kind: Mapped[str] = mapped_column(String(16))
    severity: Mapped[str] = mapped_column(String(16))
    state: Mapped[str] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)
    threshold: Mapped[float | None] = mapped_column(Double)
    comparison: Mapped[str] = mapped_column(String(16))
    trigger_value: Mapped[float | None] = mapped_column(Double)
    trigger_ts: Mapped[datetime] = mapped_column(TS)
    last_value: Mapped[float | None] = mapped_column(Double)
    last_value_ts: Mapped[datetime | None] = mapped_column(TS)
    raised_at: Mapped[datetime] = mapped_column(TS)
    cleared_at: Mapped[datetime | None] = mapped_column(TS)
    acknowledged_at: Mapped[datetime | None] = mapped_column(TS)
    acknowledged_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    acknowledged_by: Mapped[str | None] = mapped_column(String(64))  # username at ack time (audit)
    occurrence_count: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(TS, server_default=func.now(), onupdate=func.now())

    rule: Mapped[AlarmRule] = relationship()
    equipment: Mapped[Equipment] = relationship()
    sensor: Mapped[Sensor | None] = relationship()
    events: Mapped[list[AlarmEvent]] = relationship(
        back_populates="alarm", order_by="AlarmEvent.id", cascade="all, delete-orphan"
    )


class AlarmEvent(Base):
    """Append-only audit trail of alarm state transitions."""

    __tablename__ = "alarm_events"
    __table_args__ = (
        Index("ix_alarm_events_alarm_id", "alarm_id"),
        Index("ix_alarm_events_event_ts", "event_ts"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    alarm_id: Mapped[int] = mapped_column(ForeignKey("alarms.id", ondelete="CASCADE"))
    event_type: Mapped[str] = mapped_column(String(16))
    from_state: Mapped[str | None] = mapped_column(String(32))
    to_state: Mapped[str] = mapped_column(String(32))
    event_ts: Mapped[datetime] = mapped_column(
        TS
    )  # when it happened (source time or operator action time)
    recorded_at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    actor: Mapped[str] = mapped_column(String(64))  # 'system' or username
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    value: Mapped[float | None] = mapped_column(Double)
    note: Mapped[str | None] = mapped_column(Text)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    alarm: Mapped[Alarm] = relationship(back_populates="events")


class SimulatorEvent(Base):
    """Audit of operator commands sent to the simulator."""

    __tablename__ = "simulator_events"
    __table_args__ = (Index("ix_simulator_events_at", "at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    actor: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(16))  # activate | clear | reset
    scenario_id: Mapped[str | None] = mapped_column(String(48))
    vessel_code: Mapped[str | None] = mapped_column(String(32))
    params: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    result: Mapped[str] = mapped_column(String(16))  # accepted | rejected | failed
    message: Mapped[str | None] = mapped_column(Text)


class SystemEvent(Base):
    """Operational events such as OPC UA connection state changes."""

    __tablename__ = "system_events"
    __table_args__ = (Index("ix_system_events_at", "at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    at: Mapped[datetime] = mapped_column(TS, server_default=func.now())
    kind: Mapped[str] = mapped_column(String(32))
    severity: Mapped[str] = mapped_column(String(16), server_default=text("'info'"))
    message: Mapped[str] = mapped_column(Text)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


__all__ = [
    "Alarm",
    "AlarmEvent",
    "AlarmRule",
    "Equipment",
    "EquipmentStateChange",
    "Sensor",
    "SimulatorEvent",
    "SystemEvent",
    "Telemetry",
    "User",
    "Vessel",
]
