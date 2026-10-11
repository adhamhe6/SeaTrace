"""Real-time channel (WebSocket).

Protocol (JSON text frames, protocol version 1)::

    server -> {"type":"hello","protocol":1,"auth_timeout_s":5,"server_time":...}
    client -> {"type":"auth","token":"<JWT>","resume_from":<last seq or null>}
    server -> {"type":"ready","seq":<current>,"resync_required":false,"user":{...}}
    server -> {"seq":N,"type":"telemetry|alarm|equipment_state|source_status|scenario","ts":...,"data":{...}}
    server -> {"type":"heartbeat","seq":<current>,"server_time":...}     (every 15 s, does not consume a seq)
    client -> {"type":"ping"}  =>  server -> {"type":"pong"}

Close codes: 4401 authentication failed/expired, 4400 protocol error, 1013 server busy or client too slow
(reconnect and resync through REST). If ``resync_required`` is true the client must reload REST state
(latest readings, active alarms, system status) because the missed events are no longer buffered.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.security import TokenClaims, decode_access_token

log = logging.getLogger(__name__)
router = APIRouter(tags=["realtime"])

HEARTBEAT_S = 15.0


async def _send(ws: WebSocket, payload: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(payload, default=str))


@router.websocket("/ws")
async def realtime(ws: WebSocket) -> None:
    container = ws.app.state.container
    settings = container.settings
    hub = container.hub
    await ws.accept()
    if hub.client_count >= settings.ws_max_clients:
        await ws.close(code=1013, reason="server busy")
        return
    sub = None
    try:
        await _send(
            ws,
            {
                "type": "hello",
                "protocol": 1,
                "auth_timeout_s": settings.ws_auth_timeout_s,
                "server_time": datetime.now(UTC).isoformat(),
            },
        )
        try:
            raw = await asyncio.wait_for(ws.receive_text(), settings.ws_auth_timeout_s)
            msg = json.loads(raw)
        except (TimeoutError, ValueError):
            await ws.close(code=4401, reason="authentication required")
            return
        claims: TokenClaims | None = None
        if (
            isinstance(msg, dict)
            and msg.get("type") == "auth"
            and isinstance(msg.get("token"), str)
        ):
            claims = decode_access_token(msg["token"], settings.secret_key)
        if claims is None:
            await ws.close(code=4401, reason="authentication failed")
            return
        resume = msg.get("resume_from")
        resume = resume if isinstance(resume, int) and not isinstance(resume, bool) else None
        sub, backlog, resync = hub.subscribe(resume)
        await _send(
            ws,
            {
                "type": "ready",
                "seq": hub.seq,
                "resync_required": resync,
                "user": {"username": claims.username, "role": claims.role.value},
            },
        )
        for m in backlog:
            await _send(ws, m.to_json())

        async def reader() -> None:
            while True:
                text = await ws.receive_text()
                try:
                    data = json.loads(text)
                except ValueError:
                    await ws.close(code=4400, reason="invalid json")
                    return
                if isinstance(data, dict) and data.get("type") == "ping":
                    await _send(ws, {"type": "pong", "server_time": datetime.now(UTC).isoformat()})

        async def writer() -> None:
            assert sub is not None
            while True:
                try:
                    msg_out = await asyncio.wait_for(sub.queue.get(), HEARTBEAT_S)
                except TimeoutError:
                    msg_out = None
                    await _send(
                        ws,
                        {
                            "type": "heartbeat",
                            "seq": hub.seq,
                            "server_time": datetime.now(UTC).isoformat(),
                        },
                    )
                if msg_out is None and sub.overflowed:
                    await ws.close(code=1013, reason="client too slow; resync required")
                    return
                if msg_out is None and not sub.queue.empty():
                    continue
                if msg_out is not None:
                    await _send(ws, msg_out.to_json())
                if datetime.now(UTC) >= claims.expires_at:
                    await ws.close(code=4401, reason="token expired")
                    return

        tasks = [asyncio.create_task(reader()), asyncio.create_task(writer())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        pass
    except RuntimeError:
        pass  # send on a closed socket during shutdown
    finally:
        if sub is not None:
            hub.unsubscribe(sub)
        with contextlib.suppress(Exception):
            await ws.close()
