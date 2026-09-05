"""Orchestration endpoints: the execution trace and the tool catalogue.

Part 04 computes these; Part 01 owns the HTTP surface, so the routes live
alongside the others. They power the execution timeline, the approval-gate UI
and the "what can this agent actually do" panel.

The trace here is the orchestrator's own view of a run -- the plan it made,
the steps it took, the sources it cited. That is different from
``GET /tasks/{id}/trace``, which is Part 05's audit ledger: one is what the
agent did, the other is the immutable record that it did it.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.dependencies import DbSession, require
from app.core.errors import NotFoundError
from app.db.models import User
from app.db.repositories.tasks import TaskRepository
from app.integrations import registry
from app.schemas.api import ArtifactResponse

router = APIRouter(tags=["orchestration"])

ReadUser = Annotated[User, Depends(require("task", "read"))]
SystemUser = Annotated[User, Depends(require("system", "read"))]


def _owned_task(db, task_id: UUID, user: User):
    task = TaskRepository(db).get(task_id)
    if task is None or task.user_id != user.id:
        raise NotFoundError("Task not found.")
    return task


@router.get("/api/v1/tasks/{task_id}/execution")
def execution_trace(task_id: UUID, user: ReadUser, db: DbSession) -> dict:
    """What the agent planned, did, cited and produced.

    Returned even for a failed run: a trace that disappears when a task fails
    is missing exactly when it is most needed.
    """
    task = _owned_task(db, task_id, user)

    orchestrator = registry.get_orchestrator()
    trace = getattr(orchestrator, "trace", None)
    detail = trace(task_id) if trace is not None else {}

    return {
        "task_id": str(task_id),
        "status": task.status,
        "request": task.request_text,
        **detail,
    }


@router.get("/api/v1/tasks/{task_id}/artifacts", response_model=list[ArtifactResponse])
def task_artifacts(
    task_id: UUID, user: ReadUser, db: DbSession
) -> list[ArtifactResponse]:
    """Every artifact this task produced, including ones that failed checks.

    A rejected artifact is listed rather than hidden: the operator needs to
    see what the validator objected to, and hiding it would make a
    regeneration look like the only attempt.
    """
    from app.core.config import settings

    _owned_task(db, task_id, user)
    return [
        ArtifactResponse(
            artifact_id=artifact.artifact_id,
            task_id=artifact.task_id,
            type=artifact.type,
            validation_status=artifact.validation_status,
            download_url=(
                f"{settings.api_v1_prefix}/artifacts/"
                f"{artifact.artifact_id}/download"
            ),
        )
        for artifact in registry.get_artifacts().list_for_task(task_id)
    ]


@router.get("/api/v1/tools")
def list_tools(user: ReadUser) -> dict:
    """The tools the agent may ask for, with their declared risk.

    Read-only and non-invocable on purpose. There is no endpoint that runs a
    tool: the only path to execution is through the orchestrator, which is
    what keeps the policy check on every call.
    """
    from app.tools.gateway import gateway

    return {"tools": gateway.catalogue()}


@router.get("/internal/sandbox/status", include_in_schema=False)
def sandbox_status(user: SystemUser) -> dict:
    """Whether code execution is available, and how it is confined."""
    from app.sandbox.docker_runner import docker_sandbox

    available, detail = docker_sandbox.available()
    return {
        "runner": docker_sandbox.name,
        "available": available,
        "detail": detail,
        "image": docker_sandbox.image,
        # Stated rather than assumed: this is the claim the sovereignty
        # argument rests on, so it belongs where an operator can read it.
        "confinement": {
            "network": "none",
            "root_filesystem": "read-only",
            "workspace": "tmpfs, discarded after the run",
            "capabilities": "all dropped, no-new-privileges",
            "user": "nobody (65534)",
        },
    }
