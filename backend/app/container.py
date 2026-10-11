"""Application container: owns long-lived components and their start-up / shut-down order."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.api.schemas import OpcUaStatus
from app.config import Settings
from app.db import models as m
from app.db.base import make_engine, make_sessionmaker
from app.domain.alarms import AlarmEngine
from app.opcua.client import ConnectionStatus, OpcUaSupervisor
from app.realtime.hub import EventHub
from app.services.alarm_service import AlarmService
from app.services.anomaly_service import AnomalyService
from app.services.catalog import Catalog, LiveState
from app.services.fleet_service import FleetService
from app.services.incident_service import IncidentService
from app.services.ingestion import IngestionService
from app.services.seed import run_seed
from app.services.simulator_service import SimulatorService
from app.services.telemetry_service import TelemetryService

log = logging.getLogger(__name__)


class Container:
    def __init__(self, settings: Settings, engine: AsyncEngine | None = None) -> None:
        self.settings = settings
        self.engine = engine or make_engine(
            settings.database_url,
            pool_size=settings.db_pool_size,
            connect_timeout_s=settings.db_connect_timeout_s,
            command_timeout_s=settings.db_command_timeout_s,
        )
        self.sessionmaker: async_sessionmaker[AsyncSession] = make_sessionmaker(self.engine)
        self.hub = EventHub(settings.ws_replay_buffer, settings.ws_client_queue_size)
        self.catalog = Catalog()
        self.live = LiveState()
        self.alarm_engine = AlarmEngine([])
        self.alarms: AlarmService
        self.ingestion: IngestionService
        self.supervisor: OpcUaSupervisor
        self.simulator: SimulatorService
        self.fleet: FleetService
        self.telemetry: TelemetryService
        self.incidents: IncidentService
        self.anomalies: AnomalyService
        self._tasks: list[asyncio.Task[None]] = []
        self._started = False

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        s = self.settings
        await self._wait_for_database()
        await run_seed(self.sessionmaker, s)
        async with self.sessionmaker() as session:
            self.catalog = await Catalog.load(session)
            await self.live.load(session, self.catalog)
        self.alarm_engine = AlarmEngine(list(self.catalog.rules.values()))
        self.alarms = AlarmService(self.sessionmaker, self.catalog, self.alarm_engine, self.hub)
        restored = await self.alarms.restore(datetime.now(UTC))
        self.ingestion = IngestionService(
            self.sessionmaker, self.catalog, self.live, self.alarms, self.hub, s
        )
        self.supervisor = OpcUaSupervisor(
            s, self.ingestion.submit, self._record_system_event, self._publish_status
        )
        self.simulator = SimulatorService(
            self.sessionmaker, self.supervisor, self.catalog, self.hub, s
        )
        self.fleet = FleetService(
            self.sessionmaker, self.catalog, self.live, self.alarms, self.supervisor, s
        )
        self.telemetry = TelemetryService(self.sessionmaker, self.catalog, s)
        self.incidents = IncidentService(self.sessionmaker, self.catalog, self.alarms, s)
        self.anomalies = AnomalyService(self.sessionmaker, self.catalog, self.live)
        self.ingestion.start()
        self._tasks.append(asyncio.create_task(self._alarm_ticker(), name="alarm-ticker"))
        if s.telemetry_retention_days > 0:
            self._tasks.append(asyncio.create_task(self._retention_loop(), name="retention"))
        self.supervisor.start()
        self._started = True
        log.info(
            "SeaTrace backend started",
            extra={"restored_alarms": restored, "opcua_enabled": s.opcua_enabled},
        )

    async def stop(self) -> None:
        """Shut down in reverse dependency order: producers, consumers, realtime, database."""
        if self._started:
            await self.supervisor.stop()
            for t in self._tasks:
                t.cancel()
            for t in self._tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await t
            await self.ingestion.stop()
            await self.hub.close()
        await self.engine.dispose()
        log.info("SeaTrace backend stopped")

    async def _wait_for_database(self, attempts: int = 30) -> None:
        for i in range(1, attempts + 1):
            try:
                async with self.engine.connect() as conn:
                    await conn.execute(text("SELECT 1"))
                return
            except Exception as exc:
                log.warning("database not ready", extra={"attempt": i, "error": type(exc).__name__})
                if i == attempts:
                    raise
                await asyncio.sleep(min(2.0, 0.25 * i))

    # ------------------------------------------------------------------ background work
    async def _alarm_ticker(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            try:
                await self.alarms.tick(datetime.now(UTC))
            except Exception as exc:
                log.warning("alarm tick failed", extra={"error": type(exc).__name__})

    async def _retention_loop(self) -> None:
        from datetime import timedelta

        from sqlalchemy import delete

        while True:
            try:
                cutoff = datetime.now(UTC) - timedelta(days=self.settings.telemetry_retention_days)
                async with self.sessionmaker() as session, session.begin():
                    res = await session.execute(
                        delete(m.Telemetry).where(m.Telemetry.source_ts < cutoff)
                    )
                log.info("telemetry retention applied", extra={"deleted": res.rowcount})  # type: ignore[attr-defined]
            except Exception as exc:
                log.warning("retention failed", extra={"error": type(exc).__name__})
            await asyncio.sleep(3600)

    async def _record_system_event(
        self, kind: str, severity: str, message: str, details: dict[str, object]
    ) -> None:
        async with self.sessionmaker() as session, session.begin():
            session.add(
                m.SystemEvent(
                    kind=kind, severity=severity, message=message, details=details or None
                )
            )
        self.hub.publish("source_status", self.opcua_status().model_dump(mode="json"))

    def _publish_status(self, _status: ConnectionStatus) -> None:
        self.hub.publish("source_status", self.opcua_status().model_dump(mode="json"))

    # ------------------------------------------------------------------ status helpers
    def opcua_status(self) -> OpcUaStatus:
        st = self.supervisor.status
        return OpcUaStatus(
            state=st.state,
            endpoint=self.settings.opcua_endpoint,
            security=self.settings.opcua_security,
            last_connected_at=st.last_connected_at,
            last_disconnected_at=st.last_disconnected_at,
            last_data_at=self.ingestion.last_data_at,
            reconnect_attempts=st.reconnect_attempts,
            monitored_items=st.monitored_items,
            heartbeat=st.heartbeat,
            last_error=st.last_error,
        )

    async def database_ok(self) -> bool:
        try:
            async with self.engine.connect() as conn:
                await asyncio.wait_for(conn.execute(select(1)), 3.0)
            return True
        except Exception:
            return False
