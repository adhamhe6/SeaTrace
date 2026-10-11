#!/usr/bin/env python3
"""Black-box smoke test of a running SeaTrace stack (Docker Compose or scripts/dev-stack.sh).

It exercises the real pipeline through the public HTTP API only:
    login -> live telemetry present -> fault injection -> alarm -> acknowledge -> clear -> incident replay data

Usage:  scripts/smoke_test.py [--base http://localhost:8080] [--env-file .env]
Credentials come from the environment (SEATRACE_DEMO_OPERATOR_USERNAME/PASSWORD) or the .env file.
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


class Api:
    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.token: str | None = None

    def call(self, method: str, path: str, body: dict | None = None, expect: tuple[int, ...] = (200,)) -> dict | list:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.base}/api/v1{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310
                status, payload = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            status, payload = exc.code, exc.read()
        if status not in expect:
            raise SystemExit(f"FAIL {method} {path}: HTTP {status} {payload[:300]!r}")
        return json.loads(payload) if payload else {}


def wait(what: str, predicate, timeout: float, interval: float = 1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = predicate()
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            result = None
        if result:
            return result
        time.sleep(interval)
    raise SystemExit(f"FAIL timeout ({timeout:.0f}s) waiting for: {what}")


def step(msg: str) -> None:
    print(f"  - {msg}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=f"http://localhost:{os.environ.get('SEATRACE_HTTP_PORT', '8080')}")
    ap.add_argument("--env-file", default=str(Path(__file__).resolve().parents[1] / ".env"))
    args = ap.parse_args()
    env = {**load_env(Path(args.env_file)), **os.environ}
    user = env.get("SEATRACE_DEMO_OPERATOR_USERNAME", "operator")
    password = env.get("SEATRACE_DEMO_OPERATOR_PASSWORD", "")
    if not password:
        raise SystemExit("operator password not configured (SEATRACE_DEMO_OPERATOR_PASSWORD)")

    api = Api(args.base)
    print(f"SeaTrace smoke test against {args.base}")
    wait("web UI + API ready", lambda: api.call("GET", "/health/ready").get("status") == "ready", 180)
    step("API is ready")
    api.call("POST", "/auth/login", {"username": user, "password": "definitely-wrong"}, expect=(401,))
    api.token = api.call("POST", "/auth/login", {"username": user, "password": password})["access_token"]
    step("login works, bad password rejected")

    wait("OPC UA connected", lambda: api.call("GET", "/system/status")["opcua"]["state"] == "connected", 120)
    wait("both vessels online", lambda: all(v["communication"] == "online" for v in api.call("GET", "/vessels")), 120)
    latest = wait("20 live readings", lambda: (r := api.call("GET", "/telemetry/latest")) and len(r) == 20 and
                  all(x["value"] is not None for x in r) and r, 120)
    step(f"live telemetry flowing: {len(latest)} sensors, e.g. "
         f"{latest[0]['vessel_code']}/{latest[0]['equipment_code']} {latest[0]['measurement']}={latest[0]['value']} {latest[0]['unit']}")

    t0 = datetime.now(UTC)
    api.call("POST", "/simulator/scenarios/sensor_failure/activate", {"vessel_code": "VES-001"})
    step("fault injected: sensor_failure on VES-001")
    alarm = wait("SENSOR_QUALITY alarm", lambda: next((a for a in api.call("GET", "/alarms?open=true&vessel=VES-001")["items"]
                                                      if a["rule"]["code"] == "SENSOR_QUALITY"), None), 90)
    step(f"alarm #{alarm['id']} raised: {alarm['message']}")
    ack = api.call("POST", f"/alarms/{alarm['id']}/acknowledge", {"note": "smoke test"})
    assert ack["state"] == "active_acknowledged" and ack["acknowledged_by"] == user, ack
    step("alarm acknowledged (audit recorded)")
    api.call("POST", "/simulator/scenarios/sensor_failure/clear", {"vessel_code": "VES-001"})
    closed = wait("alarm closed", lambda: (a := api.call("GET", f"/alarms/{alarm['id']}"))["state"] == "cleared" and a, 90)
    assert [e["event_type"] for e in closed["events"]] == ["raised", "acknowledged", "cleared"], closed["events"]
    step("condition recovered, alarm closed; history: raised -> acknowledged -> cleared")
    inc = api.call("GET", f"/incidents/alarm/{alarm['id']}?before_s=30&after_s=30")
    pts = sum(len(s["points"]) for s in inc["series"])
    assert pts > 20 and inc["alarm_events"], inc["point_count"]
    first = datetime.fromisoformat(inc["first_ts"])
    assert first >= t0 - timedelta(seconds=120)
    step(f"incident replay data available: {pts} stored points, {len(inc['alarm_events'])} alarm events")
    print("SMOKE OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        sys.exit(f"FAIL assertion: {exc}")
