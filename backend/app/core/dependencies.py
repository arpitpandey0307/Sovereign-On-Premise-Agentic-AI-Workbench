"""Shared FastAPI dependencies: current user, policy enforcement, audit.

Section 8 of the Part 01 spec requires every endpoint to consult Part 05's
policy interface before acting and to emit an audit event for the actions that
matter. ``require`` packages both so an endpoint declares its permission
inline rather than reimplementing the check.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.errors import AuthenticationError, PermissionDeniedError
from app.core.security import decode_access_token
from app.db.database import get_db
from app.db.models import User
from app.db.repositories.users import UserRepository
from app.integrations import registry
from app.integrations.stubs import audit_event

bearer_scheme = HTTPBearer(auto_error=False)

DbSession = Annotated[Session, Depends(get_db)]


def get_current_user(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer_scheme)
    ],
    db: DbSession,
) -> User:
    if credentials is None:
        raise AuthenticationError("Missing bearer token.")

    payload = decode_access_token(credentials.credentials)
    subject = payload.get("sub")
    if not subject:
        raise AuthenticationError("Token is missing a subject.")

    try:
        user_id = UUID(subject)
    except ValueError as exc:
        raise AuthenticationError("Token subject is not a valid user id.") from exc

    user = UserRepository(db).get(user_id)
    if user is None or not user.is_active:
        raise AuthenticationError("User no longer exists or is deactivated.")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require(resource: str, action: str) -> Callable[..., User]:
    """Dependency factory enforcing one permission on an endpoint."""

    def dependency(user: CurrentUser) -> User:
        allowed, reason = registry.get_policy().check_permission(
            user_id=user.id,
            roles=user.role_names,
            resource=resource,
            action=action,
        )
        if not allowed:
            registry.get_audit().record(
                audit_event(
                    event_type="PERMISSION_DENIED",
                    action=f"{resource}:{action}",
                    user_id=user.id,
                    metadata={"reason": reason},
                )
            )
            raise PermissionDeniedError(
                reason, details={"resource": resource, "action": action}
            )
        return user

    return dependency


def record_audit(
    *,
    event_type: str,
    action: str,
    component: str = "api",
    user_id: UUID | None = None,
    task_id: UUID | None = None,
    metadata: dict | None = None,
) -> None:
    registry.get_audit().record(
        audit_event(
            event_type=event_type,
            action=action,
            component=component,
            user_id=user_id,
            task_id=task_id,
            metadata=metadata,
        )
    )


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"
