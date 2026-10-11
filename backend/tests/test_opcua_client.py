"""OPC UA client behaviour against an in-process asyncua server standing in for the C++ simulator."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.config import Settings
from app.container import Container
from app.container import Container as C

from tests.helpers import BAD_SENSOR_FAILURE, scalar
from tests.support.fake_sim import FakeSimulator


async def eventually(predicate, timeout: float = 10.0, interval: float = 0.05):  # noqa: ASYNC109
    """Poll an (async) predicate until truthy; deterministic alternative to fixed sleeps."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        result = predicate()
        if asyncio.iscoroutine(result):
            result = await result
        if result:
            return result
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(interval)


@pytest_asyncio.fixture
async def sim():
    s = FakeSimulator()
    await s.start()
    yield s
    await s.stop()


def opcua_settings(base: Settings, sim: FakeSimulator, **kw) -> Settings:
    return base.model_copy(
        update={
            "opcua_enabled": True,
            "opcua_endpoint": sim.endpoint,
            "opcua_backoff_min_s": 0.2,
            "opcua_backoff_max_s": 1.0,
            "opcua_keepalive_interval_s": 0.2,
            "opcua_request_timeout_s": 1.5,
            "opcua_connect_timeout_s": 3.0,
            "opcua_publish_interval_ms": 100,
            **kw,
        }
    )


@pytest_asyncio.fixture
async def connected(settings, engine, sim):
    c = Container(opcua_settings(settings, sim))
    from app.main import create_app

    app = create_app(c.settings, c)
    async with app.router.lifespan_context(app):
        c.app = app
        await eventually(lambda: c.supervisor.connected)
        yield c


