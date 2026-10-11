"""An in-process OPC UA server (asyncua) that mimics the documented SeaTrace address space.

It lets the backend's OPC UA client be tested deterministically (disconnects, reconnects, bad status
codes, timestamps) without the C++ simulator binary. Values are written by the test, not generated.
"""

from __future__ import annotations

import socket
from datetime import UTC, datetime
from typing import Any

from app.domain.seed_catalog import FLEET
from asyncua import Server, ua

NS_URI = "urn:seatrace:simulator"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def browse_name(key: str) -> str:
    return "".join(part.capitalize() for part in key.split("_"))


class FakeSimulator:
    def __init__(self, port: int | None = None) -> None:
        self.port = port or free_port()
        self.endpoint = f"opc.tcp://127.0.0.1:{self.port}"
        self.server: Server | None = None
        self.ns = 0
        self.heartbeat = 0
        self.calls: list[tuple[str, list[Any]]] = []
        self.accept = True
        self._nodes: dict[str, Any] = {}

    async def start(self) -> None:
        server = Server()
        await server.init()
        server.set_endpoint(self.endpoint)
        server.set_server_name("fake seatrace simulator")
        self.ns = await server.register_namespace(NS_URI)
        objects = server.nodes.objects
        root = await objects.add_object(
            ua.NodeId("SeaTrace", self.ns), ua.QualifiedName("SeaTrace", self.ns)
        )
        sim = await root.add_object(
            ua.NodeId("Simulator", self.ns), ua.QualifiedName("Simulator", self.ns)
        )
        self._nodes["Heartbeat"] = await sim.add_variable(
            ua.NodeId("Simulator.Heartbeat", self.ns),
            ua.QualifiedName("Heartbeat", self.ns),
            ua.Variant(0, ua.VariantType.UInt64),
        )
        self._nodes["ActiveScenarios"] = await sim.add_variable(
            ua.NodeId("Simulator.ActiveScenarios", self.ns),
            ua.QualifiedName("ActiveScenarios", self.ns),
            "[]",
        )
        for name, ins, outs in (
            (
                "ActivateScenario",
                [ua.VariantType.String, ua.VariantType.String, ua.VariantType.UInt32],
                [ua.VariantType.Boolean, ua.VariantType.String],
            ),
            (
                "ClearScenario",
                [ua.VariantType.String, ua.VariantType.String],
                [ua.VariantType.Boolean, ua.VariantType.String],
            ),
            ("ResetScenarios", [], [ua.VariantType.Boolean, ua.VariantType.String]),
        ):
            await sim.add_method(
                ua.NodeId(f"Simulator.{name}", self.ns),
                ua.QualifiedName(name, self.ns),
                self._make_method(name),
                ins,
                outs,
            )
        vessels = await root.add_object(
            ua.NodeId("Vessels", self.ns), ua.QualifiedName("Vessels", self.ns)
        )
        for v in FLEET:
            vn = await vessels.add_object(
                ua.NodeId(v.code, self.ns), ua.QualifiedName(v.code, self.ns)
            )
            for e in v.equipment:
                eid = f"{v.code}.{e.code}"
                en = await vn.add_object(ua.NodeId(eid, self.ns), ua.QualifiedName(e.code, self.ns))
                self._nodes[f"{eid}.State"] = await en.add_variable(
                    ua.NodeId(f"{eid}.State", self.ns),
                    ua.QualifiedName("State", self.ns),
                    "RUNNING",
                )
                self._nodes[f"{eid}.SensorHealth"] = await en.add_variable(
                    ua.NodeId(f"{eid}.SensorHealth", self.ns),
                    ua.QualifiedName("SensorHealth", self.ns),
                    "OK",
                )
                await en.add_variable(
                    ua.NodeId(f"{eid}.EquipmentType", self.ns),
                    ua.QualifiedName("EquipmentType", self.ns),
                    e.type.value,
                )
                for s in e.sensors:
                    bn = browse_name(s.key)
                    node = await en.add_variable(
                        ua.NodeId(f"{eid}.{bn}", self.ns),
                        ua.QualifiedName(bn, self.ns),
                        ua.Variant(0.0, ua.VariantType.Double),
                    )
                    self._nodes[f"{eid}.{bn}"] = node
        await server.start()
        self.server = server

    def _make_method(self, name: str):  # type: ignore[no-untyped-def]
        async def method(parent: Any, *args: ua.Variant) -> list[ua.Variant]:
            values = [a.Value for a in args]
            self.calls.append((name, values))
            msg = "accepted" if self.accept else "scenario already active"
            return [
                ua.Variant(self.accept, ua.VariantType.Boolean),
                ua.Variant(msg, ua.VariantType.String),
            ]

        return method

    async def stop(self) -> None:
        if self.server is not None:
            await self.server.stop()
            self.server = None

    async def restart(self) -> None:
        """Bring the server back on the same endpoint with a fresh address space (values reset)."""
        await self.stop()
        await self.start()

    async def publish(
        self,
        vessel: str,
        equipment: str,
        key: str,
        value: float | None,
        ts: datetime | None = None,
        status: int = 0,
    ) -> None:
        bn = browse_name(key)
        node = self._nodes[f"{vessel}.{equipment}.{bn}"]
        dv = ua.DataValue(
            ua.Variant(0.0 if value is None else float(value), ua.VariantType.Double),
            StatusCode=ua.StatusCode(status),
            SourceTimestamp=ts or datetime.now(UTC),
        )
        await node.write_value(dv)

    async def set_state(
        self, vessel: str, equipment: str, state: str, ts: datetime | None = None
    ) -> None:
        node = self._nodes[f"{vessel}.{equipment}.State"]
        await node.write_value(
            ua.DataValue(
                ua.Variant(state, ua.VariantType.String), SourceTimestamp=ts or datetime.now(UTC)
            )
        )

    async def beat(self) -> None:
        self.heartbeat += 1
        await self._nodes["Heartbeat"].write_value(
            ua.DataValue(
                ua.Variant(self.heartbeat, ua.VariantType.UInt64), SourceTimestamp=datetime.now(UTC)
            )
        )

    async def set_active_scenarios(self, payload: str) -> None:
        await self._nodes["ActiveScenarios"].write_value(
            ua.DataValue(
                ua.Variant(payload, ua.VariantType.String), SourceTimestamp=datetime.now(UTC)
            )
        )
