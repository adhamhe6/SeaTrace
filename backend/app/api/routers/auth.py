from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import ContainerDep, Viewer
from app.api.schemas import LoginRequest, TokenResponse, UserOut
from app.db import models as m
from app.domain.enums import Role
from app.errors import AppError
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

_DUMMY_HASH = hash_password("not-a-real-password")  # equalise timing for unknown usernames
_MAX_FAILURES = 5
_MAX_KEYS = 10_000
_WINDOW_S = 60.0
_failures: dict[str, deque[float]] = defaultdict(deque)


def _throttled(key: str) -> bool:
    now = time.monotonic()
    q = _failures.get(key)
    if q is None:
        return False
    while q and now - q[0] > _WINDOW_S:
        q.popleft()
    if not q:
        del _failures[key]  # keep the table from growing with one-off usernames
        return False
    return len(q) >= _MAX_FAILURES


def _record_failure(key: str) -> None:
    if len(_failures) >= _MAX_KEYS and key not in _failures:
        _failures.pop(next(iter(_failures)))  # evict the oldest tracked key
    _failures[key].append(time.monotonic())


def reset_throttle() -> None:
    _failures.clear()


@router.post("/login", response_model=TokenResponse, summary="Obtain an access token")
async def login(body: LoginRequest, request: Request, container: ContainerDep) -> TokenResponse:
    client = request.client.host if request.client else "unknown"
    key = f"{client}|{body.username.lower()}"
    if _throttled(key):
        raise AppError(
            429, "too_many_attempts", "Too many failed sign-in attempts; try again in a minute"
        )
    async with container.sessionmaker() as session:
        user = await session.scalar(select(m.User).where(m.User.username == body.username))
    ok = verify_password(body.password, user.password_hash if user else _DUMMY_HASH)
    if user is None or not ok or not user.is_active:
        _record_failure(key)
        raise AppError(401, "invalid_credentials", "Invalid username or password")
    _failures.pop(key, None)
    token, expires = create_access_token(
        user_id=user.id,
        username=user.username,
        role=Role(user.role),
        secret=container.settings.secret_key,
        expires_minutes=container.settings.access_token_expire_minutes,
    )
    return TokenResponse(
        access_token=token,
        expires_at=expires,
        user=UserOut(id=user.id, username=user.username, role=Role(user.role)),
    )


@router.get("/me", response_model=UserOut, summary="Current user")
async def me(user: Viewer) -> UserOut:
    return UserOut(id=user.user_id, username=user.username, role=user.role)
