"""In-process pub/sub hub feeding WebSocket clients.

* Every published message receives a monotonically increasing ``seq``.
* The last ``replay_buffer`` messages are retained so a client that reconnects shortly after a drop
  can resume from its last seen ``seq``; if the gap is too large the hub tells it to resync via REST.
* Per-client queues are bounded: a client that cannot keep up is disconnected (it will reconnect and
  resync) instead of growing memory without limit or slowing the pipeline down.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

log = logging.getLogger(__name__)


@dataclass(slots=True)
class Message:
    seq: int
    type: str
    data: dict[str, Any]
    ts: str

    def to_json(self) -> dict[str, Any]:
        return {"seq": self.seq, "type": self.type, "ts": self.ts, "data": self.data}


class Subscriber:
    def __init__(self, maxsize: int) -> None:
        self.queue: asyncio.Queue[Message | None] = asyncio.Queue(maxsize=maxsize)
        self.overflowed = False


class EventHub:
    def __init__(self, replay_buffer: int = 2000, client_queue_size: int = 1000) -> None:
        self._seq = 0
        self._buffer: deque[Message] = deque(maxlen=replay_buffer)
        self._subs: set[Subscriber] = set()
        self._client_queue_size = client_queue_size

    @property
    def seq(self) -> int:
        return self._seq

    @property
    def client_count(self) -> int:
        return len(self._subs)

    def publish(self, msg_type: str, data: dict[str, Any]) -> Message:
        self._seq += 1
        msg = Message(
            self._seq, msg_type, data, datetime.now(UTC).isoformat(timespec="milliseconds")
        )
        self._buffer.append(msg)
        for sub in list(self._subs):
            try:
                sub.queue.put_nowait(msg)
            except asyncio.QueueFull:
                sub.overflowed = True
                self._subs.discard(sub)
                log.warning("websocket client too slow; disconnecting", extra={"seq": self._seq})
                _drain_and_close(sub)
        return msg

    def subscribe(self, resume_from: int | None = None) -> tuple[Subscriber, list[Message], bool]:
        """Register a subscriber. Returns (subscriber, backlog, resync_required)."""
        sub = Subscriber(self._client_queue_size)
        backlog: list[Message] = []
        resync = False
        if resume_from is not None:
            oldest = self._buffer[0].seq if self._buffer else self._seq + 1
            if resume_from > self._seq:
                resync = True  # server restarted: sequence numbers restarted
            elif resume_from + 1 < oldest and resume_from < self._seq:
                resync = True  # gap no longer covered by the buffer
            else:
                backlog = [m for m in self._buffer if m.seq > resume_from]
        self._subs.add(sub)
        return sub, backlog, resync

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subs.discard(sub)

    async def close(self) -> None:
        for sub in list(self._subs):
            _drain_and_close(sub)
        self._subs.clear()


def _drain_and_close(sub: Subscriber) -> None:
    while not sub.queue.empty():
        try:
            sub.queue.get_nowait()
        except asyncio.QueueEmpty:  # pragma: no cover
            break
    with contextlib.suppress(asyncio.QueueFull):
        sub.queue.put_nowait(None)
