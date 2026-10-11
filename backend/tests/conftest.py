"""Shared fixtures: dedicated PostgreSQL test database, migrated once, truncated per test.

Set SEATRACE_TEST_DATABASE_URL to an *admin* URL (a database on a server where the user may CREATE DATABASE),
default ``postgresql+asyncpg://seatrace:seatrace@localhost:5432/postgres``. The suite creates its own
database ``seatrace_test_<random>``, applies the real Alembic migrations, and drops it at the end. It never
touches any other database.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config
from app.api.routers.auth import reset_throttle
from app.config import Settings
from app.container import Container
from app.main import create_app
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

ADMIN_URL = os.environ.get(
    "SEATRACE_TEST_DATABASE_URL", "postgresql+asyncpg://seatrace:seatrace@localhost:5432/postgres"
)
BACKEND_DIR = Path(__file__).resolve().parents[1]

OPERATOR_PW = "operator-test-pw"
VIEWER_PW = "viewer-test-pw"


def alembic_config(url: str) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


@pytest_asyncio.fixture(scope="session")
async def test_db_url() -> AsyncIterator[str]:
    name = f"seatrace_test_{uuid.uuid4().hex[:8]}"
    admin = create_async_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = ADMIN_URL.rsplit("/", 1)[0] + f"/{name}"
    # Alembic's env.py uses asyncio.run(); run it in a worker thread.
    await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
    try:
        yield url
    finally:
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await admin.dispose()


@pytest.fixture
def settings(test_db_url: str) -> Settings:
    return Settings(
        env="test",
        database_url=test_db_url,
        secret_key="test-secret-key-0123456789-0123456789",
        demo_operator_password=OPERATOR_PW,
        demo_viewer_password=VIEWER_PW,
        opcua_enabled=False,
        log_level="WARNING",
        log_json=False,
        ingest_flush_interval_s=0.01,
        ingest_db_retry_delay_s=0.05,
        ingest_db_retries=3,
        cors_origins=["http://localhost:5173"],
    )


@pytest_asyncio.fixture
async def engine(test_db_url: str) -> AsyncIterator[AsyncEngine]:
    eng = create_async_engine(test_db_url)
    async with eng.begin() as conn:
        await conn.execute(
            text(
                "TRUNCATE telemetry, equipment_state_changes, alarm_events, alarms, simulator_events, "
                "system_events, sensors, equipment, vessels, alarm_rules, users RESTART IDENTITY CASCADE"
            )
        )
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def container(settings: Settings, engine: AsyncEngine) -> AsyncIterator[Container]:
    reset_throttle()
    c = Container(settings)
    app = create_app(settings, c)
    async with app.router.lifespan_context(app):
        c.app = app  # type: ignore[attr-defined]
        yield c


@pytest_asyncio.fixture
async def client(container: Container):  # type: ignore[no-untyped-def]
    import httpx

    transport = httpx.ASGITransport(app=container.app)  # type: ignore[attr-defined]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _login(client, username: str, password: str) -> dict[str, str]:  # type: ignore[no-untyped-def]
    r = await client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest_asyncio.fixture
async def op(client) -> dict[str, str]:  # type: ignore[no-untyped-def]
    return await _login(client, "operator", OPERATOR_PW)


@pytest_asyncio.fixture
async def viewer(client) -> dict[str, str]:  # type: ignore[no-untyped-def]
    return await _login(client, "viewer", VIEWER_PW)
