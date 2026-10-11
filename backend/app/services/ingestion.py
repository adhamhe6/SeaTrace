r"""Telemetry ingestion pipeline.

    OPC UA client --submit()--> bounded queue --> worker --> validate/classify --> PostgreSQL (idempotent)
                                                         \--> alarm engine --> alarm tables  (same transaction)
                                                         \--> live cache + WebSocket hub (after commit)

Design points
* ``submit_*`` never blocks the OPC UA callback; when the queue is full the *oldest* item is dropped and counted.
* Source timestamps are preserved; ``ingested_ts`` is the backend receive time.
* ``(sensor_id, source_ts)`` is the idempotency key: duplicates (e.g. after re-subscription) are ignored.
* Out-of-order samples are stored in history but are not replayed into the alarm state machine.
* The database transaction contains telemetry + alarm transitions; on failure the alarm engine is rolled back to a
  snapshot and the batch is retried with bounded attempts before being dropped (and counted).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.schemas import IngestionStats
from app.config import Settings
from app.db import models as m
from app.domain.alarms import Sample
from app.domain.enums import Quality
from app.domain.quality import FlatlineDetector, classify
from app.domain.raw import RawSample, RawState
from app.logging import RateLimitedLogger
from app.realtime.hub import EventHub
from app.services.alarm_service import AlarmService, PersistedTransition
from app.services.catalog import Catalog, LiveState, Reading, SensorInfo

log = logging.getLogger(__name__)
_rl = RateLimitedLogger(log, 30.0)

_NO_FLATLINE_STATES = frozenset({"STOPPED", "TRIPPED"})


@dataclass(slots=True)
class _Processed:
    sensor: SensorInfo
    value: float | None
    quality: Quality
    source_ts: datetime
    received_at: datetime
    status_code: int | None


@dataclass(slots=True)
class _StateEvt:
    equipment_id: int
    state: str
    source_ts: datetime
    received_at: datetime


class IngestionService:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        catalog: Catalog,
        live: LiveState,
        alarms: AlarmService,
        hub: EventHub,
        settings: Settings,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._catalog = catalog
        self._live = live
        self._alarms = alarms
        self._hub = hub
        self._s = settings
        self._queue: asyncio.Queue[RawSample | RawState] = asyncio.Queue(
            maxsize=settings.ingest_queue_max
        )
        self._flatline = FlatlineDetector(settings.flatline_samples, timedelta(0))
        self._last_ts: dict[int, datetime] = {s: r.source_ts for s, r in live.readings.items()}
        self._prep_ts: dict[int, datetime] = dict(self._last_ts)  # newest ts seen by validation
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self.last_data_at: datetime | None = None
        self.stats: dict[str, int] = dict.fromkeys(
            (
                "received",
                "accepted",
                "duplicates",
                "late",
                "invalid",
                "bad",
                "stuck",
                "dropped",
                "rejected_timestamp",
                "db_failures",
                "unknown_node",
            ),
            0,
        )
        self.last_batch_at: datetime | None = None
        self.database_ok = True

    # ------------------------------------------------------------------ producer side
    def submit(self, item: RawSample | RawState) -> None:
        self.stats["received"] += 1
        if self._queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
                self.stats["dropped"] += 1
                _rl.log(logging.WARNING, "queue_full", "ingestion queue full; dropping oldest item")
        self._queue.put_nowait(item)

    def snapshot_stats(self) -> IngestionStats:
        s = self.stats
        return IngestionStats(
            queue_depth=self._queue.qsize(),
            received=s["received"],
            accepted=s["accepted"],
            duplicates=s["duplicates"],
            late=s["late"],
            invalid=s["invalid"],
            bad=s["bad"],
            stuck=s["stuck"],
            dropped=s["dropped"],
            rejected_timestamp=s["rejected_timestamp"],
            db_failures=s["db_failures"],
            last_batch_at=self.last_batch_at,
        )

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="ingestion-worker")

    async def stop(self) -> None:
        """Drain what is queued (bounded wait) and stop the worker."""
        self._stopping = True
        if self._task is None:
            return
        try:
            await asyncio.wait_for(self._task, timeout=10)
        except TimeoutError:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        while True:
            if self._stopping and self._queue.empty():
                return
            try:
                first = await asyncio.wait_for(self._queue.get(), timeout=0.1)
            except TimeoutError:
                continue
            batch = [first]
            deadline = asyncio.get_running_loop().time() + self._s.ingest_flush_interval_s
            while len(batch) < self._s.ingest_batch_max:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0 and self._queue.empty():
                    break
                try:
                    batch.append(
                        await asyncio.wait_for(self._queue.get(), timeout=max(remaining, 0.001))
                    )
                except TimeoutError:
                    break
            try:
                await self.process_batch(batch)
            except Exception:
                log.exception("unexpected failure while processing ingestion batch")

    # ------------------------------------------------------------------ processing
    def _prepare(
        self, items: list[RawSample | RawState]
    ) -> tuple[list[_Processed], list[_StateEvt]]:
        samples: list[_Processed] = []
        states: list[_StateEvt] = []
        now = datetime.now(UTC)
        max_future = timedelta(seconds=self._s.max_future_skew_s)
        for it in items:
            eq = self._catalog.equipment_by_code.get((it.vessel_code, it.equipment_code))
            if eq is None:
                self.stats["unknown_node"] += 1
                _rl.log(
                    logging.WARNING,
                    f"unknown:{it.vessel_code}.{it.equipment_code}",
                    "telemetry for unknown equipment ignored",
                    vessel=it.vessel_code,
                    equipment=it.equipment_code,
                )
                continue
            if isinstance(it, RawState):
                if it.kind == "sensor_health":
                    self._live.equipment_live(eq.id).sensor_health = (
                        str(it.value) if it.value else None
                    )
                    continue
                ts = it.source_ts or it.received_at
                if not isinstance(it.value, str) or not it.value:
                    self.stats["invalid"] += 1
                    continue
                states.append(_StateEvt(eq.id, it.value, ts, it.received_at))
                continue
            sensor = eq.sensors.get(it.key)
            if sensor is None:
                self.stats["unknown_node"] += 1
                _rl.log(
                    logging.WARNING,
                    f"unknown-sensor:{it.vessel_code}.{it.equipment_code}.{it.key}",
                    "telemetry for unknown measurement ignored",
                    measurement=it.key,
                )
                continue
            ts = it.source_ts or it.server_ts or it.received_at
            if ts > now + max_future:
                self.stats["rejected_timestamp"] += 1
                _rl.log(
                    logging.WARNING,
                    f"future:{sensor.id}",
                    "sample with timestamp in the future rejected",
                    sensor_id=sensor.id,
                )
                continue
            seen = self._prep_ts.get(sensor.id)
            if seen is not None and ts == seen:
                self.stats["duplicates"] += (
                    1  # e.g. initial value re-delivered after re-subscription
                )
                continue
            in_order = seen is None or ts > seen
            if in_order:
                self._prep_ts[sensor.id] = ts
            c = classify(it.value, it.status_code, sensor.plausible_min, sensor.plausible_max)
            quality, value = c.quality, c.value
            if not in_order:
                pass  # out-of-order: stored as-is, never feeds the flat-line detector
            elif quality is Quality.GOOD and sensor.flatline_check:
                live_state = self._live.equipment_live(eq.id).state
                if live_state in _NO_FLATLINE_STATES:
                    self._flatline.reset(sensor.id)
                elif self._flatline.observe(sensor.id, value, ts):
                    quality = Quality.STUCK
            elif quality is not Quality.GOOD:
                self._flatline.reset(sensor.id)
            if quality is Quality.INVALID:
                self.stats["invalid"] += 1
            elif quality is Quality.BAD:
                self.stats["bad"] += 1
            elif quality is Quality.STUCK:
                self.stats["stuck"] += 1
            samples.append(_Processed(sensor, value, quality, ts, it.received_at, it.status_code))
        return samples, states

    async def process_batch(self, items: list[RawSample | RawState]) -> None:
        samples, states = self._prepare(items)
        if not samples and not states:
            return
        fresh = samples  # exact duplicates were already dropped in _prepare; the DB constraint is the authority
        attempts = self._s.ingest_db_retries
        for attempt in range(1, attempts + 1):
            async with self._alarms.lock:
                snap = self._alarms.engine.snapshot()
                try:
                    result = await self._persist_batch(fresh, states)
                except Exception as exc:
                    self._alarms.engine.restore_snapshot(snap)
                    self.stats["db_failures"] += 1
                    self.database_ok = False
                    _rl.log(
                        logging.ERROR,
                        "db_batch",
                        "failed to persist telemetry batch",
                        attempt=attempt,
                        error=type(exc).__name__,
                    )
                else:
                    self.database_ok = True
                    self._after_commit(*result)
                    return
            if self._stopping:
                break
            await asyncio.sleep(min(self._s.ingest_db_retry_delay_s * attempt, 5.0))
        self.stats["dropped"] += len(fresh) + len(states)
        log.error(
            "telemetry batch dropped after repeated database failures",
            extra={"samples": len(fresh), "states": len(states)},
        )

    async def _persist_batch(
        self, fresh: list[_Processed], states: list[_StateEvt]
    ) -> tuple[list[_Processed], list[_StateEvt], list[PersistedTransition]]:
        inserted: list[_Processed] = []
        changed_states: list[_StateEvt] = []
        persisted: list[PersistedTransition] = []
        async with self._sessionmaker() as session, session.begin():
            if fresh:
                rows = [
                    {
                        "sensor_id": p.sensor.id,
                        "equipment_id": p.sensor.equipment_id,
                        "source_ts": p.source_ts,
                        "ingested_ts": p.received_at,
                        "value": p.value,
                        "quality": p.quality.value,
                        "status_code": p.status_code,
                    }
                    for p in fresh
                ]
                res = await session.execute(
                    insert(m.Telemetry)
                    .values(rows)
                    .on_conflict_do_nothing(index_elements=["sensor_id", "source_ts"])
                    .returning(m.Telemetry.sensor_id, m.Telemetry.source_ts)
                )
                keys = {(r[0], r[1]) for r in res}
                inserted = [p for p in fresh if (p.sensor.id, p.source_ts) in keys]
                self.stats["duplicates"] += len(fresh) - len(inserted)
            for st in sorted(states, key=lambda s: s.source_ts):
                live = self._live.equipment_live(st.equipment_id)
                if live.state == st.state or (live.state_ts and st.source_ts < live.state_ts):
                    continue
                res = await session.execute(
                    insert(m.EquipmentStateChange)
                    .values(
                        equipment_id=st.equipment_id,
                        state=st.state,
                        source_ts=st.source_ts,
                        ingested_ts=st.received_at,
                    )
                    .on_conflict_do_nothing(constraint="uq_state_changes_equipment_ts")
                    .returning(m.EquipmentStateChange.id)
                )
                if res.first() is not None:
                    await session.execute(
                        update(m.Equipment)
                        .where(m.Equipment.id == st.equipment_id)
                        .values(current_state=st.state, state_since=st.source_ts)
                    )
                    changed_states.append(st)
                    live.state, live.state_ts = st.state, st.source_ts  # visible to flatline logic
            # Alarm evaluation in source-time order, only for rows that were actually new.
            transitions = []
            for p in sorted(inserted, key=lambda x: x.source_ts):
                eq = self._catalog.equipment_by_id[p.sensor.equipment_id]
                transitions += self._alarms.engine.evaluate_sample(
                    Sample(
                        equipment_id=eq.id,
                        equipment_type=eq.type,
                        equipment_name=eq.name,
                        sensor_id=p.sensor.id,
                        key=p.sensor.key,
                        sensor_name=p.sensor.name,
                        unit=p.sensor.unit,
                        value=p.value,
                        quality=p.quality,
                        source_ts=p.source_ts,
                        received_at=p.received_at,
                    )
                )
            if transitions:
                persisted = await self._alarms.persist(session, transitions)
        return inserted, changed_states, persisted

    def _after_commit(
        self,
        inserted: list[_Processed],
        states: list[_StateEvt],
        persisted: list[PersistedTransition],
    ) -> None:
        now = datetime.now(UTC)
        self.last_batch_at = now
        items = []
        for p in inserted:
            prev = self._last_ts.get(p.sensor.id)
            if prev is not None and p.source_ts <= prev:
                self.stats["late"] += 1  # historical backfill; stored but not "latest"
                continue
            self._last_ts[p.sensor.id] = p.source_ts
            self._live.readings[p.sensor.id] = Reading(
                p.sensor.id, p.value, p.quality, p.source_ts, p.received_at
            )
            self._live.equipment_live(p.sensor.equipment_id).last_fresh = p.received_at
            eq = self._catalog.equipment_by_id[p.sensor.equipment_id]
            items.append(
                {
                    "vessel_code": eq.vessel_code,
                    "equipment_code": eq.code,
                    "measurement": p.sensor.key,
                    "unit": p.sensor.unit,
                    "value": p.value,
                    "quality": p.quality.value,
                    "source_ts": p.source_ts.isoformat(),
                    "ingested_ts": p.received_at.isoformat(),
                }
            )
        self.stats["accepted"] += len(items)
        if items:
            self.last_data_at = now
            self._hub.publish("telemetry", {"items": items})
        for st in states:
            eq = self._catalog.equipment_by_id[st.equipment_id]
            self._hub.publish(
                "equipment_state",
                {
                    "vessel_code": eq.vessel_code,
                    "equipment_code": eq.code,
                    "state": st.state,
                    "source_ts": st.source_ts.isoformat(),
                },
            )
        self._alarms.publish(persisted)
