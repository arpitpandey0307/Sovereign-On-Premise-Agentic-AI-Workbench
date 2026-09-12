"""Asking for access, and granting it (Part 05).

The denial is where this starts. Everywhere else in the product a 403 renders
as information rather than a redirect, because bouncing somebody hides the
reason. This is that idea taken one step further: the screen that explains the
refusal is also the screen where you ask for what you need.

Every step is audited -- the ask, the decision, the reason given for both --
so an approval that nobody can account for afterwards is not possible.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.dependencies import CurrentUser, DbSession, record_audit, require
from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.db.models.access_request import AccessRequest
from app.db.models.user import User
from app.db.repositories.access_requests import (
    DEFAULT_GRANT_HOURS,
    MAX_GRANT_HOURS,
    AccessRequestRepository,
)

router = APIRouter(tags=["access"])

ApproverUser = Annotated[User, Depends(require("security", "read"))]

# What may be asked for. An open-ended request field would let a caller name
# any permission in the system, including the ones that exist to constrain
# administrators, so the askable set is enumerated here instead.
REQUESTABLE: dict[str, tuple[str, str]] = {
    "knowledge.search": ("knowledge", "search"),
}

MIN_JUSTIFICATION = 20


class AccessRequestCreate(BaseModel):
    scope: str = Field(description="What is being asked for, e.g. knowledge.search")
    justification: str = Field(description="Why it is needed, in the asker's words")
    document_id: UUID | None = None


class AccessDecision(BaseModel):
    approved: bool
    note: str = ""
    hours: int = Field(default=DEFAULT_GRANT_HOURS, ge=1, le=MAX_GRANT_HOURS)


def _scope_name(resource: str, action: str) -> str:
    for name, pair in REQUESTABLE.items():
        if pair == (resource, action):
            return name
    return f"{resource}.{action}"


def _view(record: AccessRequest) -> dict:
    return {
        "id": str(record.id),
        "scope": _scope_name(record.resource, record.action),
        "resource": record.resource,
        "action": record.action,
        "document_id": str(record.document_id) if record.document_id else None,
        "user_id": str(record.user_id),
        "user_email": record.user_email,
        "user_roles": [r for r in (record.user_roles or "").split(",") if r],
        "justification": record.justification,
        "state": record.state,
        "active": record.active,
        "created_at": record.created_at.isoformat() if record.created_at else None,
        "decided_by_email": record.decided_by_email,
        "decided_at": record.decided_at.isoformat() if record.decided_at else None,
        "decision_note": record.decision_note,
        "expires_at": record.expires_at.isoformat() if record.expires_at else None,
    }


@router.post("/api/v1/access-requests", status_code=201)
def create_access_request(
    payload: AccessRequestCreate, user: CurrentUser, db: DbSession
) -> dict:
    """Ask for a permission the caller's role does not carry."""
    pair = REQUESTABLE.get(payload.scope)
    if pair is None:
        raise ValidationFailedError(
            "That is not something access can be requested for.",
            details={"field": "scope", "requestable": sorted(REQUESTABLE)},
        )

    justification = (payload.justification or "").strip()
    if len(justification) < MIN_JUSTIFICATION:
        # The justification is the entire value of the feature. A one-word
        # reason gives the approver nothing to weigh, and an approver with
        # nothing to weigh is a rubber stamp with extra steps.
        raise ValidationFailedError(
            f"Please explain why this is needed, in at least "
            f"{MIN_JUSTIFICATION} characters.",
            details={"field": "justification"},
        )

    resource, action = pair
    repo = AccessRequestRepository(db)
    if repo.has_open_request(user.id, resource, action):
        raise ConflictError("You already have a request waiting for this.")

    record = repo.create(
        user_id=user.id,
        user_email=user.email,
        user_roles=user.role_names,
        resource=resource,
        action=action,
        justification=justification,
        document_id=payload.document_id,
    )

    record_audit(
        event_type="APPROVAL_REQUESTED",
        action=f"access:{payload.scope}",
        component="security",
        user_id=user.id,
        metadata={"request_id": str(record.id), "justification": justification},
    )
    return _view(record)


@router.get("/api/v1/access-requests/mine")
def my_access_requests(user: CurrentUser, db: DbSession) -> dict:
    """What the caller has asked for, and what came of it."""
    records = AccessRequestRepository(db).for_user(user.id)
    return {"items": [_view(record) for record in records]}


@router.get("/api/v1/access-requests")
def list_access_requests(
    user: ApproverUser, db: DbSession, state: str | None = None
) -> dict:
    """The approver's queue."""
    repo = AccessRequestRepository(db)
    records = repo.pending() if state == "pending" else repo.all()
    return {"items": [_view(record) for record in records]}


@router.post("/api/v1/access-requests/{request_id}/decide")
def decide_access_request(
    request_id: UUID, payload: AccessDecision, user: ApproverUser, db: DbSession
) -> dict:
    """Approve or refuse. An approval always expires."""
    repo = AccessRequestRepository(db)
    existing = repo.get(request_id)
    if existing is None:
        raise NotFoundError("No such access request.")
    if existing.state != "pending":
        raise ConflictError(f"That request was already {existing.state}.")

    record = repo.decide(
        request_id,
        approved=payload.approved,
        decided_by=user.id,
        decided_by_email=user.email,
        note=payload.note,
        hours=payload.hours,
    )
    if record is None:
        raise ConflictError("That request could not be decided.")

    record_audit(
        event_type="APPROVAL_GRANTED" if payload.approved else "APPROVAL_DENIED",
        action=f"access:{_scope_name(record.resource, record.action)}",
        component="security",
        user_id=user.id,
        metadata={
            "request_id": str(record.id),
            "requested_by": record.user_email,
            "note": record.decision_note,
            "expires_at": record.expires_at.isoformat() if record.expires_at else None,
        },
    )
    return _view(record)


@router.post("/api/v1/access-requests/{request_id}/revoke")
def revoke_access_request(
    request_id: UUID, user: ApproverUser, db: DbSession
) -> dict:
    """End a grant before it expires."""
    record = AccessRequestRepository(db).revoke(request_id, by=user.id)
    if record is None:
        raise NotFoundError("No active grant with that id.")

    record_audit(
        event_type="APPROVAL_DENIED",
        action=f"access:revoke:{_scope_name(record.resource, record.action)}",
        component="security",
        user_id=user.id,
        metadata={"request_id": str(record.id), "requested_by": record.user_email},
    )
    return _view(record)
