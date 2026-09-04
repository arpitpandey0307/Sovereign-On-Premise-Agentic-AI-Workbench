"""Authentication endpoints.

JWT is stateless, so ``/logout`` is a client-side token discard. It still
exists as an endpoint because the audit ledger needs the event -- knowing when
a session ended matters as much as knowing when it started.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status

from app.core.dependencies import CurrentUser, DbSession, client_ip, record_audit
from app.core.errors import AuthenticationError
from app.core.security import create_access_token, verify_password
from app.db.repositories.users import UserRepository
from app.schemas.api import LoginRequest, TokenResponse, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: DbSession) -> TokenResponse:
    user = UserRepository(db).get_by_email(payload.email)

    # One message for both branches: a distinct "no such user" reply would let
    # an outsider enumerate valid accounts.
    if user is None or not verify_password(payload.password, user.hashed_password):
        record_audit(
            event_type="LOGIN_FAILED",
            action="auth:login",
            metadata={"email": payload.email, "ip": client_ip(request)},
        )
        raise AuthenticationError("Incorrect email or password.")

    if not user.is_active:
        raise AuthenticationError("This account is deactivated.")

    token, expires_at = create_access_token(user.id, roles=user.role_names)
    record_audit(
        event_type="LOGIN_SUCCEEDED",
        action="auth:login",
        user_id=user.id,
        metadata={"ip": client_ip(request), "roles": user.role_names},
    )
    return TokenResponse(access_token=token, expires_at=expires_at)


@router.get("/me", response_model=UserResponse)
def me(user: CurrentUser) -> UserResponse:
    return UserResponse(
        id=user.id, email=user.email, name=user.name, roles=user.role_names
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(user: CurrentUser, request: Request) -> None:
    record_audit(
        event_type="LOGOUT",
        action="auth:logout",
        user_id=user.id,
        metadata={"ip": client_ip(request)},
    )
