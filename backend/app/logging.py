"""Structured (JSON) logging with a small helper for rate-limited repeated messages."""

from __future__ import annotations

import contextvars
import json
import logging
import sys
import time
from datetime import UTC, datetime
from typing import Any

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "request_id", default=None
)

_RESERVED = set(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}
_SECRET_KEYS = ("password", "token", "secret", "authorization")


def _redact(key: str, value: Any) -> Any:
    if any(s in key.lower() for s in _SECRET_KEYS):
        return "***"
    return value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid:
            payload["request_id"] = rid
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = _redact(key, value)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO", as_json: bool = True) -> None:
    handler = logging.StreamHandler(sys.stdout)
    if as_json:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # asyncua logs every keep-alive at INFO; uvicorn access log is replaced by our own middleware.
    logging.getLogger("asyncua").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").disabled = True


class RateLimitedLogger:
    """Emit at most one message per ``interval_s`` per key, counting what was suppressed."""

    def __init__(self, logger: logging.Logger, interval_s: float = 30.0) -> None:
        self._logger = logger
        self._interval = interval_s
        self._last: dict[str, tuple[float, int]] = {}

    def log(self, level: int, key: str, msg: str, **extra: Any) -> None:
        now = time.monotonic()
        last, suppressed = self._last.get(key, (-1e18, 0))
        if now - last >= self._interval:
            if suppressed:
                extra["suppressed"] = suppressed
            self._logger.log(level, msg, extra=extra)
            self._last[key] = (now, 0)
        else:
            self._last[key] = (last, suppressed + 1)
