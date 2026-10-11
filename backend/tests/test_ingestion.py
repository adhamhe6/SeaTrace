"""Telemetry ingestion: persistence, idempotency, ordering, validation and data-quality handling."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest
from app.container import Container
from sqlalchemy import text

from tests.helpers import BAD_SENSOR_FAILURE, T0, UNCERTAIN, feed_series, sample, scalar, state


async def test_sample_is_persisted_with_source_and_ingestion_timestamps(container: Container):
    received = datetime.now(UTC)
    await container.ingestion.process_batch([sample("temperature", 81.5, T0, received=received)])
    row = (
        await container.telemetry.history(
            vessel="VES-001",
            equipment="ME1",
            measurements=["temperature"],
            time_from=T0 - timedelta(seconds=1),
            time_to=T0 + timedelta(seconds=1),
            limit=10,
            cursor=None,
            bucket_s=None,
        )
    ).items
    assert [(p.value, p.quality.value) for p in row] == [(81.5, "good")]
    assert row[0].ts == T0  # source timestamp preserved, not replaced by "now"
    ingested = await scalar(container, "SELECT ingested_ts FROM telemetry LIMIT 1")
    assert ingested == received and ingested != T0
    assert container.ingestion.stats["accepted"] == 1


async def test_duplicates_are_idempotent(container: Container):
    s = sample("rpm", 95.0, T0)
    await container.ingestion.process_batch([s])
    await container.ingestion.process_batch([s])  # re-delivery, e.g. after re-subscription
    await container.ingestion.process_batch([s, s])  # duplicate inside one batch
    assert await scalar(container, "SELECT count(*) FROM telemetry") == 1
    assert container.ingestion.stats["duplicates"] == 3


async def test_database_constraint_catches_duplicates_the_memory_filter_misses(
    container: Container,
):
    """A fresh process (empty in-memory state) must still not duplicate rows."""
    await container.ingestion.process_batch([sample("rpm", 95.0, T0)])
    container.ingestion._prep_ts.clear()
    container.ingestion._last_ts.clear()
    await container.ingestion.process_batch([sample("rpm", 95.0, T0)])
    assert await scalar(container, "SELECT count(*) FROM telemetry") == 1


async def test_out_of_order_samples_are_stored_but_do_not_replace_latest(container: Container):
    await container.ingestion.process_batch([sample("rpm", 100.0, T0 + timedelta(seconds=10))])
    await container.ingestion.process_batch([sample("rpm", 90.0, T0 + timedelta(seconds=5))])
    assert await scalar(container, "SELECT count(*) FROM telemetry") == 2
    latest = container.fleet.latest("VES-001", "ME1")
    rpm = next(r for r in latest if r.measurement == "rpm")
    assert rpm.value == 100.0 and rpm.source_ts == T0 + timedelta(seconds=10)
    assert container.ingestion.stats["late"] == 1


@pytest.mark.parametrize(
    ("value", "status", "quality", "stored_value"),
    [
        (float("nan"), 0, "invalid", None),
        (math.inf, 0, "invalid", None),
        ("not-a-number", 0, "invalid", None),
        (None, 0, "invalid", None),
        (
            9999.0,
            0,
            "invalid",
            9999.0,
        ),  # implausible: kept for forensics, flagged, never "normalised"
        (-50.0, 0, "invalid", -50.0),
        (50.0, BAD_SENSOR_FAILURE, "bad", None),
        (50.0, UNCERTAIN, "uncertain", 50.0),
    ],
)
async def test_invalid_values_are_flagged_never_zeroed(
    container, value, status, quality, stored_value
):
    await container.ingestion.process_batch([sample("temperature", value, T0, status=status)])
    async with container.engine.connect() as conn:
        row = (await conn.execute(text("SELECT quality, value FROM telemetry"))).one()
    assert (row[0], row[1]) == (quality, stored_value)


async def test_future_timestamps_are_rejected(container: Container):
    future = datetime.now(UTC) + timedelta(hours=1)
    await container.ingestion.process_batch([sample("rpm", 95.0, future)])
    assert await scalar(container, "SELECT count(*) FROM telemetry") == 0
    assert container.ingestion.stats["rejected_timestamp"] == 1


async def test_unknown_equipment_and_measurement_are_ignored(container: Container):
    await container.ingestion.process_batch(
        [sample("rpm", 1.0, T0, equipment="NOPE"), sample("does_not_exist", 1.0, T0)]
    )
    assert await scalar(container, "SELECT count(*) FROM telemetry") == 0
    assert container.ingestion.stats["unknown_node"] == 2


async def test_flat_lined_sensor_is_marked_stuck_but_duplicates_do_not_count(container: Container):
    n = container.settings.flatline_samples
    await feed_series(container, "temperature", [80.0] * (n + 3))
    qualities = await _qualities(container)
    assert qualities[: n - 1] == ["good"] * (n - 1)  # only flagged once the run is confirmed
    assert qualities[n - 1 :] == ["stuck"] * 4
    # Re-delivering identical (value, timestamp) pairs must not look like a flat line
    await container.ingestion.process_batch([sample("vibration", 3.0, T0)] * 30)
    assert "stuck" not in await _qualities(container, "vibration")


async def test_varying_signal_is_never_stuck(container: Container):
    await feed_series(container, "temperature", [80.0 + (i % 5) * 0.1 for i in range(40)])
    assert "stuck" not in await _qualities(container)


async def test_stopped_equipment_may_legitimately_flat_line(container: Container):
    await container.ingestion.process_batch([state("STOPPED", T0 - timedelta(seconds=1))])
    await feed_series(container, "rpm", [0.0] * 40)
    assert "stuck" not in await _qualities(container, "rpm")


async def _qualities(c: Container, key: str = "temperature") -> list[str]:
    from sqlalchemy import text

    async with c.engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT t.quality FROM telemetry t JOIN sensors s ON s.id = t.sensor_id "
                "WHERE s.key = :k AND t.equipment_id = 1 ORDER BY t.source_ts"
            ),
            {"k": key},
        )
        return [r[0] for r in rows]


async def test_equipment_state_changes_recorded_once(container: Container):
    await container.ingestion.process_batch([state("RUNNING", T0)])
    await container.ingestion.process_batch([state("RUNNING", T0 + timedelta(seconds=1))])
    await container.ingestion.process_batch([state("DEGRADED", T0 + timedelta(seconds=2))])
    assert await scalar(container, "SELECT count(*) FROM equipment_state_changes") == 2
    assert await scalar(container, "SELECT current_state FROM equipment WHERE id = 1") == "DEGRADED"


async def test_threshold_breach_creates_alarm_in_database(container: Container):
    await feed_series(container, "temperature", [97.0] * 8)
    row = await scalar(
        container, "SELECT state || '|' || severity || '|' || trigger_value FROM alarms"
    )
    assert row == "active_unacknowledged|warning|97"
    assert (
        await scalar(container, "SELECT count(*) FROM alarm_events WHERE event_type='raised'") == 1
    )


async def test_hysteresis_keeps_a_single_alarm_while_value_fluctuates(container: Container):
    values = [97, 97, 97, 97, 97, 97, 94, 96, 93, 97, 94, 97] * 3
    await feed_series(container, "temperature", [float(v) for v in values])
    assert await scalar(container, "SELECT count(*) FROM alarms") == 1
    assert await scalar(container, "SELECT count(*) FROM alarm_events") == 1


async def test_database_failure_is_retried_and_engine_state_stays_consistent(
    container: Container, monkeypatch
):
    calls = {"n": 0}
    real = container.ingestion._persist_batch

    async def flaky(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("db down")
        return await real(*a, **kw)

    monkeypatch.setattr(container.ingestion, "_persist_batch", flaky)
    await container.ingestion.process_batch([sample("temperature", 97.0, T0)])
    assert calls["n"] == 2 and container.ingestion.stats["db_failures"] == 1
    assert await scalar(container, "SELECT count(*) FROM telemetry") == 1
    assert container.ingestion.database_ok


async def test_batch_dropped_and_counted_after_repeated_database_failures(
    container: Container, monkeypatch
):
    async def always_fail(*a, **kw):
        raise ConnectionError("db down")

    monkeypatch.setattr(container.ingestion, "_persist_batch", always_fail)
    await container.ingestion.process_batch([sample("temperature", 97.0, T0)])
    assert container.ingestion.stats["dropped"] == 1
    assert container.ingestion.stats["db_failures"] == container.settings.ingest_db_retries
    assert not container.ingestion.database_ok


async def test_queue_overflow_drops_oldest_and_counts(container: Container):
    ing = container.ingestion
    ing._queue = type(ing._queue)(maxsize=3)
    for i in range(5):
        ing.submit(sample("rpm", float(i), T0 + timedelta(seconds=i)))
    assert ing.stats["dropped"] == 2 and ing._queue.qsize() == 3
    assert [ing._queue.get_nowait().value for _ in range(3)] == [2.0, 3.0, 4.0]


async def test_worker_consumes_submitted_samples_end_to_end(container: Container):
    for i in range(20):
        container.ingestion.submit(sample("rpm", 95.0 + i * 0.01, T0 + timedelta(seconds=i)))
    for _ in range(100):
        import asyncio

        if await scalar(container, "SELECT count(*) FROM telemetry") == 20:
            break
        await asyncio.sleep(0.05)
    assert await scalar(container, "SELECT count(*) FROM telemetry") == 20


async def test_history_and_latest_survive_backend_restart(container: Container, settings):
    from app.container import Container as C

    await feed_series(container, "temperature", [97.0] * 8)
    await container.ingestion.process_batch([state("DEGRADED", T0)])
    # simulate restart: new container on the same database
    fresh = C(settings)
    await fresh.start()
    try:
        temp = next(
            r for r in fresh.fleet.latest("VES-001", "ME1") if r.measurement == "temperature"
        )
        assert temp.value == 97.0 and temp.source_ts == T0 + timedelta(seconds=7)
        assert fresh.live.equipment[1].state == "DEGRADED"
        assert [a.state.value for a in fresh.alarm_engine.open_alarms()] == [
            "active_unacknowledged"
        ]
        # alarm condition continuing after restart does not create a duplicate
        await feed_series(fresh, "temperature", [98.0] * 5, start=T0 + timedelta(seconds=20))
        assert await scalar(fresh, "SELECT count(*) FROM alarms") == 1
    finally:
        await fresh.stop()
