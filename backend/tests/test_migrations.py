"""Migrations run from an empty database, match the ORM models, and are reversible."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.runtime.migration import MigrationContext
from app.db.base import Base
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import ADMIN_URL, alembic_config


@pytest.fixture
async def empty_db():
    name = f"seatrace_mig_{uuid.uuid4().hex[:8]}"
    admin = create_async_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    async with admin.connect() as c:
        await c.execute(text(f'CREATE DATABASE "{name}"'))
    url = ADMIN_URL.rsplit("/", 1)[0] + f"/{name}"
    yield url
    async with admin.connect() as c:
        await c.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    await admin.dispose()


async def test_upgrade_from_clean_database_creates_expected_schema_and_matches_models(empty_db):
    await asyncio.to_thread(command.upgrade, alembic_config(empty_db), "head")
    eng = create_async_engine(empty_db)
    async with eng.connect() as conn:
        tables = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
        assert {
            "users",
            "vessels",
            "equipment",
            "sensors",
            "telemetry",
            "equipment_state_changes",
            "alarm_rules",
            "alarms",
            "alarm_events",
            "simulator_events",
            "system_events",
            "alembic_version",
        } <= tables
        drift = await conn.run_sync(
            lambda c: compare_metadata(MigrationContext.configure(c), Base.metadata)
        )
        assert drift == []  # models and migrations agree
        idx = await conn.run_sync(
            lambda c: {i["name"] for i in inspect(c).get_indexes("telemetry")}
        )
        assert "ix_telemetry_equipment_source_ts" in idx
        pk = await conn.run_sync(
            lambda c: inspect(c).get_pk_constraint("telemetry")["constrained_columns"]
        )
        assert pk == ["sensor_id", "source_ts"]
        # timestamps are timezone-aware
        col = await conn.execute(
            text(
                "SELECT data_type FROM information_schema.columns WHERE table_name='telemetry' AND column_name='source_ts'"
            )
        )
        assert col.scalar() == "timestamp with time zone"
    await eng.dispose()


async def test_downgrade_and_reupgrade(empty_db):
    cfg = alembic_config(empty_db)
    await asyncio.to_thread(command.upgrade, cfg, "head")
    await asyncio.to_thread(command.downgrade, cfg, "base")
    eng = create_async_engine(empty_db)
    async with eng.connect() as conn:
        tables = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
    await eng.dispose()
    assert tables == {"alembic_version"}
    await asyncio.to_thread(command.upgrade, cfg, "head")


async def test_database_enforces_alarm_dedup_and_idempotent_telemetry(container):
    """Integrity is enforced by constraints, not only by application code."""
    from sqlalchemy.exc import IntegrityError

    async with container.engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO alarms (rule_id, equipment_id, sensor_id, kind, severity, state, message, comparison,"
                " trigger_ts, raised_at) VALUES (1,1,1,'condition','warning','active_unacknowledged','m','gt',now(),now())"
            )
        )
    with pytest.raises(IntegrityError):
        async with container.engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO alarms (rule_id, equipment_id, sensor_id, kind, severity, state, message, comparison,"
                    " trigger_ts, raised_at) VALUES (1,1,1,'condition','warning','active_unacknowledged','m','gt',now(),now())"
                )
            )
    with pytest.raises(IntegrityError):
        async with container.engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO alarms (rule_id, equipment_id, sensor_id, kind, severity, state, message, comparison,"
                    " trigger_ts, raised_at) VALUES (1,1,1,'condition','warning','bogus','m','gt',now(),now())"
                )
            )
    with pytest.raises(
        IntegrityError
    ):  # telemetry row must reference a sensor of the same equipment
        async with container.engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT INTO telemetry (sensor_id, equipment_id, source_ts, ingested_ts, value, quality) "
                    "VALUES (1, 2, now(), now(), 1, 'good')"
                )
            )


async def test_seed_is_idempotent(container):
    from app.services.seed import run_seed

    before = [
        await _count(container, t)
        for t in ("vessels", "equipment", "sensors", "alarm_rules", "users")
    ]
    await run_seed(container.sessionmaker, container.settings)
    await run_seed(container.sessionmaker, container.settings)
    after = [
        await _count(container, t)
        for t in ("vessels", "equipment", "sensors", "alarm_rules", "users")
    ]
    assert before == after == [2, 8, 20, 10, 2]


async def test_seed_preserves_tuned_rules_and_refreshes_demo_password(container, settings):
    from app.services.seed import run_seed

    async with container.engine.begin() as conn:
        await conn.execute(
            text("UPDATE alarm_rules SET threshold = 99 WHERE code = 'ME_TEMP_HIGH'")
        )
    new = settings.model_copy(update={"demo_operator_password": "rotated-password"})
    await run_seed(container.sessionmaker, new)
    async with container.engine.connect() as conn:
        assert (
            await conn.execute(text("SELECT threshold FROM alarm_rules WHERE code='ME_TEMP_HIGH'"))
        ).scalar() == 99
        h = (
            await conn.execute(text("SELECT password_hash FROM users WHERE username='operator'"))
        ).scalar()
    from app.security import verify_password

    assert verify_password("rotated-password", h) and "rotated-password" not in h


async def _count(c, table):
    async with c.engine.connect() as conn:
        return (await conn.execute(text(f"SELECT count(*) FROM {table}"))).scalar()  # noqa: S608
