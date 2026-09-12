"""Requests for access somebody's role does not already give them (Part 05).

A system that can only say no gets worked around. People email documents to
each other, or copy them onto a pen drive, and the control you built becomes
the reason for the leak. Giving a refusal a next step keeps the work inside
the governed system, where it is logged.

Two rules are built into the shape of this table rather than left to the code
that writes it:

* A grant **expires**. ``expires_at`` is not nullable for an approved request,
  because a permanent exception is how a clearance model gets dismantled by a
  year of small favours that nobody remembers granting.
* A grant is **narrow**. It names one resource and action, and optionally one
  document, rather than raising the requester's clearance.

``user_id`` and ``decided_by`` are plain columns rather than foreign keys, for
the same reason the audit ledger's are: a record of who asked for what, and
who agreed, should not disappear because somebody deleted an account.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, Index, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base

PENDING = "pending"
APPROVED = "approved"
DENIED = "denied"
REVOKED = "revoked"
STATES = (PENDING, APPROVED, DENIED, REVOKED)


def _now() -> datetime:
    return datetime.now(UTC)


class AccessRequest(Base):
    __tablename__ = "access_requests"
    __table_args__ = (
        Index("ix_access_requests_user_state", "user_id", "state"),
        Index("ix_access_requests_state_created", "state", "created_at"),
    )

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)

    user_id: Mapped[UUID] = mapped_column(Uuid, index=True)
    # Denormalised so the approver's queue reads correctly even if the account
    # is later renamed or removed.
    user_email: Mapped[str] = mapped_column(String(320), default="")
    user_roles: Mapped[str] = mapped_column(String(200), default="")

    # What is being asked for, in the same vocabulary the permission matrix
    # uses, so granting it is a lookup rather than a translation.
    resource: Mapped[str] = mapped_column(String(50), index=True)
    action: Mapped[str] = mapped_column(String(50))
    # Optional narrowing to a single document.
    document_id: Mapped[UUID | None] = mapped_column(Uuid, nullable=True)

    # Why they need it. Required, and the whole point of the feature: an
    # approver deciding without a stated reason is rubber-stamping.
    justification: Mapped[str] = mapped_column(Text)

    state: Mapped[str] = mapped_column(String(20), default=PENDING, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    decided_by: Mapped[UUID | None] = mapped_column(Uuid, nullable=True)
    decided_by_email: Mapped[str] = mapped_column(String(320), default="")
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decision_note: Mapped[str] = mapped_column(Text, default="")

    # When an approval stops working. Set on approval, never afterwards.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    @property
    def active(self) -> bool:
        """Whether this grant permits anything *right now*."""
        if self.state != APPROVED or self.expires_at is None:
            return False
        expiry = self.expires_at
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=UTC)
        return expiry > _now()
