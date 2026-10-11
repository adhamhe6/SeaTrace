# Testing

| Layer | Tool | Location | Needs |
|---|---|---|---|
| C++ simulator + OPC UA | GoogleTest / CTest | `simulator/tests` | CMake, g++ ≥ 11, OpenSSL dev headers |
| Backend unit + API + DB | pytest, pytest-asyncio, HTTPX | `backend/tests` | PostgreSQL (any 14+; a dedicated database is created and dropped) |
| Backend integration (real simulator) | pytest | `backend/tests/integration` | the built simulator binary |
| Frontend | Vitest + React Testing Library | `frontend/src/**/*.test.*` | Node 22 |
| Browser e2e | Playwright | `frontend/e2e` | a running stack (Compose or `scripts/dev-stack.sh`) |
| Black-box smoke | `scripts/smoke_test.py` | – | a running stack |

## Running

```bash
# simulator
cmake -S simulator -B simulator/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build simulator/build && ctest --test-dir simulator/build --output-on-failure

# backend (PostgreSQL reachable with a role that may CREATE DATABASE)
cd backend && uv sync
export SEATRACE_TEST_DATABASE_URL=postgresql+asyncpg://seatrace:seatrace@localhost:5432/postgres   # admin URL, default shown
uv run pytest -q                      # unit + API + migrations (+ integration if the simulator binary exists)
uv run pytest -q -m "not integration" # without the simulator
uv run ruff check app tests scripts && uv run ruff format --check app tests scripts migrations && uv run mypy

# frontend
cd frontend && npm ci && npm run lint && npm run typecheck && npm test && npm run build

# browser e2e + smoke (stack must be running)
scripts/dev-stack.sh start            # or: docker compose up --build -d --wait
python3 scripts/smoke_test.py --base http://localhost:8000
cd frontend && E2E_OPERATOR_PASSWORD=... npm run e2e
```

**Isolation.** The backend suite connects to the *admin* URL only to `CREATE DATABASE seatrace_test_<random>`, applies the
real Alembic migrations to it, truncates tables between tests and `DROP DATABASE … WITH (FORCE)` at the end. It never touches
any other database. Tests use `Settings(env="test", opcua_enabled=False)` unless they explicitly start an OPC UA server, and
those servers bind random free ports on 127.0.0.1.

**No arbitrary sleeps.** Asynchronous expectations use `eventually(predicate, timeout)` polling (backend) or deterministic
injection (`process_batch`, `alarms.tick(now)` with an explicit clock). Time-dependent alarm logic is tested with explicit timestamps.

## What is covered where (failure modes → tests)

| Requirement | Test(s) |
|---|---|
| OPC UA server unavailable at backend start | `test_opcua_client.py::test_backend_starts_while_simulator_is_down_and_connects_later` |
| Disconnect during operation, reconnect, no duplicate subscription | `test_reconnects_after_server_outage_without_duplicate_subscriptions`; integration `test_opcua_outage_is_reported_and_backend_reconnects` (real C++ server stop/start) |
| Communication loss → alarm → recovery | `test_outage_produces_communication_alarm_and_recovery_clears_it`; integration `test_telemetry_interruption_marks_stale_raises_comm_alarm_and_recovers` |
| Duplicate measurements | `test_ingestion.py::test_duplicates_are_idempotent`, `…database_constraint_catches_duplicates…`; integration (no duplicate `(sensor, source_ts)` after reconnect) |
| Out-of-order messages | `test_out_of_order_samples_are_stored_but_do_not_replace_latest`, alarm engine `…late_and_duplicate_samples…` |
| Missing / invalid values (NaN, non-numeric, Bad status, implausible, future timestamp) | `test_invalid_values_are_flagged_never_zeroed` (8 cases), `test_future_timestamps_are_rejected`, `test_quality.py` |
| Stale readings | `test_stale_reading_is_flagged`, `test_vessel_detail_has_equipment_states_and_readings` (never-seen sensor is stale, not 0) |
| Stuck sensor | `test_flat_lined_sensor_is_marked_stuck…`, OPC UA `test_stuck_sensor_detected…`, integration `test_stuck_and_out_of_range_sensor_scenarios_are_detected` |
| Backend restart | `test_history_and_latest_survive_backend_restart` |
| Database temporarily unavailable | `test_database_failure_is_retried…`, `test_batch_dropped_and_counted_after_repeated_database_failures`, `test_database_outage_gives_503_not_ready_and_recovers` |
| Empty history queries | `test_history_time_range_is_inclusive_and_empty_range_is_ok`, `test_incident_window_empty_and_too_large_and_invalid` |
| Failed acknowledgement | `test_acknowledge_unknown_alarm_is_404_and_failed_ack_does_not_corrupt_state`, double-ack → 409 |
| Failed scenario control | 503 when simulator down, 409 when rejected, 422/404 validation (`test_opcua_client.py` control tests) |
| WebSocket drop / resume / slow client | `test_hub_ws.py` (real uvicorn + `websockets` client) |
| Invalid requests, unauthorized operations | `test_api_core.py` (401/403/422/404/429, expired and forged tokens, CORS) |
| Alarm activation, dedup, hysteresis, persistence, ack/clear interaction, audit | `test_alarm_engine.py` (19 pure tests) + API-level `test_acknowledge_is_audited…`, `test_cleared_unacknowledged_alarm_needs_explicit_ack` |
| Migrations | `test_migrations.py` – clean DB → head, no model drift, downgrade → base, constraints enforced by the database |
| Secure OPC UA | integration `test_secure_mode_signed_and_encrypted_channel_and_untrusted_client_rejected` |
| Full path simulator → OPC UA → backend → PostgreSQL → API → alarm → ack → replay | integration `test_full_pipeline.py` (8 tests) and `scripts/smoke_test.py` |
| UI reflects real measurement; alarm ack in UI; replay in UI | Playwright `frontend/e2e` against the running stack |

## Recorded results (development run)

| Suite | Result |
|---|---|
| Simulator `ctest` | 146 / 146 |
| Backend `pytest` (incl. 8 integration tests with the real simulator) | 170 / 170, 95 % line coverage of `app/` |
| Frontend `vitest` | 278 / 278 (93.6 % statements) |
| Playwright e2e against the Docker Compose stack (via nginx) | 5 / 5 |
| `scripts/smoke_test.py` against the Compose stack | `SMOKE OK` |
| Manual resilience checks on the Compose stack | backend restart (alarms/history intact, OPC UA reconnect), `docker compose stop db` → API 503 / readiness 503 / liveness 200, recovery after `start db`; `opcua_outage` in secure mode → `backoff` → reconnected with exactly 38 monitored items |

## Known gaps
* The Docker Compose workflow is exercised by the CI `compose` job and by manual runs; it is not part of the pytest suite.
* Load/soak testing was not performed beyond multi-minute runs at 1 Hz × 20 sensors.
