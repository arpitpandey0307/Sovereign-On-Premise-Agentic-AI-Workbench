"""Data access for task records and their coarse steps."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Task, TaskStep

# Transitions Part 01 will accept. Part 04 drives execution, but the record
# owner is the one that refuses an impossible transition.
ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "pending": {"planning", "running", "cancelled", "failed"},
    "planning": {"running", "waiting_approval", "cancelled", "failed"},
    "running": {"waiting_approval", "completed", "cancelled", "failed"},
    "waiting_approval": {"running", "completed", "cancelled", "failed"},
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


class TaskRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        *,
        user_id: UUID,
        conversation_id: UUID,
        request_text: str,
        task_type: str,
        input_file_ids: list[UUID],
        effort: str = "balanced",
    ) -> Task:
        task = Task(
            user_id=user_id,
            conversation_id=conversation_id,
            request_text=request_text,
            task_type=task_type,
            input_file_ids=[str(file_id) for file_id in input_file_ids],
            effort=effort,
            status="pending",
        )
        self.db.add(task)
        self.db.commit()
        self.db.refresh(task)
        return task

    def get(self, task_id: UUID) -> Task | None:
        return self.db.get(Task, task_id)

    def list_for_user(
        self,
        user_id: UUID,
        *,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Task]:
        stmt = select(Task).where(Task.user_id == user_id)
        if status:
            stmt = stmt.where(Task.status == status)
        stmt = stmt.order_by(Task.created_at.desc()).limit(limit).offset(offset)
        return list(self.db.scalars(stmt))

    def count_for_user(self, user_id: UUID, *, status: str | None = None) -> int:
        stmt = select(func.count()).select_from(Task).where(Task.user_id == user_id)
        if status:
            stmt = stmt.where(Task.status == status)
        return self.db.scalar(stmt) or 0

    def set_status(
        self, task_id: UUID, status: str, *, error: str | None = None
    ) -> Task | None:
        task = self.get(task_id)
        if task is None:
            return None
        if status != task.status and status not in ALLOWED_TRANSITIONS.get(
            task.status, set()
        ):
            return task
        task.status = status
        if error is not None:
            task.error_message = error
        self.db.commit()
        self.db.refresh(task)
        return task

    def fail_unfinished(self, *, reason: str) -> list[Task]:
        """Close out tasks a previous process left mid-flight.

        Execution lives in this process: the orchestrator's asyncio task, its
        event buffer and its in-memory state all die with it. A task still in a
        non-terminal state when the process stops is therefore never going to
        advance, but the record says ``running``, so the task list shows it
        spinning forever and its event stream stays open with nothing to send.
        Marking these failed at startup is the honest reading -- the work did
        not finish -- and it tells the person why rather than leaving them to
        wait on it.

        This assumes one process owns execution, which is what the monolith
        does: a second worker starting up would fail the first one's live
        tasks. Scaling out means moving execution to a queue with a heartbeat
        before calling this on startup.
        """
        stmt = select(Task).where(Task.status.notin_(tuple(TERMINAL_STATUSES)))
        orphaned = list(self.db.scalars(stmt))
        for task in orphaned:
            task.status = "failed"
            task.error_message = reason
        if orphaned:
            self.db.commit()
        return orphaned

    def add_step(self, task_id: UUID, step_name: str) -> TaskStep:
        step = TaskStep(task_id=task_id, step_name=step_name)
        self.db.add(step)
        self.db.commit()
        self.db.refresh(step)
        return step

    def finish_step(self, step_id: UUID, status: str) -> None:
        step = self.db.get(TaskStep, step_id)
        if step is None:
            return
        step.status = status
        step.finished_at = datetime.now(UTC)
        self.db.commit()