@pytest_asyncio.fixture
async def client(connected):
    import httpx

    transport = httpx.ASGITransport(app=connected.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def op(client):
    from tests.conftest import OPERATOR_PW, _login

    return await _login(client, "operator", OPERATOR_PW)


async def test_connects_discovers_nodes_and_ingests_with_source_timestamps(
    connected: Container, sim: FakeSimulator
):
    c = connected
    assert c.supervisor.status.monitored_items > 20
    ts = datetime.now(UTC).replace(microsecond=123000) - timedelta(seconds=2)
    await sim.publish("VES-001", "ME1", "temperature", 84.25, ts)
    await eventually(lambda: scalar(c, "SELECT count(*) FROM telemetry WHERE value = 84.25"))
    row_ts = await scalar(c, "SELECT source_ts FROM telemetry WHERE value = 84.25")
    assert abs((row_ts - ts).total_seconds()) < 0.002  # source time preserved
    ingested = await scalar(c, "SELECT ingested_ts FROM telemetry WHERE value = 84.25")
    assert ingested > row_ts + timedelta(seconds=1)  # distinct from ingestion time
    await sim.set_state("VES-001", "ME1", "DEGRADED")
    await eventually(
        lambda: _eq(
            scalar(c, "SELECT current_state FROM equipment WHERE code='ME1' AND vessel_id=1"),
            "DEGRADED",
        )
    )


async def _eq(coro, expected):
    return (await coro) == expected


async def test_bad_status_and_out_of_range_values_are_flagged_not_normalised(
    connected: Container, sim: FakeSimulator
):
    c = connected
    now = datetime.now(UTC)
    await sim.publish("VES-001", "GEN1", "power_output", 12.0, now, status=BAD_SENSOR_FAILURE)
    await sim.publish("VES-001", "COOL1", "pressure", -50.0, now)

    async def rows():
        from sqlalchemy import text

        async with c.engine.connect() as conn:
            r = await conn.execute(
                text(
                    "SELECT s.key, t.quality, t.value FROM telemetry t JOIN sensors s ON s.id = t.sensor_id "
                    "WHERE s.key IN ('power_output','pressure') AND t.quality <> 'good' ORDER BY s.key"
                )
            )
            return [tuple(x) for x in r]

    got = await eventually(rows)
    assert ("power_output", "bad", None) in got and ("pressure", "invalid", -50.0) in got


async def test_stuck_sensor_detected_when_value_repeats_with_advancing_timestamps(
    connected: Container, sim: FakeSimulator
):
    c = connected
    base = datetime.now(
        UTC
    )  # newer than the server's initial value, otherwise samples count as out-of-order
    for i in range(c.settings.flatline_samples + 3):
        await sim.publish(
            "VES-001", "ME1", "temperature", 80.0, base + timedelta(milliseconds=50 * (i + 1))
        )
        await asyncio.sleep(0.12)  # let the subscription deliver each one individually
    stuck = await eventually(
        lambda: scalar(c, "SELECT count(*) FROM telemetry WHERE quality='stuck'")
    )
    assert stuck >= 1


async def test_reconnects_after_server_outage_without_duplicate_subscriptions(
    connected: Container, sim: FakeSimulator
):
    c = connected
    items = c.supervisor.status.monitored_items
    first_connected = c.supervisor.status.last_connected_at
    await sim.stop()
    await eventually(lambda: not c.supervisor.connected, timeout=15)
    assert c.supervisor.status.state in ("backoff", "connecting")
    assert c.supervisor.status.last_error
    await asyncio.sleep(
        0.6
    )  # at least one failed attempt while down; must be bounded, not a tight loop
    assert c.supervisor.status.reconnect_attempts <= 6
    await sim.start()
    await eventually(lambda: c.supervisor.connected, timeout=20)
    assert c.supervisor.status.last_connected_at > first_connected
    assert c.supervisor.status.monitored_items == items  # one subscription, not accumulated
    await sim.publish("VES-001", "ME1", "rpm", 97.5, datetime.now(UTC))
    await eventually(lambda: scalar(c, "SELECT count(*) FROM telemetry WHERE value = 97.5"))
    assert (
        await scalar(c, "SELECT count(*) FROM system_events WHERE kind='opcua_disconnected'") == 1
    )
    assert await scalar(c, "SELECT count(*) FROM system_events WHERE kind='opcua_connected'") == 2
    # one notification per published sample => no duplicate monitored items delivering the same change
    assert await scalar(c, "SELECT count(*) FROM telemetry WHERE value = 97.5") == 1


async def test_outage_produces_communication_alarm_and_recovery_clears_it(
    connected: Container, sim: FakeSimulator, client, op
):
    c = connected
    c.alarm_engine.register_equipment  # noqa: B018 - engine already tracks all equipment
    await sim.publish("VES-001", "ME1", "rpm", 97.0, datetime.now(UTC))
    await eventually(lambda: scalar(c, "SELECT count(*) FROM telemetry"))
    await sim.stop()
    # Drive time forward instead of sleeping for the real 10 s limit.
    future = datetime.now(UTC) + timedelta(seconds=60)
    await c.alarms.tick(future)
    r = (await client.get("/api/v1/alarms?kind=communication", headers=op)).json()
    assert r["total"] == 8
    v1 = next(
        v
        for v in (await client.get("/api/v1/vessels", headers=op)).json()
        if v["code"] == "VES-001"
    )
    assert v1["open_alarms"]["critical"] == 4
    await sim.start()
    await eventually(lambda: c.supervisor.connected, timeout=20)
    await sim.publish("VES-001", "ME1", "rpm", 98.0, datetime.now(UTC))
    await eventually(lambda: scalar(c, "SELECT count(*) FROM telemetry WHERE value = 98.0"))
    for step in range(1, 6):
        await c.alarms.tick(datetime.now(UTC) + timedelta(seconds=step))
    me1 = (
        await client.get(
            "/api/v1/alarms?vessel=VES-001&equipment=ME1&kind=communication", headers=op
        )
    ).json()
    assert me1["items"][0]["state"] == "cleared_unacknowledged"


async def test_backend_starts_while_simulator_is_down_and_connects_later(settings, engine):
    sim = FakeSimulator()  # not started
    c = Container(opcua_settings(settings, sim))
    from app.main import create_app

    app = create_app(c.settings, c)
    async with app.router.lifespan_context(app):
        await eventually(lambda: c.supervisor.status.state == "backoff", timeout=10)
        assert (
            await c.database_ok()
        ) and not c.supervisor.connected  # API usable, source reported down
        await sim.start()
        try:
            await eventually(lambda: c.supervisor.connected, timeout=20)
        finally:
            await sim.stop()


async def test_clean_shutdown_stops_background_tasks(settings, engine, sim):
    c = Container(opcua_settings(settings, sim))
    from app.main import create_app

    app = create_app(c.settings, c)
    async with app.router.lifespan_context(app):
        await eventually(lambda: c.supervisor.connected)
    assert c.supervisor.status.state == "stopped"
    leftovers = [
        t
        for t in asyncio.all_tasks()
        if t.get_name() in ("opcua-supervisor", "ingestion-worker", "alarm-ticker")
    ]
    assert leftovers == []


async def test_secure_mode_without_certificates_fails_cleanly(settings, engine, sim):
    c = Container(opcua_settings(settings, sim, opcua_security="secure"))
    from app.main import create_app

    app = create_app(c.settings, c)
    async with app.router.lifespan_context(app):
        await eventually(lambda: c.supervisor.status.last_error, timeout=10)
        assert "certificate" in c.supervisor.status.last_error and not c.supervisor.connected


# ------------------------------------------------------------------ simulator control
async def test_scenario_activation_goes_over_opcua_and_is_audited(
    connected: Container, sim: FakeSimulator, client, op
):
    r = await client.post(
        "/api/v1/simulator/scenarios/engine_overheat/activate",
        headers=op,
        json={"vessel_code": "VES-001"},
    )
    assert r.status_code == 200 and r.json()["accepted"]
    assert sim.calls[-1] == ("ActivateScenario", ["VES-001", "engine_overheat", 0])
    await sim.set_active_scenarios(
        '[{"scenario_id":"engine_overheat","vessel_id":"VES-001","started_at":"2026-01-01T12:00:00.000Z","ends_at":null}]'
    )
    st = await eventually(lambda: connected.simulator.status().active_scenarios)
    assert st[0].scenario_id == "engine_overheat" and st[0].vessel_code == "VES-001"
    r = await client.post(
        "/api/v1/simulator/scenarios/engine_overheat/clear",
        headers=op,
        json={"vessel_code": "VES-001"},
    )
    assert r.status_code == 200 and sim.calls[-1] == (
        "ClearScenario",
        ["VES-001", "engine_overheat"],
    )
    r = await client.post("/api/v1/simulator/reset", headers=op)
    assert r.status_code == 200 and sim.calls[-1][0] == "ResetScenarios"
    events = (await client.get("/api/v1/simulator/events", headers=op)).json()
    assert [e["action"] for e in events] == ["reset", "clear", "activate"]
    assert all(e["actor"] == "operator" and e["result"] == "accepted" for e in events)


async def test_server_scope_scenario_ignores_vessel_and_uses_default_duration(
    connected, sim, client, op
):
    r = await client.post("/api/v1/simulator/scenarios/opcua_outage/activate", headers=op, json={})
    assert r.status_code == 200
    assert sim.calls[-1] == ("ActivateScenario", ["", "opcua_outage", 20])


async def test_rejected_by_simulator_maps_to_409_and_is_audited(connected, sim, client, op):
    sim.accept = False
    r = await client.post(
        "/api/v1/simulator/scenarios/engine_overheat/activate",
        headers=op,
        json={"vessel_code": "VES-001"},
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "scenario_rejected"
    ev = (await client.get("/api/v1/simulator/events", headers=op)).json()[0]
    assert ev["result"] == "rejected" and "already active" in ev["message"]


@pytest.mark.parametrize(
    ("scenario", "body", "status", "code"),
    [
        ("engine_overheat", {}, 422, "vessel_required"),
        ("engine_overheat", {"vessel_code": "NOPE"}, 404, "not_found"),
        ("no_such_scenario", {"vessel_code": "VES-001"}, 404, "not_found"),
        (
            "telemetry_interruption",
            {"vessel_code": "VES-001", "duration_s": 9999},
            422,
            "validation_error",
        ),
        (
            "telemetry_interruption",
            {"vessel_code": "VES-001", "duration_s": 601},
            422,
            "invalid_duration",
        ),
    ],
)
async def test_scenario_command_validation(connected, client, op, scenario, body, status, code):
    r = await client.post(f"/api/v1/simulator/scenarios/{scenario}/activate", headers=op, json=body)
    assert r.status_code == status and r.json()["error"]["code"] == code


async def test_control_fails_with_503_when_simulator_unreachable_and_failure_is_audited(
    connected, sim, client, op
):
    await sim.stop()
    await eventually(lambda: not connected.supervisor.connected, timeout=15)
    r = await client.post(
        "/api/v1/simulator/scenarios/engine_overheat/activate",
        headers=op,
        json={"vessel_code": "VES-001"},
    )
    assert r.status_code == 503 and r.json()["error"]["code"] == "simulator_unavailable"
    ev = (await client.get("/api/v1/simulator/events", headers=op)).json()[0]
    assert ev["result"] == "failed"
    status = (await client.get("/api/v1/simulator/status", headers=op)).json()
    assert status["connected"] is False and status["opcua_state"] in ("backoff", "connecting")
    sysstat = (await client.get("/api/v1/system/status", headers=op)).json()
    assert sysstat["opcua"]["last_error"] and sysstat["simulated"] is True


async def test_scenarios_catalogue(client, op):
    sc = (await client.get("/api/v1/simulator/scenarios", headers=op)).json()
    assert {s["id"] for s in sc} >= {
        "engine_overheat",
        "engine_vibration",
        "cooling_pressure_loss",
        "bilge_flooding",
        "sensor_stuck",
        "sensor_out_of_range",
        "sensor_failure",
        "telemetry_interruption",
        "opcua_outage",
    }
    assert all(s["expected_alarms"] and s["description"] for s in sc)


_ = C


async def test_command_response_contains_fresh_active_scenarios(connected, sim, client, op):
    """The simulator state in the response is read after the command, never a stale subscription copy."""
    await sim.set_active_scenarios(
        '[{"scenario_id":"engine_overheat","vessel_id":"VES-001","started_at":"2026-01-01T12:00:00.000Z","ends_at":null}]'
    )
    r = await client.post(
        "/api/v1/simulator/scenarios/engine_overheat/activate",
        headers=op,
        json={"vessel_code": "VES-001"},
    )
    assert r.status_code == 200
    active = r.json()["simulator"]["active_scenarios"]
    assert [a["scenario_id"] for a in active] == ["engine_overheat"]
