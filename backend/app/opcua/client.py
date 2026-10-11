"""OPC UA connection supervisor.

One long-running task owns the session lifecycle::

    connect (timeout) -> discover address space -> subscribe -> monitor (keep-alive reads)
         ^                                                          |
         +---------------- bounded exponential backoff <------------+  (on any failure)

Every connection attempt uses a *fresh* ``asyncua.Client`` and a single subscription, and the previous client is
always torn down first, so reconnects can never accumulate duplicate subscriptions. The server-side initial
values re-delivered after a reconnect are harmless: ingestion de-duplicates on ``(sensor, source_ts)``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from asyncua import Client, ua
from asyncua.crypto.security_policies import SecurityPolicyBasic256Sha256

from app.config import Settings
from app.domain.raw import RawSample, RawState
from app.logging import RateLimitedLogger
from app.opcua.errors import SimulatorUnavailableError
from app.opcua.mapping import (
    NAMESPACE_URI,
    SIMULATOR_NAME,
    VESSELS_NAME,
    Binding,
    classify_variable,
    to_utc,
)

log = logging.getLogger(__name__)
_rl = RateLimitedLogger(log, 30.0)

SAMPLING_INTERVAL_MS = 250.0
QUEUE_SIZE = 10


@dataclass(slots=True)
class ConnectionStatus:
    state: str = "stopped"
    last_connected_at: datetime | None = None
    last_disconnected_at: datetime | None = None
    reconnect_attempts: int = 0
    monitored_items: int = 0
    heartbeat: int | None = None
    heartbeat_changed_at: float | None = None  # monotonic
    last_error: str | None = None
    active_scenarios: list[dict[str, Any]] = field(default_factory=list)


class OpcUaSupervisor:
    def __init__(
        self,
        settings: Settings,
        on_sample: Any,  # Callable[[RawSample | RawState], None]
        on_event: Any,  # Callable[[str, str, str, dict], Awaitable[None]]  (kind, severity, message, details)
        on_status: Any,  # Callable[[ConnectionStatus], None] -> publish changes
    ) -> None:
        self._s = settings
        self._on_sample = on_sample
        self._on_event = on_event
        self._on_status = on_status
        self.status = ConnectionStatus(state="stopped" if settings.opcua_enabled else "disabled")
        self._task: asyncio.Task[None] | None = None
        self._stop = asyncio.Event()
        self._client: Client | None = None
        self._ns: int | None = None
        self._bindings: dict[ua.NodeId, Binding] = {}
        self._connected = asyncio.Event()

    # ------------------------------------------------------------------ public API
    @property
    def connected(self) -> bool:
        return self.status.state == "connected"

    def heartbeat_age_s(self) -> float | None:
        t = self.status.heartbeat_changed_at
        return None if t is None else time.monotonic() - t

    def start(self) -> None:
        if not self._s.opcua_enabled:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="opcua-supervisor")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        await self._teardown()
        self._set_state("stopped")

    async def refresh_active_scenarios(self) -> None:
        """Read ActiveScenarios directly so a command response never shows a stale subscription copy."""
        client, ns = self._client, self._ns
        if not self.connected or client is None or ns is None:
            return
        node = client.get_node(ua.NodeId(f"{SIMULATOR_NAME}.ActiveScenarios", ns))
        try:
            value = await asyncio.wait_for(node.read_value(), self._s.opcua_request_timeout_s)
        except (TimeoutError, OSError, ua.UaError):
            return  # keep the last subscribed value; the subscription will catch up
        self.status.active_scenarios = _parse_scenarios(value)

    async def call_method(self, method_name: str, *args: ua.Variant) -> list[Any]:
        """Call a method on the Simulator object using the established session."""
        client, ns = self._client, self._ns
        if not self.connected or client is None or ns is None:
            raise SimulatorUnavailableError("OPC UA session to the simulator is not established")
        obj = client.get_node(ua.NodeId(SIMULATOR_NAME, ns))
        method_id = ua.NodeId(f"{SIMULATOR_NAME}.{method_name}", ns)
        try:
            result = await asyncio.wait_for(
                obj.call_method(method_id, *args), self._s.opcua_request_timeout_s
            )
        except (TimeoutError, OSError, ConnectionError) as exc:
            raise SimulatorUnavailableError(f"call to {method_name} failed: {exc!r}") from exc
        if result is None:
            return []
        return list(result) if isinstance(result, list) else [result]

    # ------------------------------------------------------------------ supervisor loop
    async def _run(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            self._set_state("connecting")
            started = time.monotonic()
            try:
                await self._connect_and_subscribe()
                attempt = 0
                self.status.reconnect_attempts = 0
                await self._monitor()
                reason = "connection lost"
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                reason = f"{type(exc).__name__}: {exc}"
            was_connected = self.connected
            self.status.last_error = reason
            await self._teardown()
            if was_connected:
                self.status.last_disconnected_at = datetime.now(UTC)
                await self._event(
                    "opcua_disconnected", "warning", f"OPC UA connection lost: {reason}", {}
                )
                if time.monotonic() - started > 10:
                    attempt = 0
            self._set_state("backoff")
            attempt += 1
            self.status.reconnect_attempts += 1
            delay = min(
                self._s.opcua_backoff_max_s, self._s.opcua_backoff_min_s * (2 ** (attempt - 1))
            )
            delay *= random.uniform(0.8, 1.2)  # noqa: S311 - jitter, not security relevant
            _rl.log(
                logging.WARNING,
                "opcua-retry",
                "OPC UA unavailable; retrying",
                reason=reason,
                attempt=attempt,
                retry_in_s=round(delay, 1),
            )
            try:
                await asyncio.wait_for(self._stop.wait(), delay)
            except TimeoutError:
                continue

    async def _connect_and_subscribe(self) -> None:
        client = Client(self._s.opcua_endpoint, timeout=self._s.opcua_request_timeout_s)
        client.application_uri = self._s.opcua_application_uri
        client.name = "SeaTrace backend"
        if self._s.opcua_user:
            client.set_user(self._s.opcua_user)
            client.set_password(self._s.opcua_password or "")
        if self._s.opcua_security == "secure":
            if not (self._s.opcua_client_cert and self._s.opcua_client_key):
                raise RuntimeError("secure OPC UA mode requires client certificate and key")
            await client.set_security(
                SecurityPolicyBasic256Sha256,
                certificate=self._s.opcua_client_cert,
                private_key=self._s.opcua_client_key,
                server_certificate=self._s.opcua_server_cert,
                mode=ua.MessageSecurityMode.SignAndEncrypt,
            )
        self._client = client
        await asyncio.wait_for(client.connect(), self._s.opcua_connect_timeout_s)
        self._ns = await client.get_namespace_index(NAMESPACE_URI)
        bindings = await self._discover(client, self._ns)
        if not any(b.kind == "measurement" for b in bindings.values()):
            raise RuntimeError("no measurement nodes discovered in the simulator address space")
        self._bindings = bindings
        handler = _Handler(self)
        sub = await client.create_subscription(self._s.opcua_publish_interval_ms, handler)
        nodes = [client.get_node(n) for n in bindings]
        flt = ua.DataChangeFilter(Trigger=ua.DataChangeTrigger.StatusValueTimestamp)
        results = await sub._subscribe(
            nodes,
            ua.AttributeIds.Value,
            mfilter=flt,
            queuesize=QUEUE_SIZE,
            sampling_interval=SAMPLING_INTERVAL_MS,
        )
        failed = [r for r in results if isinstance(r, ua.StatusCode)]
        if failed:
            log.warning("some monitored items could not be created", extra={"failed": len(failed)})
        self.status.monitored_items = len(results) - len(failed)
        self.status.last_connected_at = datetime.now(UTC)
        self.status.last_error = None
        self._set_state("connected")
        self._connected.set()
        await self._event(
            "opcua_connected",
            "info",
            "OPC UA connection established",
            {
                "endpoint": self._s.opcua_endpoint,
                "security": self._s.opcua_security,
                "monitored_items": self.status.monitored_items,
            },
        )

    async def _discover(self, client: Client, ns: int) -> dict[ua.NodeId, Binding]:
        """Browse SeaTrace/Vessels/<vessel>/<equipment>/<variable> and bind each node to its meaning."""
        bindings: dict[ua.NodeId, Binding] = {}
        vessels = client.get_node(ua.NodeId(VESSELS_NAME, ns))
        for vessel in await vessels.get_children():
            vessel_code = (await vessel.read_browse_name()).Name
            for equipment in await vessel.get_children(nodeclassmask=ua.NodeClass.Object):
                equipment_code = (await equipment.read_browse_name()).Name
                for var in await equipment.get_children(nodeclassmask=ua.NodeClass.Variable):
                    name = (await var.read_browse_name()).Name
                    binding = classify_variable(name, vessel_code, equipment_code)
                    if binding is not None:
                        bindings[var.nodeid] = binding
        sim = client.get_node(ua.NodeId(SIMULATOR_NAME, ns))
        for name, kind in (("Heartbeat", "heartbeat"), ("ActiveScenarios", "active_scenarios")):
            try:
                node = await sim.get_child(ua.QualifiedName(name, ns))
                bindings[node.nodeid] = Binding(kind)  # type: ignore[arg-type]
            except Exception:
                log.warning("simulator node missing", extra={"node": name})
        log.info("OPC UA address space discovered", extra={"nodes": len(bindings)})
        return bindings

    async def _monitor(self) -> None:
        """Keep-alive reads of the heartbeat; returns (raising) when the connection is considered lost."""
        client = self._client
        assert client is not None and self._ns is not None
        hb_node = client.get_node(ua.NodeId(f"{SIMULATOR_NAME}.Heartbeat", self._ns))
        failures = 0
        while not self._stop.is_set():
            await asyncio.sleep(self._s.opcua_keepalive_interval_s)
            try:
                value = await asyncio.wait_for(
                    hb_node.read_value(), self._s.opcua_request_timeout_s
                )
                failures = 0
                self._note_heartbeat(value)
            except Exception as exc:
                failures += 1
                if failures >= self._s.opcua_keepalive_failures:
                    raise ConnectionError(f"keep-alive failed {failures}x: {exc!r}") from exc

    async def _teardown(self) -> None:
        client, self._client = self._client, None
        self._connected.clear()
        self._bindings = {}
        self.status.monitored_items = 0
        if client is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(client.disconnect(), 3.0)

    # ------------------------------------------------------------------ callbacks
    def _note_heartbeat(self, value: Any) -> None:
        if isinstance(value, int) and value != self.status.heartbeat:
            self.status.heartbeat = value
            self.status.heartbeat_changed_at = time.monotonic()

    def handle_data_change(self, node_id: ua.NodeId, dv: ua.DataValue) -> None:
        binding = self._bindings.get(node_id)
        if binding is None:
            return
        value = dv.Value.Value if dv.Value is not None else None
        now = datetime.now(UTC)
        if binding.kind == "heartbeat":
            self._note_heartbeat(value)
            return
        if binding.kind == "active_scenarios":
            self.status.active_scenarios = _parse_scenarios(value)
            self._on_status(self.status)
            return
        src, srv = to_utc(dv.SourceTimestamp), to_utc(dv.ServerTimestamp)
        if binding.kind in ("state", "sensor_health"):
            self._on_sample(
                RawState(
                    binding.vessel_code,
                    binding.equipment_code,
                    binding.kind,
                    value,
                    src or srv,
                    now,
                )
            )
            return
        status = dv.StatusCode.value if dv.StatusCode is not None else 0
        self._on_sample(
            RawSample(
                binding.vessel_code,
                binding.equipment_code,
                binding.key,
                value,
                status,
                src,
                srv,
                now,
            )
        )

    def _set_state(self, state: str) -> None:
        if self.status.state != state:
            self.status.state = state
            self._on_status(self.status)

    async def _event(self, kind: str, severity: str, message: str, details: dict[str, Any]) -> None:
        log.info(message, extra={"event": kind, **details})
        try:
            await self._on_event(kind, severity, message, details)
        except Exception:
            log.exception("failed to record system event")


class _Handler:
    """asyncua subscription callback adapter."""

    def __init__(self, supervisor: OpcUaSupervisor) -> None:
        self._sup = supervisor

    def datachange_notification(self, node: Any, val: Any, data: Any) -> None:
        try:
            self._sup.handle_data_change(node.nodeid, data.monitored_item.Value)
        except Exception:
            _rl.log(logging.ERROR, "handler", "error handling data change notification")

    def status_change_notification(self, status: Any) -> None:
        log.warning("subscription status change", extra={"status": str(status)})

    def event_notification(self, event: Any) -> None:  # pragma: no cover - not subscribed
        return None


def _parse_scenarios(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, str) or not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []
