"""Fixtures that run the REAL C++ simulator as a subprocess and connect the REAL backend to it over OPC UA."""

from __future__ import annotations

import asyncio
import os
import shutil
import socket
import subprocess
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from app.config import Settings
from app.container import Container
from app.main import create_app

from tests.conftest import OPERATOR_PW, _login

REPO = Path(__file__).resolve().parents[3]
DEFAULT_BIN = REPO / "simulator" / "build" / "seatrace_simulator"
SIM_BIN = Path(os.environ.get("SEATRACE_SIMULATOR_BIN", DEFAULT_BIN))
CONTROL_USER, CONTROL_PASSWORD = "ctl-test", "ctl-test-password"

pytestmark = pytest.mark.integration


def pytest_collection_modifyitems(config, items):  # type: ignore[no-untyped-def]
    if SIM_BIN.exists():
        return
    skip = pytest.mark.skip(
        reason=f"simulator binary not found at {SIM_BIN} (build it or set SEATRACE_SIMULATOR_BIN)"
    )
    for item in items:
        if "integration" in str(item.fspath):
            item.add_marker(skip)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class SimProcess:
    def __init__(self, port: int, env: dict[str, str]) -> None:
        self.port = port
        self.env = env
        self.proc: subprocess.Popen[bytes] | None = None
        self.endpoint = f"opc.tcp://127.0.0.1:{port}"

    def start(self) -> None:
        self.proc = subprocess.Popen(  # noqa: S603
            [str(SIM_BIN)],
            env=self.env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=str(REPO / "simulator"),
        )

    def stop(self) -> int | None:
        if self.proc is None:
            return None
        self.proc.terminate()
        try:
            return self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.wait()


def sim_env(port: int, **extra: str) -> dict[str, str]:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "SIM_OPCUA_PORT": str(port),
        "SIM_TICK_MS": "200",
        "SIM_SEED": "7",
        "SIM_SECURITY_MODE": "none",
        "SIM_CONTROL_USER": CONTROL_USER,
        "SIM_CONTROL_PASSWORD": CONTROL_PASSWORD,
        "SIM_CONFIG": str(REPO / "simulator" / "config" / "fleet.json"),
    }
    env.update(extra)
    return env


@pytest.fixture
def sim() -> Callable[..., SimProcess]:
    started: list[SimProcess] = []

    def make(**extra: str) -> SimProcess:
        s = SimProcess(free_port(), sim_env(0, **extra))
        s.env["SIM_OPCUA_PORT"] = str(s.port)
        s.start()
        started.append(s)
        return s

    yield make  # type: ignore[misc]
    for s in started:
        s.stop()


async def eventually(predicate, timeout: float = 30.0, interval: float = 0.2):  # noqa: ASYNC109
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        result = predicate()
        if asyncio.iscoroutine(result):
            result = await result
        if result:
            return result
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"condition not met within {timeout}s: {predicate}")
        await asyncio.sleep(interval)


class Stack:
    def __init__(
        self, container: Container, client: httpx.AsyncClient, op: dict[str, str], sim: SimProcess
    ):
        self.c, self.client, self.op, self.sim = container, client, op, sim

    async def get(self, path: str, **params):  # type: ignore[no-untyped-def]
        r = await self.client.get(f"/api/v1{path}", headers=self.op, params=params)
        assert r.status_code == 200, r.text
        return r.json()

    async def post(self, path: str, body: dict | None = None):  # type: ignore[no-untyped-def]
        return await self.client.post(f"/api/v1{path}", headers=self.op, json=body or {})


@pytest_asyncio.fixture
async def stack(settings: Settings, engine, sim) -> AsyncIterator[Stack]:  # type: ignore[no-untyped-def]
    simulator = sim()
    s = settings.model_copy(
        update={
            "opcua_enabled": True,
            "opcua_endpoint": simulator.endpoint,
            "opcua_user": CONTROL_USER,
            "opcua_password": CONTROL_PASSWORD,
            "opcua_backoff_min_s": 0.3,
            "opcua_backoff_max_s": 2.0,
            "opcua_keepalive_interval_s": 0.5,
            "opcua_request_timeout_s": 2.0,
            "opcua_publish_interval_ms": 200,
            "stale_after_s": 5.0,
        }
    )
    c = Container(s)
    app = create_app(s, c)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            op = await _login(client, "operator", OPERATOR_PW)
            yield Stack(c, client, op, simulator)


_ = shutil
