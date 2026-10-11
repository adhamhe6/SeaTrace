"""Application error type and the uniform JSON error envelope."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    def __init__(
        self, status_code: int, code: str, message: str, details: list[dict[str, Any]] | None = None
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def not_found(what: str, ident: object) -> AppError:
    return AppError(404, "not_found", f"{what} '{ident}' was not found")


def bad_request(code: str, message: str) -> AppError:
    return AppError(400, code, message)
