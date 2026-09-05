"""Generated artifacts and the persisted run state (Part 04).

Two tables with different jobs. ``artifacts`` is the record of a deliverable
the agent produced: what it is, where the bytes live, and whether it survived
validation. ``task_runs`` holds the orchestrator's state between nodes.

LangGraph checkpoints in memory, which is enough to pause at an approval gate
and resume when the operator answers -- both happen inside one process. It is
not enough if that process restarts while a task is waiting, and a task left
permanently in ``waiting_approval`` with no way to continue is worse than one
that failed loudly. So the state is written here after every node, and a
resume that finds no live checkpoint rebuilds from this row.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


class ArtifactRecord(Base):
    """A deliverable the agent generated, and how it was checked."""

    __tablename__ = "artifacts"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    task_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[str] = mapped_column(String(16))
    filename: Mapped[str] = mapped_column(String(512))
    storage_path: Mapped[str] = mapped_column(String(1024))
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)

    # "pending" | "passed" | "failed". A failed artifact is kept rather than
    # deleted: the operator needs to see what went wrong, and the regeneration
    # loop needs something to compare against.
    validation_status: Mapped[str] = mapped_column(
        String(16), default="pending", index=True
    )
    validation_detail: Mapped[dict] = mapped_column(JSON, default=dict)

    # Which generation attempt this was. The validator can reject an artifact
    # and ask for another, so more than one row per task is normal.
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class TaskRun(Base):
    """The orchestrator's state for one task, persisted between nodes."""

    __tablename__ = "task_runs"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    task_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("tasks.id", ondelete="CASCADE"), unique=True, index=True
    )
    # The node that most recently completed, so a resumed run can say where it
    # left off rather than starting the graph again from the top.
    last_node: Mapped[str] = mapped_column(String(64), default="")
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
