"""FastAPI dependencies: container access and authentication/authorisation."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.container import Container
from app.domain.enums import Role
from app.errors import AppError
from app.security import TokenClaims, decode_access_token

_bearer = HTTPBearer(auto_error=False)


def get_container(request: Request) -> Container:
    return request.app.state.container  # type: ignore[no-any-return]


ContainerDep = Annotated[Container, Depends(get_container)]


def _unauthorized(message: str = "Authentication required") -> AppError:
    return AppError(401, "unauthorized", message)


async def current_user(
    container: ContainerDep,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> TokenClaims:
    if creds is None:
        raise _unauthorized()
    claims = decode_access_token(creds.credentials, container.settings.secret_key)
    if claims is None:
        raise _unauthorized("Invalid or expired token")
    return claims


async def require_operator(user: Annotated[TokenClaims, Depends(current_user)]) -> TokenClaims:
    if user.role is not Role.OPERATOR:
        raise AppError(403, "forbidden", "This action requires the operator role")
    return user


Viewer = Annotated[TokenClaims, Depends(current_user)]
Operator = Annotated[TokenClaims, Depends(require_operator)]
