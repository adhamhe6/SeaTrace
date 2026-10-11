"""Password hashing (Argon2id) and signed access tokens (HS256 JWT)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.domain.enums import Role

_hasher = PasswordHasher()
_ALGORITHM = "HS256"
_ISSUER = "seatrace"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


@dataclass(frozen=True, slots=True)
class TokenClaims:
    user_id: int
    username: str
    role: Role
    expires_at: datetime


def create_access_token(
    *,
    user_id: int,
    username: str,
    role: Role,
    secret: str,
    expires_minutes: int,
    now: datetime | None = None,
) -> tuple[str, datetime]:
    issued = now or datetime.now(UTC)
    expires = issued + timedelta(minutes=expires_minutes)
    payload = {
        "sub": str(user_id),
        "usr": username,
        "role": role.value,
        "iss": _ISSUER,
        "iat": int(issued.timestamp()),
        "exp": int(expires.timestamp()),
    }
    return jwt.encode(payload, secret, algorithm=_ALGORITHM), expires


def decode_access_token(token: str, secret: str) -> TokenClaims | None:
    """Return the claims for a valid token, else None (expired, tampered, wrong issuer...)."""
    try:
        data = jwt.decode(
            token,
            secret,
            algorithms=[_ALGORITHM],
            issuer=_ISSUER,
            options={"require": ["exp", "sub", "iss"]},
        )
        return TokenClaims(
            user_id=int(data["sub"]),
            username=str(data["usr"]),
            role=Role(data["role"]),
            expires_at=datetime.fromtimestamp(int(data["exp"]), UTC),
        )
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
