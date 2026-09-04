"""Task lifecycle endpoints and the live execution stream.

Part 01 owns the task *record*; Part 04 owns its *execution*. Everything here
either reads that record or hands off to the orchestrator -- no agent logic
lives in this module.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import StreamingResponse

from app.core.dependencies import DbSession, record_audit, require
from app.core.errors import ConflictError, NotFoundError
from app.core.events import event_bus
from app.db.database import SessionLocal
from app.db.models import User
from app.db.repositories.conversations import ConversationRepository
from app.db.repositories.files import FileRepository
from app.db.repositories.tasks import TERMINAL_STATUSES, TaskRepository
from app.integrations import registry
from app.schemas.api import (
    Page,
    TaskCreate,
    TaskDetailResponse,
    TaskResponse,
    TaskResumeRequest,
    TaskStepResponse,
    TraceEntry,
)

router = APIRouter(prefix="/tasks", tags=["tasks"])

ReadUser = Annotated[User, Depends(require("task", "read"))]
WriteUser = Annotated[User, Depends(require("task", "create"))]

# How long the SSE stream waits for an event before emitting a keepalive.
SSE_HEARTBEAT_SECONDS = 15.0

logger = logging.getLogger("workbench.tasks")

# asyncio only holds a weak reference to a running task, so a fire-and-forget
# handoff can be garbage collected mid-execution. Keeping the reference here
# until it finishes is what makes the handoff reliable.
_background: set[asyncio.Task] = set()


def _spawn(coro, *, task_id: UUID) -> None:
    handle = asyncio.create_task(coro)
    _background.add(handle)

    def _done(finished: asyncio.Task) -> None:
        _background.discard(finished)
        if finished.cancelled():
            return
        if exc := finished.exception():
            # The orchestrator crashed outside its own handler. Record it and
            # close the stream, or the browser waits on a task that is gone.
            logger.exception("orchestrator handoff failed for %s", task_id, exc_info=exc)
            with SessionLocal() as db:
                TaskRepository(db).set_status(task_id, "failed", error=str(exc))
            event_bus.emit(task_id, "task_failed", "api", {"error": str(exc)})

    handle.add_done_callback(_done)


def _to_response(task) -> TaskResponse:
    return TaskResponse(
        task_id=task.id,
        conversation_id=task.conversation_id,
        user_id=task.user_id,
        request_text=task.request_text,
        task_type=task.task_type,
        status=task.status,
        input_file_ids=[UUID(file_id) for file_id in task.input_file_ids or []],
        error_message=task.error_message,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


def _owned(db: DbSession, task_id: UUID, user: User):
    task = TaskRepository(db).get(task_id)
    if task is None or task.user_id != user.id:
        raise NotFoundError("Task not found.")
    return task


@router.post("", response_model=TaskResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_task(
    payload: TaskCreate, user: WriteUser, db: DbSession
) -> TaskResponse:
    conversation = ConversationRepository(db).get(payload.conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise NotFoundError("Conversation not found.")

    if payload.input_file_ids:
        found = FileRepository(db).get_many(payload.input_file_ids)
        owned_ids = {record.id for record in found if record.owner_id == user.id}
        missing = set(payload.input_file_ids) - owned_ids
        if missing:
            raise NotFoundError(
                "One or more input files were not found.",
                details={"missing_file_ids": [str(file_id) for file_id in missing]},
            )

    task = TaskRepository(db).create(
        user_id=user.id,
        conversation_id=payload.conversation_id,
        request_text=payload.request_text,
        task_type=payload.task_type,
        input_file_ids=payload.input_file_ids,
    )

    record_audit(
        event_type="TASK_STARTED",
        action="task:create",
        user_id=user.id,
        task_id=task.id,
        metadata={
            "task_type": task.task_type,
            "input_file_count": len(payload.input_file_ids),
        },
    )
    event_bus.emit(task.id, "task_created", "api", {"status": "pending"})

    # Hand off and return immediately -- the response must not wait on the
    # orchestrator. The task is scheduled on this loop rather than through
    # BackgroundTasks so the SSE stream can attach while it is already running.
    _spawn(registry.get_orchestrator().start(task.id), task_id=task.id)

    return _to_response(task)


@router.get("", response_model=Page[TaskResponse])
def list_tasks(
    user: ReadUser,
    db: DbSession,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[TaskResponse]:
    repo = TaskRepository(db)
    items = repo.list_for_user(
        user.id, status=status_filter, limit=limit, offset=offset
    )
    return Page(
        items=[_to_response(item) for item in items],
        total=repo.count_for_user(user.id, status=status_filter),
        limit=limit,
        offset=offset,
    )


@router.get("/{task_id}", response_model=TaskDetailResponse)
def get_task(task_id: UUID, user: ReadUser, db: DbSession) -> TaskDetailResponse:
    task = _owned(db, task_id, user)
    base = _to_response(task)
    return TaskDetailResponse(
        # ``id`` is a computed alias, so it must not be passed back in.
        **base.model_dump(exclude={"id"}),
        steps=[TaskStepResponse.model_validate(step) for step in task.steps],
    )


@router.post("/{task_id}/cancel", response_model=TaskResponse)
async def cancel_task(task_id: UUID, user: WriteUser, db: DbSession) -> TaskResponse:
    task = _owned(db, task_id, user)
    if task.status in TERMINAL_STATUSES:
        raise ConflictError(f"Task is already {task.status} and cannot be cancelled.")

    await registry.get_orchestrator().cancel(task_id)
    updated = TaskRepository(db).set_status(task_id, "cancelled")
    record_audit(
        event_type="TASK_CANCELLED",
        action="task:cancel",
        user_id=user.id,
        task_id=task_id,
    )
    event_bus.emit(task_id, "task_cancelled", "api", {"cancelled_by": str(user.id)})
    return _to_response(updated or task)


@router.post("/{task_id}/resume", response_model=TaskResponse)
async def resume_task(
    task_id: UUID, payload: TaskResumeRequest, user: WriteUser, db: DbSession
) -> TaskResponse:
    task = _owned(db, task_id, user)
    if task.status != "waiting_approval":
        raise ConflictError(
            f"Task is {task.status}; only a task waiting for approval can be resumed."
        )

    record_audit(
        event_type="APPROVAL_GRANTED" if payload.approved else "APPROVAL_DENIED",
        action="task:resume",
        user_id=user.id,
        task_id=task_id,
        metadata={"note": payload.note},
    )
    _spawn(
        registry.get_orchestrator().resume(
            task_id, approved=payload.approved, note=payload.note
        ),
        task_id=task_id,
    )
    return _to_response(task)


@router.get("/{task_id}/events")
async def stream_events(
    task_id: UUID, user: ReadUser, db: DbSession, request: Request
) -> StreamingResponse:
    """SSE transport for Part 04's ``AgentEvent`` stream.

    The content of the stream belongs to Part 04. This endpoint only
    authenticates, replays anything emitted before the browser attached, and
    forwards until the task reaches a terminal event or the client leaves.
    """
    task = _owned(db, task_id, user)
    queue, backlog = event_bus.subscribe(task_id)
    already_finished = task.status in TERMINAL_STATUSES

    async def publisher() -> AsyncIterator[str]:
        try:
            for event in backlog:
                yield _format_sse(event.event, event.model_dump(mode="json"))

            if already_finished and not backlog:
                yield _format_sse(
                    f"task_{task.status}", {"task_id": str(task_id), "replayed": True}
                )
                return

            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(
                        queue.get(), timeout=SSE_HEARTBEAT_SECONDS
                    )
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue

                if event is None:  # end of stream
                    break
                yield _format_sse(event.event, event.model_dump(mode="json"))
        finally:
            event_bus.unsubscribe(task_id, queue)

    return StreamingResponse(
        publisher(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # stop nginx buffering the stream
        },
    )


def _format_sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.get("/{task_id}/trace", response_model=list[TraceEntry])
def get_trace(task_id: UUID, user: ReadUser, db: DbSession) -> list[TraceEntry]:
    """Full historical trace, read from Part 05's audit ledger."""
    _owned(db, task_id, user)
    return [
        TraceEntry(
            task_id=event.task_id,
            event_type=event.event_type,
            component=event.component,
            action=event.action,
            metadata=event.metadata,
            timestamp=event.timestamp,
        )
        for event in registry.get_audit().trace(task_id)
    ]
