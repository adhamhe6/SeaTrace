"""REST API: authentication, authorisation, validation, fleet views, history, alarms and incidents."""

from __future__ import annotations

from datetime import timedelta

import pytest
from app.container import Container

from tests.conftest import OPERATOR_PW, VIEWER_PW
from tests.helpers import T0, feed_series, sample, state

API = "/api/v1"


# ------------------------------------------------------------------ auth
async def test_login_success_returns_token_and_role(client):
    r = await client.post(
        f"{API}/auth/login", json={"username": "operator", "password": OPERATOR_PW}
    )
    body = r.json()
    assert (
        r.status_code == 200
        and body["user"]["role"] == "operator"
        and body["token_type"] == "bearer"
    )
    me = await client.get(
        f"{API}/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    )
    assert me.json()["username"] == "operator"


async def test_login_failure_does_not_reveal_whether_the_user_exists(client):
    wrong_pw = await client.post(
        f"{API}/auth/login", json={"username": "operator", "password": "wrong"}
    )
    no_user = await client.post(
        f"{API}/auth/login", json={"username": "nobody", "password": "wrong"}
    )
    assert wrong_pw.status_code == no_user.status_code == 401
    assert (
        wrong_pw.json()["error"]["code"] == no_user.json()["error"]["code"] == "invalid_credentials"
    )
    assert wrong_pw.json()["error"]["message"] == no_user.json()["error"]["message"]
    empty = await client.post(f"{API}/auth/login", json={"username": "operator", "password": ""})
    assert empty.status_code == 422


async def test_login_is_throttled_after_repeated_failures(client):
    for _ in range(5):
        assert (
            await client.post(f"{API}/auth/login", json={"username": "viewer", "password": "bad"})
        ).status_code == 401
    r = await client.post(f"{API}/auth/login", json={"username": "viewer", "password": VIEWER_PW})
    assert r.status_code == 429 and r.json()["error"]["code"] == "too_many_attempts"


@pytest.mark.parametrize(
    "path",
    [
        "/vessels",
        "/fleet/summary",
        "/alarms",
        "/simulator/status",
        "/telemetry/latest",
        "/system/status",
        "/alarm-rules",
    ],
)
async def test_endpoints_require_authentication(client, path):
    r = await client.get(f"{API}{path}")
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"
    r = await client.get(f"{API}{path}", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401


async def test_expired_or_tampered_tokens_rejected(client, container):
    from datetime import UTC, datetime

    from app.domain.enums import Role
    from app.security import create_access_token

    expired, _ = create_access_token(
        user_id=1,
        username="operator",
        role=Role.OPERATOR,
        secret=container.settings.secret_key,
        expires_minutes=1,
        now=datetime.now(UTC) - timedelta(hours=1),
    )
    assert (
        await client.get(f"{API}/vessels", headers={"Authorization": f"Bearer {expired}"})
    ).status_code == 401
    forged, _ = create_access_token(
        user_id=1,
        username="operator",
        role=Role.OPERATOR,
        secret="a-different-secret-key-000000000000",
        expires_minutes=10,
    )
    assert (
        await client.get(f"{API}/vessels", headers={"Authorization": f"Bearer {forged}"})
    ).status_code == 401


async def test_viewer_cannot_perform_operator_actions(client, viewer, container):
    r = await client.post(f"{API}/alarms/1/acknowledge", headers=viewer)
    assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden"
    r = await client.post(
        f"{API}/simulator/scenarios/engine_overheat/activate",
        headers=viewer,
        json={"vessel_code": "VES-001"},
    )
    assert r.status_code == 403
    assert (await client.post(f"{API}/simulator/reset", headers=viewer)).status_code == 403
    assert (await client.get(f"{API}/vessels", headers=viewer)).status_code == 200


async def test_unauthenticated_mutations_are_401_not_403(client):
    assert (await client.post(f"{API}/alarms/1/acknowledge")).status_code == 401
    assert (await client.post(f"{API}/simulator/reset")).status_code == 401


async def test_cors_only_allows_configured_origin(client):
    ok = await client.options(
        f"{API}/vessels",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = await client.options(
        f"{API}/vessels",
        headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in bad.headers


async def test_errors_use_uniform_envelope_without_internals(client, op):
    r = await client.get(f"{API}/vessels/NOPE", headers=op)
    assert r.status_code == 404
    err = r.json()["error"]
    assert err["code"] == "not_found" and err["request_id"] and "Traceback" not in r.text
    r = await client.get(f"{API}/alarms?limit=abc", headers=op)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    assert r.headers["x-request-id"]


# ------------------------------------------------------------------ fleet
async def test_vessels_and_fleet_summary_reflect_ingested_data(client, op, container: Container):
    for eq in ("ME1", "GEN1", "COOL1", "BILGE1"):
        keys = {"ME1": "rpm", "GEN1": "power_output", "COOL1": "pressure", "BILGE1": "water_level"}
        from datetime import UTC, datetime

        await container.ingestion.process_batch(
            [sample(keys[eq], 10.0, datetime.now(UTC), equipment=eq)]
        )
    r = await client.get(f"{API}/vessels", headers=op)
    v1 = next(v for v in r.json() if v["code"] == "VES-001")
    assert (
        v1["communication"] == "online" and v1["health"] == "normal" and v1["equipment_count"] == 4
    )
    v2 = next(v for v in r.json() if v["code"] == "VES-002")
    assert v2["communication"] == "offline" and v2["health"] == "offline"
    summary = (await client.get(f"{API}/fleet/summary", headers=op)).json()
    assert summary["vessels_total"] == 2 and summary["communication"]["online"] == 1


async def test_vessel_detail_has_equipment_states_and_readings(client, op, container: Container):
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    await container.ingestion.process_batch(
        [sample("temperature", 82.0, now), state("RUNNING", now)]
    )
    body = (await client.get(f"{API}/vessels/VES-001", headers=op)).json()
    me1 = next(e for e in body["equipment"] if e["code"] == "ME1")
    assert me1["state"] == "RUNNING"
    temp = next(r for r in me1["readings"] if r["measurement"] == "temperature")
    assert (
        temp["value"] == 82.0
        and temp["unit"] == "°C"
        and temp["quality"] == "good"
        and not temp["stale"]
    )
    never = next(r for r in me1["readings"] if r["measurement"] == "rpm")
    assert (
        never["value"] is None and never["stale"] and never["quality"] == "stale"
    )  # missing != normal


async def test_stale_reading_is_flagged(client, op, container: Container):
    from datetime import UTC, datetime

    old = datetime.now(UTC) - timedelta(seconds=60)
    await container.ingestion.process_batch([sample("temperature", 82.0, old, received=old)])
    temp = next(
        r
        for r in (
            await client.get(f"{API}/telemetry/latest?vessel=VES-001&equipment=ME1", headers=op)
        ).json()
        if r["measurement"] == "temperature"
    )
    assert temp["stale"] and temp["quality"] == "stale" and temp["age_s"] >= 59


async def test_latest_filter_validation(client, op):
    assert (await client.get(f"{API}/telemetry/latest?vessel=NOPE", headers=op)).status_code == 404
    rows = (
        await client.get(f"{API}/telemetry/latest?vessel=VES-002&equipment=BILGE1", headers=op)
    ).json()
    assert [r["measurement"] for r in rows] == ["water_level"]


# ------------------------------------------------------------------ history
async def _seed_history(c: Container, n: int = 30) -> None:
    await feed_series(c, "temperature", [80.0 + i * 0.1 for i in range(n)])
    await feed_series(c, "rpm", [95.0 + i * 0.01 for i in range(n)])


def _q(**kw) -> str:
    base = {
        "vessel": "VES-001",
        "equipment": "ME1",
        "from": (T0 - timedelta(seconds=5)).isoformat().replace("+00:00", "Z"),
        "to": (T0 + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
    }
    base.update(kw)
    parts = []
    for k, v in base.items():
        for item in v if isinstance(v, list) else [v]:
            parts.append(f"{k}={item}")
    return "&".join(parts)


async def test_history_returns_stored_records_filtered_by_measurement(client, op, container):
    await _seed_history(container)
    r = (
        await client.get(f"{API}/telemetry/history?{_q(measurement='temperature')}", headers=op)
    ).json()
    assert len(r["items"]) == 30 and {i["measurement"] for i in r["items"]} == {"temperature"}
    assert r["units"] == {"temperature": "°C"} and not r["truncated"]
    assert r["items"][0]["ts"].startswith("2026-03-01T12:00:00")
    both = (await client.get(f"{API}/telemetry/history?{_q()}", headers=op)).json()
    assert len(both["items"]) == 60  # all measurements of the equipment


async def test_history_keyset_pagination_visits_every_row_once(client, op, container):
    await _seed_history(container)
    seen, cursor, pages = [], None, 0
    while True:
        url = f"{API}/telemetry/history?{_q(limit=7)}" + (f"&cursor={cursor}" if cursor else "")
        page = (await client.get(url, headers=op)).json()
        pages += 1
        seen += [(i["ts"], i["measurement"]) for i in page["items"]]
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 60 == len(set(seen)) and pages == 9 and seen == sorted(seen)


async def test_history_time_range_is_inclusive_and_empty_range_is_ok(client, op, container):
    await _seed_history(container)
    r = (
        await client.get(
            f"{API}/telemetry/history?"
            + _q(
                **{
                    "from": "2026-03-01T12:00:10Z",
                    "to": "2026-03-01T12:00:12Z",
                    "measurement": "temperature",
                }
            ),
            headers=op,
        )
    ).json()
    assert len(r["items"]) == 3
    empty = await client.get(
        f"{API}/telemetry/history?"
        + _q(**{"from": "2025-01-01T00:00:00Z", "to": "2025-01-01T01:00:00Z"}),
        headers=op,
    )
    assert empty.status_code == 200 and empty.json()["items"] == []


async def test_history_buckets_aggregate_stored_values(client, op, container):
    await _seed_history(container)
    r = (
        await client.get(
            f"{API}/telemetry/history?{_q(measurement='temperature', bucket_s=10)}", headers=op
        )
    ).json()
    assert r["items"] == [] and len(r["buckets"]) == 3
    first = r["buckets"][0]
    assert (
        first["samples"] == 10
        and first["min"] == pytest.approx(80.0)
        and first["max"] == pytest.approx(80.9)
    )


@pytest.mark.parametrize(
    ("params", "code"),
    [
        ({"from": "2026-03-01T12:10:00Z", "to": "2026-03-01T12:00:00Z"}, "invalid_range"),
        ({"from": "2026-03-01T12:00:00", "to": "2026-03-01T12:10:00"}, "naive_datetime"),
        ({"measurement": "bogus"}, "unknown_measurement"),
        ({"cursor": "!!!"}, "invalid_cursor"),
        (
            {"bucket_s": 1, "from": "2026-01-01T00:00:00Z", "to": "2026-03-01T00:00:00Z"},
            "too_many_buckets",
        ),
    ],
)
async def test_history_rejects_invalid_requests_with_useful_errors(client, op, params, code):
    r = await client.get(f"{API}/telemetry/history?{_q(**params)}", headers=op)
    assert r.status_code == 422 and r.json()["error"]["code"] == code


async def test_history_unknown_vessel_or_equipment_is_404_and_missing_params_422(client, op):
    assert (
        await client.get(f"{API}/telemetry/history?{_q(vessel='X')}", headers=op)
    ).status_code == 404
    assert (
        await client.get(f"{API}/telemetry/history?{_q(equipment='X')}", headers=op)
    ).status_code == 404
    assert (
        await client.get(f"{API}/telemetry/history?vessel=VES-001", headers=op)
    ).status_code == 422
    assert (
        await client.get(f"{API}/telemetry/history?{_q(limit=0)}", headers=op)
    ).status_code == 422


# ------------------------------------------------------------------ alarms
async def _raise_temp_alarm(c: Container, start=T0) -> None:
    await feed_series(c, "temperature", [97.0] * 8, start=start)


async def test_alarm_list_filters_and_details(client, op, container: Container):
    await _raise_temp_alarm(container)
    await feed_series(container, "pressure", [1.0] * 5, equipment="COOL1", vessel="VES-002")
    all_ = (await client.get(f"{API}/alarms", headers=op)).json()
    assert all_["total"] == 2
    crit = (await client.get(f"{API}/alarms?severity=critical", headers=op)).json()
    assert [a["rule"]["code"] for a in crit["items"]] == [
        "COOL_PRESS_LOW_LOW",
    ] or crit["total"] >= 1
    by_vessel = (await client.get(f"{API}/alarms?vessel=VES-001", headers=op)).json()
    assert {a["vessel_code"] for a in by_vessel["items"]} == {"VES-001"}
    by_eq = (await client.get(f"{API}/alarms?vessel=VES-001&equipment=ME1", headers=op)).json()
    assert by_eq["total"] == 1 and by_eq["items"][0]["measurement"] == "temperature"
    states = (
        await client.get(f"{API}/alarms?state=active_unacknowledged&open=true", headers=op)
    ).json()
    assert states["total"] == 2
    assert (await client.get(f"{API}/alarms?open=false", headers=op)).json()["total"] == 0
    paged = (await client.get(f"{API}/alarms?limit=1&offset=1", headers=op)).json()
    assert len(paged["items"]) == 1 and paged["total"] == 2
    ranged = (
        await client.get(
            f"{API}/alarms?from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z", headers=op
        )
    ).json()
    assert ranged["total"] == 0
    assert (
        await client.get(
            f"{API}/alarms?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z", headers=op
        )
    ).status_code == 422
    assert (await client.get(f"{API}/alarms?severity=bogus", headers=op)).status_code == 422
    assert (await client.get(f"{API}/alarms?vessel=NOPE", headers=op)).status_code == 404

    a = by_eq["items"][0]
    detail = (await client.get(f"{API}/alarms/{a['id']}", headers=op)).json()
    assert (
        detail["state"] == "active_unacknowledged"
        and detail["condition_active"]
        and not detail["acknowledged"]
    )
    assert [e["event_type"] for e in detail["events"]] == ["raised"]
    assert (
        detail["threshold"] == 95.0 and detail["trigger_value"] == 97.0 and detail["unit"] == "°C"
    )
    assert (await client.get(f"{API}/alarms/99999", headers=op)).status_code == 404


async def test_acknowledge_is_audited_and_distinct_from_clearing(client, op, container: Container):
    await _raise_temp_alarm(container)
    alarm_id = (await client.get(f"{API}/alarms", headers=op)).json()["items"][0]["id"]
    r = await client.post(
        f"{API}/alarms/{alarm_id}/acknowledge", headers=op, json={"note": "checking cooling"}
    )
    body = r.json()
    assert r.status_code == 200 and body["state"] == "active_acknowledged"
    assert (
        body["acknowledged_by"] == "operator"
        and body["acknowledged_at"]
        and body["condition_active"]
    )
    ack_event = body["events"][-1]
    assert (ack_event["event_type"], ack_event["actor"], ack_event["note"]) == (
        "acknowledged",
        "operator",
        "checking cooling",
    )
    # second ack -> conflict, no extra audit row
    r2 = await client.post(f"{API}/alarms/{alarm_id}/acknowledge", headers=op)
    assert r2.status_code == 409 and r2.json()["error"]["code"] == "alarm_already_acknowledged"
    assert len((await client.get(f"{API}/alarms/{alarm_id}", headers=op)).json()["events"]) == 2
    # condition recovers -> alarm closes (it was acknowledged before clearing)
    await feed_series(container, "temperature", [80.0] * 8, start=T0 + timedelta(seconds=30))
    closed = (await client.get(f"{API}/alarms/{alarm_id}", headers=op)).json()
    assert (
        closed["state"] == "cleared" and not closed["condition_active"] and closed["acknowledged"]
    )
    assert [e["event_type"] for e in closed["events"]] == ["raised", "acknowledged", "cleared"]
    r3 = await client.post(f"{API}/alarms/{alarm_id}/acknowledge", headers=op)
    assert r3.status_code == 409
    assert (await client.get(f"{API}/alarms?open=false", headers=op)).json()["total"] == 1


async def test_cleared_unacknowledged_alarm_needs_explicit_ack(client, op, container: Container):
    await _raise_temp_alarm(container)
    await feed_series(container, "temperature", [80.0] * 8, start=T0 + timedelta(seconds=30))
    alarm = (await client.get(f"{API}/alarms", headers=op)).json()["items"][0]
    assert (
        alarm["state"] == "cleared_unacknowledged"
        and not alarm["condition_active"]
        and not alarm["acknowledged"]
    )
    assert (
        alarm["acknowledged_by"] is None
    )  # clearing must never look like an operator acknowledgement
    ack = (await client.post(f"{API}/alarms/{alarm['id']}/acknowledge", headers=op)).json()
    assert ack["state"] == "cleared" and ack["acknowledged_by"] == "operator"


async def test_acknowledge_unknown_alarm_is_404_and_failed_ack_does_not_corrupt_state(
    client, op, container, monkeypatch
):
    assert (await client.post(f"{API}/alarms/424242/acknowledge", headers=op)).status_code == 404
    await _raise_temp_alarm(container)
    alarm_id = (await client.get(f"{API}/alarms", headers=op)).json()["items"][0]["id"]
    real = container.alarms.persist

    async def boom(*a, **kw):
        raise ConnectionError("database unavailable")

    monkeypatch.setattr(container.alarms, "persist", boom)
    r = await client.post(f"{API}/alarms/{alarm_id}/acknowledge", headers=op)
    assert r.status_code == 503 and r.json()["error"]["code"] == "database_unavailable"
    monkeypatch.setattr(container.alarms, "persist", real)
    # the engine rolled back: acknowledging again works and is recorded exactly once
    ok = await client.post(f"{API}/alarms/{alarm_id}/acknowledge", headers=op)
    assert ok.status_code == 200
    assert [e["event_type"] for e in ok.json()["events"]].count("acknowledged") == 1


async def test_alarm_rules_are_exposed_read_only(client, op):
    rules = (await client.get(f"{API}/alarm-rules", headers=op)).json()
    codes = {r["code"] for r in rules}
    assert {
        "ME_TEMP_HIGH",
        "ME_VIB_HIGH",
        "COOL_PRESS_LOW",
        "BILGE_LEVEL_HIGH",
        "SENSOR_QUALITY",
        "SOURCE_COMM_LOSS",
    } <= codes
    assert (await client.post(f"{API}/alarm-rules", headers=op, json={})).status_code == 405


async def test_communication_loss_alarm_via_tick_and_recovery(client, op, container: Container):
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    await container.alarms.tick(now + timedelta(seconds=30))
    comm = (await client.get(f"{API}/alarms?state=active_unacknowledged", headers=op)).json()[
        "items"
    ]
    assert len(comm) == 8 and all(
        a["kind"] == "communication" for a in comm
    )  # 4 equipment x 2 vessels
    await container.alarms.tick(now + timedelta(seconds=31))
    assert (await client.get(f"{API}/alarms", headers=op)).json()["total"] == 8  # no duplicates


# ------------------------------------------------------------------ incidents
async def test_incident_window_returns_series_states_alarm_events_and_gaps(
    client, op, container: Container
):
    await container.ingestion.process_batch([state("RUNNING", T0 - timedelta(seconds=30))])
    await feed_series(container, "temperature", [97.0] * 8)
    await feed_series(
        container,
        "temperature",
        [97.0, 80.0, 80.0, 80.0, 80.0, 80.0, 80.0, 80.0],
        start=T0 + timedelta(seconds=60),
    )  # 52 s hole between the two runs
    await container.ingestion.process_batch([state("DEGRADED", T0 + timedelta(seconds=3))])
    r = await client.get(
        f"{API}/incidents/window?"
        + _q(
            measurement="temperature",
            **{"from": "2026-03-01T11:59:50Z", "to": "2026-03-01T12:02:30Z"},
        ),
        headers=op,
    )
    body = r.json()
    assert r.status_code == 200 and body["point_count"] == 16
    assert body["series"][0]["measurement"] == "temperature" and body["series"][0]["unit"] == "°C"
    assert body["state_at_start"] == "RUNNING" or any(
        s["state"] == "RUNNING" for s in body["state_changes"]
    )
    assert [s["state"] for s in body["state_changes"]][-1] == "DEGRADED"
    types = [e["event_type"] for e in body["alarm_events"]]
    assert "raised" in types and "cleared" in types
    assert len(body["gaps"]) == 1 and body["gaps"][0]["seconds"] > 50
    assert len(body["alarms"]) == 1


async def test_incident_window_empty_and_too_large_and_invalid(client, op):
    empty = await client.get(
        f"{API}/incidents/window?"
        + _q(**{"from": "2020-01-01T00:00:00Z", "to": "2020-01-01T00:10:00Z"}),
        headers=op,
    )
    body = empty.json()
    assert empty.status_code == 200 and body["point_count"] == 0 and body["first_ts"] is None
    big = await client.get(
        f"{API}/incidents/window?"
        + _q(**{"from": "2020-01-01T00:00:00Z", "to": "2020-01-02T00:00:00Z"}),
        headers=op,
    )
    assert big.status_code == 422 and big.json()["error"]["code"] == "window_too_large"
    bad = await client.get(
        f"{API}/incidents/window?"
        + _q(**{"from": "2020-01-01T00:10:00Z", "to": "2020-01-01T00:00:00Z"}),
        headers=op,
    )
    assert bad.status_code == 422


async def test_incident_for_alarm_centres_on_the_alarm(client, op, container: Container):
    await feed_series(container, "temperature", [80.0] * 30, start=T0 - timedelta(seconds=30))
    await _raise_temp_alarm(container)
    await feed_series(container, "temperature", [80.0] * 8, start=T0 + timedelta(seconds=30))
    alarm = (await client.get(f"{API}/alarms", headers=op)).json()["items"][0]
    r = (
        await client.get(f"{API}/incidents/alarm/{alarm['id']}?before_s=20&after_s=20", headers=op)
    ).json()
    assert r["focus_alarm_id"] == alarm["id"]
    assert r["from"].startswith("2026-03-01T11:59:45") and r["point_count"] > 20
    pts = next(s for s in r["series"] if s["measurement"] == "temperature")["points"]
    assert pts[0]["ts"] >= r["from"] and pts[-1]["ts"] <= r["to"]
    assert (await client.get(f"{API}/incidents/alarm/999999", headers=op)).status_code == 404


async def test_recent_events_feed_merges_sources(client, op, container: Container):
    await _raise_temp_alarm(container)
    await container._record_system_event(
        "opcua_disconnected", "warning", "OPC UA connection lost", {}
    )
    events = (await client.get(f"{API}/events/recent?limit=10", headers=op)).json()
    kinds = {e["type"] for e in events}
    assert {"alarm", "system"} <= kinds
    assert [e["at"] for e in events] == sorted((e["at"] for e in events), reverse=True)
    assert any(e["vessel_code"] == "VES-001" for e in events if e["type"] == "alarm")


# ------------------------------------------------------------------ anomaly detection API
async def test_anomaly_endpoint_reports_insufficient_data_then_detects_combined_drift(
    client, op, container
):
    import random
    from datetime import UTC, datetime

    r = (await client.get(f"{API}/anomalies/VES-001", headers=op)).json()
    assert r["status"] == "insufficient_data" and r["disclaimer"] and r["equipment_code"] == "ME1"
    # store 8 minutes of realistic data: stable, then vibration + temperature drift together
    rnd = random.Random(3)
    now = datetime.now(UTC)
    start = now - timedelta(seconds=480)
    batch = []
    for i in range(480):
        drift = max(0, i - 400)
        ts = start + timedelta(seconds=i)
        batch.append(sample("vibration", 3.0 + rnd.gauss(0, 0.15) + drift * 0.03, ts, received=ts))
        batch.append(
            sample("temperature", 82.0 + rnd.gauss(0, 0.3) + drift * 0.02, ts, received=ts)
        )
    for i in range(0, len(batch), 200):
        await container.ingestion.process_batch(batch[i : i + 200])
    r = (await client.get(f"{API}/anomalies/VES-001", headers=op)).json()
    assert r["status"] == "anomaly" and r["score"] >= 0.6 and not r["alarm_active"]
    assert "Combined drift" in r["explanation"] and r["features"]["vibration_z"] > 3
    allv = (await client.get(f"{API}/anomalies", headers=op)).json()
    assert {a["vessel_code"] for a in allv} == {"VES-001", "VES-002"}
    assert (await client.get(f"{API}/anomalies/NOPE", headers=op)).status_code == 404
    assert (await client.get(f"{API}/anomalies/VES-001")).status_code == 401


async def test_anomaly_not_applicable_when_engine_stopped(client, op, container):
    from datetime import UTC, datetime

    await container.ingestion.process_batch([state("STOPPED", datetime.now(UTC))])
    resp = await client.get(f"{API}/anomalies/VES-001", headers=op)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "not_applicable"
