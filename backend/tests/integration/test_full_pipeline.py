"""End-to-end through the real stack: C++ simulator -> OPC UA -> ingestion -> PostgreSQL -> REST API.

(The browser/UI leg is covered by the Playwright suite in frontend/e2e.)
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from tests.helpers import scalar
from tests.integration.conftest import Stack, eventually

pytestmark = pytest.mark.integration


async def wait_for_data(st: Stack, timeout: float = 40.0) -> None:
    async def all_online() -> bool:
        vs = await st.get("/vessels")
        return all(v["communication"] == "online" for v in vs)

    await eventually(all_online, timeout=timeout)
    await eventually(lambda: stack_accepted(st) >= 60, timeout=timeout)  # ~3 samples of each of 20 sensors


def stack_accepted(st: Stack) -> int:
    return st.c.ingestion.stats["accepted"]


async def test_simulator_measurements_reach_database_and_api(stack: Stack):
    await wait_for_data(stack)
    status = await stack.get("/system/status")
    assert status["opcua"]["state"] == "connected" and status["opcua"]["monitored_items"] == 38
    latest = await stack.get("/telemetry/latest")
    assert len(latest) == 20  # 2 vessels x 10 sensors
    now = datetime.now(UTC)
    for r in latest:
        assert r["value"] is not None and r["quality"] == "good", r
        assert abs((now - datetime.fromisoformat(r["source_ts"])).total_seconds()) < 5
        assert r["unit"]
    temp = next(r for r in latest if (r["vessel_code"], r["equipment_code"], r["measurement"]) == ("VES-001", "ME1", "temperature"))
    assert 60 < temp["value"] < 100 and temp["unit"] == "°C"
    # the same value exists in PostgreSQL
    row = await scalar(stack.c, "SELECT count(*) FROM telemetry t JOIN sensors s ON s.id=t.sensor_id "
                                "WHERE s.key='temperature' AND t.equipment_id = 1 AND t.quality='good'")
    assert row >= 3
    vessel = await stack.get("/vessels/VES-001")
    states = {e["code"]: e["state"] for e in vessel["equipment"]}
    assert states["ME1"] == "RUNNING" and states["GEN1"] == "RUNNING" and states["BILGE1"] in ("STANDBY", "PUMPING")
    assert vessel["health"] == "normal"
    # history contains the exact stored records
    hist = await stack.get("/telemetry/history", vessel="VES-001", equipment="ME1", measurement="rpm",
                           **{"from": (now - timedelta(minutes=5)).isoformat(), "to": (now + timedelta(seconds=5)).isoformat()})
    assert len(hist["items"]) >= 3 and all(i["quality"] == "good" for i in hist["items"])
    # no alarms in normal operation
    assert (await stack.get("/alarms", open="true"))["total"] == 0


async def test_fault_to_alarm_to_acknowledgement_to_replay(stack: Stack):
    await wait_for_data(stack)
    t_start = datetime.now(UTC)
    r = await stack.post("/simulator/scenarios/sensor_failure/activate", {"vessel_code": "VES-001"})
    assert r.status_code == 200, r.text
    alarm = await eventually(lambda: _first_alarm(stack, "SENSOR_QUALITY"), timeout=30)
    assert alarm["state"] == "active_unacknowledged" and alarm["measurement"] == "power_output"
    assert alarm["vessel_code"] == "VES-001" and alarm["equipment_code"] == "GEN1"
    # data was stored with the Bad flag rather than a fake number
    bad = await scalar(stack.c, "SELECT count(*) FROM telemetry WHERE quality='bad' AND value IS NULL")
    assert bad >= 3
    # acknowledge -> audit
    ack = await stack.post(f"/alarms/{alarm['id']}/acknowledge", {"note": "investigating sensor"})
    detail = ack.json()
    assert ack.status_code == 200 and detail["state"] == "active_acknowledged"
    assert [e["event_type"] for e in detail["events"]] == ["raised", "acknowledged"]
    assert detail["events"][-1]["actor"] == "operator" and detail["acknowledged_by"] == "operator"
    # clear the scenario: sensor recovers, alarm closes (it was acknowledged first)
    r = await stack.post("/simulator/scenarios/sensor_failure/clear", {"vessel_code": "VES-001"})
    assert r.status_code == 200
    closed = await eventually(lambda: _alarm_in_state(stack, alarm["id"], "cleared"), timeout=40)
    assert [e["event_type"] for e in closed["events"]] == ["raised", "acknowledged", "cleared"]
    # incident replay uses stored records for exactly that window
    inc = await stack.get(f"/incidents/alarm/{alarm['id']}", before_s=20, after_s=20)
    assert inc["focus_alarm_id"] == alarm["id"] and inc["equipment_code"] == "GEN1"
    power = next(s for s in inc["series"] if s["measurement"] == "power_output")
    qualities = {p["quality"] for p in power["points"]}
    assert "bad" in qualities and "good" in qualities
    assert any(e["event_type"] == "raised" for e in inc["alarm_events"])
    assert all(datetime.fromisoformat(p["ts"]) >= t_start - timedelta(seconds=25) for p in power["points"])
    audit = await stack.get("/simulator/events")
    assert [e["action"] for e in audit][:2] == ["clear", "activate"] and all(e["actor"] == "operator" for e in audit)


async def test_physical_fault_cooling_pressure_loss_raises_alarm_and_heats_engine(stack: Stack):
    await wait_for_data(stack)
    before = next(r for r in await stack.get("/telemetry/latest", vessel="VES-002", equipment="ME1")
                  if r["measurement"] == "temperature")["value"]
    assert (await stack.post("/simulator/scenarios/cooling_pressure_loss/activate", {"vessel_code": "VES-002"})).status_code == 200
    alarm = await eventually(lambda: _first_alarm(stack, "COOL_PRESS_LOW"), timeout=120)
    assert alarm["vessel_code"] == "VES-002" and alarm["equipment_code"] == "COOL1"
    assert alarm["trigger_value"] < 1.8 and alarm["unit"] == "bar"
    # the other vessel is unaffected
    assert not (await stack.get("/alarms", vessel="VES-001", open="true"))["items"]
    # physical coupling: the engine of the affected vessel heats up
    async def hotter() -> bool:
        t = next(r for r in await stack.get("/telemetry/latest", vessel="VES-002", equipment="ME1") if r["measurement"] == "temperature")
        return t["value"] > before + 1.0
    await eventually(hotter, timeout=120)
    await stack.post("/simulator/scenarios/cooling_pressure_loss/clear", {"vessel_code": "VES-002"})


async def test_duplicate_scenario_is_rejected_by_simulator(stack: Stack):
    await wait_for_data(stack)
    assert (await stack.post("/simulator/scenarios/bilge_flooding/activate", {"vessel_code": "VES-001"})).status_code == 200
    r = await stack.post("/simulator/scenarios/bilge_flooding/activate", {"vessel_code": "VES-001"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "scenario_rejected"
    status = await eventually(lambda: _active(stack), timeout=10)
    assert status[0]["scenario_id"] == "bilge_flooding" and status[0]["vessel_code"] == "VES-001"
    assert (await stack.post("/simulator/reset")).status_code == 200
    await eventually(lambda: _no_active(stack), timeout=10)


async def test_telemetry_interruption_marks_stale_raises_comm_alarm_and_recovers(stack: Stack):
    await wait_for_data(stack)
    r = await stack.post("/simulator/scenarios/telemetry_interruption/activate", {"vessel_code": "VES-001", "duration_s": 16})
    assert r.status_code == 200
    comm = await eventually(lambda: _first_alarm(stack, "SOURCE_COMM_LOSS", vessel="VES-001"), timeout=40)
    assert comm["kind"] == "communication" and comm["severity"] == "critical"
    vessel = await stack.get("/vessels/VES-001")
    assert vessel["communication"] == "offline" and vessel["health"] == "offline"
    stale = [x for e in vessel["equipment"] for x in e["readings"] if x["stale"]]
    assert stale and all(x["quality"] == "stale" for x in stale)
    assert (await stack.get("/vessels/VES-002"))["communication"] == "online"  # other vessel keeps reporting
    # automatic recovery after the scenario's duration
    async def back_online() -> bool:
        return (await stack.get("/vessels/VES-001"))["communication"] == "online"
    await eventually(back_online, timeout=60)
    cleared = await eventually(lambda: _alarm_in_state(stack, comm["id"], "cleared_unacknowledged"), timeout=30)
    assert not cleared["condition_active"] and cleared["acknowledged_by"] is None
    # history keeps the hole: the replay window reports a gap
    now = datetime.now(UTC)
    inc = await stack.get("/incidents/window", vessel="VES-001", equipment="ME1", measurement="rpm",
                          **{"from": (now - timedelta(minutes=2)).isoformat(), "to": now.isoformat()})
    assert any(g["seconds"] > 10 for g in inc["gaps"])


async def test_opcua_outage_is_reported_and_backend_reconnects(stack: Stack):
    await wait_for_data(stack)
    first = (await stack.get("/system/status"))["opcua"]
    r = await stack.post("/simulator/scenarios/opcua_outage/activate", {"duration_s": 8})
    assert r.status_code == 200
    async def down() -> bool:
        return (await stack.get("/system/status"))["opcua"]["state"] != "connected"
    await eventually(down, timeout=20)
    r = await stack.post("/simulator/scenarios/engine_overheat/activate", {"vessel_code": "VES-001"})
    assert r.status_code == 503 and r.json()["error"]["code"] == "simulator_unavailable"  # fails cleanly while down
    async def up() -> bool:
        return (await stack.get("/system/status"))["opcua"]["state"] == "connected"
    await eventually(up, timeout=60)
    after = (await stack.get("/system/status"))["opcua"]
    assert after["last_connected_at"] > first["last_connected_at"]
    assert after["monitored_items"] == first["monitored_items"]  # exactly one subscription after reconnect
    await wait_for_data(stack)
    types = {e["kind"] for e in await _system_events(stack)}
    assert {"opcua_connected", "opcua_disconnected"} <= types
    # data resumed and only one row per (sensor, source timestamp) exists
    dup = await scalar(stack.c, "SELECT count(*) FROM (SELECT 1 FROM telemetry GROUP BY sensor_id, source_ts HAVING count(*) > 1) d")
    assert dup == 0


async def test_stuck_and_out_of_range_sensor_scenarios_are_detected(stack: Stack):
    await wait_for_data(stack)
    assert (await stack.post("/simulator/scenarios/sensor_out_of_range/activate", {"vessel_code": "VES-001"})).status_code == 200
    a = await eventually(lambda: _first_alarm(stack, "SENSOR_QUALITY", vessel="VES-001"), timeout=30)
    assert a["measurement"] == "pressure"
    inv = await scalar(stack.c, "SELECT count(*) FROM telemetry WHERE quality='invalid' AND value < 0")
    assert inv >= 3
    assert (await stack.post("/simulator/scenarios/sensor_stuck/activate", {"vessel_code": "VES-002"})).status_code == 200
    b = await eventually(lambda: _first_alarm(stack, "SENSOR_QUALITY", vessel="VES-002"), timeout=60)
    assert b["measurement"] == "temperature" and "stuck" in b["message"]
    await stack.post("/simulator/reset")


# ------------------------------------------------------------------ helpers
async def _first_alarm(st: Stack, rule: str, vessel: str | None = None):  # type: ignore[no-untyped-def]
    params = {"open": "true", "limit": 100}
    if vessel:
        params["vessel"] = vessel
    for a in (await st.get("/alarms", **params))["items"]:
        if a["rule"]["code"] == rule:
            return a
    return None


async def _alarm_in_state(st: Stack, alarm_id: int, state: str):  # type: ignore[no-untyped-def]
    d = await st.get(f"/alarms/{alarm_id}")
    return d if d["state"] == state else None


async def _active(st: Stack):  # type: ignore[no-untyped-def]
    return (await st.get("/simulator/status"))["active_scenarios"] or None


async def _no_active(st: Stack) -> bool:
    return not (await st.get("/simulator/status"))["active_scenarios"]


async def _system_events(st: Stack):  # type: ignore[no-untyped-def]
    events = await st.get("/events/recent", limit=100)
    return [{"kind": "opcua_connected" if "established" in e["message"] else "opcua_disconnected"}
            for e in events if e["type"] == "system"]


_ = asyncio


# ------------------------------------------------------------------ secure channel
async def test_secure_mode_signed_and_encrypted_channel_and_untrusted_client_rejected(
    settings, engine, sim, tmp_path
):
    import subprocess
    import httpx
    from app.container import Container
    from app.main import create_app
    from tests.conftest import OPERATOR_PW, _login
    from tests.integration.conftest import CONTROL_PASSWORD, CONTROL_USER, REPO

    pki = tmp_path / "pki"
    subprocess.run([str(REPO / "scripts" / "gen-dev-certs.sh")], check=True, env={"PKI_DIR": str(pki), "PATH": "/usr/bin:/bin"},
                   capture_output=True)  # noqa: S603
    simulator = sim(SIM_SECURITY_MODE="secure", SIM_SERVER_CERT=str(pki / "simulator" / "cert.der"),
                    SIM_SERVER_KEY=str(pki / "simulator" / "key.der"),
                    SIM_TRUSTED_CLIENT_CERTS=str(pki / "backend" / "cert.der"))
    base = settings.model_copy(update={
        "opcua_enabled": True, "opcua_endpoint": simulator.endpoint, "opcua_user": CONTROL_USER,
        "opcua_password": CONTROL_PASSWORD, "opcua_security": "secure", "opcua_backoff_min_s": 0.3,
        "opcua_backoff_max_s": 1.0, "opcua_request_timeout_s": 3.0, "opcua_keepalive_interval_s": 0.5})

    # 1) a client whose certificate the server does not trust must NOT get in
    untrusted = tmp_path / "pki-untrusted"
    subprocess.run([str(REPO / "scripts" / "gen-dev-certs.sh")], check=True, env={"PKI_DIR": str(untrusted), "PATH": "/usr/bin:/bin"},
                   capture_output=True)  # noqa: S603
    bad = base.model_copy(update={
        "opcua_client_cert": str(untrusted / "backend" / "cert.pem"),
        "opcua_client_key": str(untrusted / "backend" / "key.pem"),
        "opcua_server_cert": str(pki / "simulator" / "cert.pem")})
    c_bad = Container(bad)
    app_bad = create_app(bad, c_bad)
    async with app_bad.router.lifespan_context(app_bad):
        await asyncio.sleep(4)
        assert not c_bad.supervisor.connected and c_bad.supervisor.status.last_error

    # 2) the trusted backend certificate connects, reads and controls over the encrypted channel
    good = base.model_copy(update={
        "opcua_client_cert": str(pki / "backend" / "cert.pem"),
        "opcua_client_key": str(pki / "backend" / "key.pem"),
        "opcua_server_cert": str(pki / "simulator" / "cert.pem")})
    c = Container(good)
    app = create_app(good, c)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            op = await _login(client, "operator", OPERATOR_PW)
            await eventually(lambda: c.supervisor.connected, timeout=30)
            await eventually(lambda: c.ingestion.stats["accepted"] >= 20, timeout=30)
            r = await client.post("/api/v1/simulator/scenarios/bilge_flooding/activate", headers=op, json={"vessel_code": "VES-001"})
            assert r.status_code == 200, r.text
            await client.post("/api/v1/simulator/reset", headers=op)
            assert (await client.get("/api/v1/system/status", headers=op)).json()["opcua"]["security"] == "secure"
