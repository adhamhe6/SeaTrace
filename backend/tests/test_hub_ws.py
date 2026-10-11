"""Event hub semantics and the WebSocket endpoint against a real (in-process) uvicorn server."""

from __future__ import annotations

import asyncio
import json
import socket
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
import uvicorn
import websockets
from app.container import Container
from app.realtime.hub import EventHub

from tests.conftest import OPERATOR_PW
from tests.helpers import T0, feed_series, sample


# ------------------------------------------------------------------ hub unit tests
def test_sequence_numbers_are_monotonic_and_replayable():
    hub = EventHub(replay_buffer=5, client_queue_size=10)
    for i in range(3):
        hub.publish("telemetry", {"i": i})
    _, backlog, resync = hub.subscribe(resume_from=1)
    assert [m.seq for m in backlog] == [2, 3] and not resync


def test_resume_beyond_buffer_requires_resync():
    hub = EventHub(replay_buffer=3, client_queue_size=10)
    for i in range(10):
        hub.publish("t", {"i": i})
    _, backlog, resync = hub.subscribe(resume_from=2)
    assert resync and backlog == []


def test_resume_from_future_seq_after_server_restart_requires_resync():
    hub = EventHub()
    hub.publish("t", {})
    _, _, resync = hub.subscribe(resume_from=500)
    assert resync


def test_resume_when_fully_caught_up_has_no_backlog_and_no_resync():
    hub = EventHub()
    hub.publish("t", {})
    _, backlog, resync = hub.subscribe(resume_from=1)
    assert backlog == [] and not resync


async def test_slow_client_is_dropped_instead_of_growing_unbounded():
    hub = EventHub(replay_buffer=10, client_queue_size=3)
    sub, _, _ = hub.subscribe()
    for i in range(10):
        hub.publish("t", {"i": i})
    assert sub.overflowed and hub.client_count == 0
    # the drained queue ends with the close sentinel
    assert await sub.queue.get() is None


# ------------------------------------------------------------------ websocket integration
@pytest_asyncio.fixture
async def live_server(container: Container):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    config = uvicorn.Config(
        container.app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.05)
    yield f"ws://127.0.0.1:{port}/api/v1/ws"
    server.should_exit = True
    await task


async def _token(client) -> str:
    r = await client.post(
        "/api/v1/auth/login", json={"username": "viewer", "password": "viewer-test-pw"}
    )
    return r.json()["access_token"]


async def _connect(url: str, token: str, resume_from=None):
    ws = await websockets.connect(url)
    hello = json.loads(await ws.recv())
    assert hello["type"] == "hello" and hello["protocol"] == 1
    await ws.send(json.dumps({"type": "auth", "token": token, "resume_from": resume_from}))
    ready = json.loads(await asyncio.wait_for(ws.recv(), 5))
    return ws, ready


async def test_ws_rejects_missing_or_bad_token(live_server):
    ws = await websockets.connect(live_server)
    await ws.recv()
    await ws.send(json.dumps({"type": "auth", "token": "nope"}))
    with pytest.raises(websockets.ConnectionClosed) as exc:
        await ws.recv()
    assert exc.value.rcvd.code == 4401


async def test_ws_auth_timeout_closes_connection(live_server, container):
    container.settings.ws_auth_timeout_s = 0.3
    ws = await websockets.connect(live_server)
    await ws.recv()
    with pytest.raises(websockets.ConnectionClosed) as exc:
        await asyncio.wait_for(ws.recv(), 3)
    assert exc.value.rcvd.code == 4401


async def test_ws_streams_telemetry_and_alarm_events(live_server, container: Container, client):
    token = await _token(client)
    ws, ready = await _connect(live_server, token)
    assert ready["type"] == "ready" and ready["resync_required"] is False
    now = datetime.now(UTC)
    await container.ingestion.process_batch([sample("temperature", 97.0, now)])
    msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
    assert msg["type"] == "telemetry" and msg["seq"] == ready["seq"] + 1
    item = msg["data"]["items"][0]
    assert (item["vessel_code"], item["measurement"], item["value"], item["unit"]) == (
        "VES-001",
        "temperature",
        97.0,
        "°C",
    )
    for i in range(1, 8):
        await container.ingestion.process_batch(
            [sample("temperature", 97.0, now + timedelta(seconds=i))]
        )
    seen = set()
    for _ in range(40):
        m = json.loads(await asyncio.wait_for(ws.recv(), 5))
        seen.add(m["type"])
        if m["type"] == "alarm":
            assert (
                m["data"]["event"] == "raised"
                and m["data"]["alarm"]["state"] == "active_unacknowledged"
            )
            break
    assert "alarm" in seen
    await ws.send(json.dumps({"type": "ping"}))
    while True:
        m = json.loads(await asyncio.wait_for(ws.recv(), 5))
        if m["type"] == "pong":
            break
    await ws.close()
    for _ in range(50):
        if container.hub.client_count == 0:
            break
        await asyncio.sleep(0.05)
    assert container.hub.client_count == 0  # connection cleanup


async def test_ws_resume_replays_missed_messages_without_gap(
    live_server, container: Container, client
):
    token = await _token(client)
    ws, ready = await _connect(live_server, token)
    last = ready["seq"]
    now = datetime.now(UTC)
    await container.ingestion.process_batch([sample("rpm", 95.0, now)])
    first = json.loads(await asyncio.wait_for(ws.recv(), 5))
    await ws.close()
    # events while disconnected
    for i in range(1, 4):
        await container.ingestion.process_batch(
            [sample("rpm", 95.0 + i, now + timedelta(seconds=i))]
        )
    ws2, ready2 = await _connect(live_server, token, resume_from=first["seq"])
    assert ready2["resync_required"] is False
    seqs = [json.loads(await asyncio.wait_for(ws2.recv(), 5))["seq"] for _ in range(3)]
    assert seqs == [first["seq"] + 1, first["seq"] + 2, first["seq"] + 3]
    assert last < first["seq"]
    await ws2.close()


async def test_ws_resume_with_unknown_seq_demands_resync(live_server, container, client):
    token = await _token(client)
    ws, ready = await _connect(live_server, token, resume_from=10_000)
    assert ready["resync_required"] is True
    await ws.close()


async def test_ws_expired_token_is_refused(live_server, container):
    from app.domain.enums import Role
    from app.security import create_access_token

    tok, _ = create_access_token(
        user_id=1,
        username="viewer",
        role=Role.VIEWER,
        secret=container.settings.secret_key,
        expires_minutes=1,
        now=datetime.now(UTC) - timedelta(hours=2),
    )
    ws = await websockets.connect(live_server)
    await ws.recv()
    await ws.send(json.dumps({"type": "auth", "token": tok}))
    with pytest.raises(websockets.ConnectionClosed) as exc:
        await ws.recv()
    assert exc.value.rcvd.code == 4401


_ = (T0, feed_series, OPERATOR_PW)
