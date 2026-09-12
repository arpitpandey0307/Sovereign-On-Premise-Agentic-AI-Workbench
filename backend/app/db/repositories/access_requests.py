"""Reads and writes for access requests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.access_request import (
    APPROVED,
    DENIED,
    PENDING,
    REVOKED,
    AccessRequest,
)

# How long a grant lasts when the approver does not say. Short on purpose: the
# approver can extend, and the cost of a grant that was too brief is somebody
# asking again, while the cost of one that was too long is an exception nobody
# remembers making.
DEFAULT_GRANT_HOURS = 24
MAX_GRANT_HOURS = 24 * 30


class AccessRequestRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        *,
        user_id: UUID,
        user_email: str,
        user_roles: list[str],
        resource: str,
        action: str,
        justification: str,
        document_id: UUID | None = None,
    ) -> AccessRequest:
        record = AccessRequest(
            user_id=user_id,
            user_email=user_email,
            user_roles=",".join(sorted(user_roles)),
            resource=resource,
            action=action,
            document_id=document_id,
            justification=justification.strip(),
        )
        self.db.add(record)
        self.db.commit()
        self.db.refresh(record)
        return record

    def get(self, request_id: UUID) -> AccessRequest | None:
        return self.db.get(AccessRequest, request_id)

    def for_user(self, user_id: UUID) -> list[AccessRequest]:
        return list(
            self.db.scalars(
                select(AccessRequest)
                .where(AccessRequest.user_id == user_id)
                .order_by(AccessRequest.created_at.desc())
            )
        )

    def pending(self) -> list[AccessRequest]:
        return list(
            self.db.scalars(
                select(AccessRequest)
                .where(AccessRequest.state == PENDING)
                .order_by(AccessRequest.created_at.asc())
            )
        )

    def all(self, limit: int = 200) -> list[AccessRequest]:
        return list(
            self.db.scalars(
                select(AccessRequest)
                .order_by(AccessRequest.created_at.desc())
                .limit(limit)
            )
        )

    def has_open_request(self, user_id: UUID, resource: str, action: str) -> bool:
        """Whether this person is already waiting on exactly this.

        Without the check, a refused user clicking the button twice fills the
        approver's queue with the same ask, and the queue is the thing that has
        to stay readable for the feature to be worth having.
        """
        return (
            self.db.scalars(
                select(AccessRequest).where(
                    AccessRequest.user_id == user_id,
                    AccessRequest.resource == resource,
                    AccessRequest.action == action,
                    AccessRequest.state == PENDING,
                )
            ).first()
            is not None
        )

    def active_grants(self, user_id: UUID) -> list[AccessRequest]:
        """Approved, unexpired grants. Expiry is evaluated here, not by a job.

        A background sweep would leave a window in which an expired grant still
        works, and the window is exactly when it matters. Reading the clock on
        every check costs nothing and cannot drift.
        """
        candidates = self.db.scalars(
            select(AccessRequest).where(
                AccessRequest.user_id == user_id,
                AccessRequest.state == APPROVED,
            )
        )
        return [record for record in candidates if record.active]

    def decide(
        self,
        request_id: UUID,
        *,
        approved: bool,
        decided_by: UUID,
        decided_by_email: str,
        note: str = "",
        hours: int = DEFAULT_GRANT_HOURS,
    ) -> AccessRequest | None:
        record = self.get(request_id)
        if record is None or record.state != PENDING:
            return None

        record.state = APPROVED if approved else DENIED
        record.decided_by = decided_by
        record.decided_by_email = decided_by_email
        record.decided_at = datetime.now(UTC)
        record.decision_note = (note or "").strip()
        if approved:
            span = max(1, min(int(hours or DEFAULT_GRANT_HOURS), MAX_GRANT_HOURS))
            record.expires_at = datetime.now(UTC) + timedelta(hours=span)
        self.db.commit()
        self.db.refresh(record)
        return record

    def revoke(
        self, request_id: UUID, *, by: UUID, note: str = ""
    ) -> AccessRequest | None:
        """End a grant early. The row stays; only its state changes."""
        record = self.get(request_id)
        if record is None or record.state != APPROVED:
            return None
        record.state = REVOKED
        record.decision_note = (note or record.decision_note or "").strip()
        record.decided_by = by
        self.db.commit()
        self.db.refresh(record)
        return record
