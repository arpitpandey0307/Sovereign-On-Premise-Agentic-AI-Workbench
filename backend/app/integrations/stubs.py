"""Stand-in implementations of the ports until Parts 03-05 land.

Each stub is deliberately honest: it does the least thing that keeps the API
contract truthful, and it emits the same events and audit records the real
implementation will, so the frontend and the SSE stream can be built against
it. None of them fabricate model output.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from uuid import UUID

import httpx

from app.core.events import event_bus
from app.schemas.shared import (
    Artifact,
    AuditEvent,
    ModelDescriptor,
    ToolDescriptor,
)

logger = logging.getLogger("workbench.stub")

# Classification ordering from Part 05, section 3.
CLASSIFICATION_ORDER = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_CONFIDENTIAL"]

ROLE_MAX_CLASSIFICATION = {
    "ENGINEER": "CONFIDENTIAL",
    "ANALYST": "CONFIDENTIAL",
    "MANAGER": "HIGHLY_CONFIDENTIAL",
    "ADMIN": "HIGHLY_CONFIDENTIAL",
    "SECURITY_ADMIN": "HIGHLY_CONFIDENTIAL",
}


# Which roles may perform which action on which resource. Part 05 owns the
# real engine; this table exists so that until it lands the permission checks
# are actually enforced rather than waved through. Anything not listed is
# denied -- a placeholder must fail closed, not open.
PERMISSION_MATRIX: dict[tuple[str, str], set[str]] = {
    ("conversation", "read"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("conversation", "write"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("file", "read"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("file", "upload"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("file", "delete"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("task", "read"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("task", "create"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("artifact", "download"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"},
    ("model", "read"): {"ENGINEER", "ANALYST", "MANAGER", "ADMIN", "SECURITY_ADMIN"},
    # Operational actions that change system state, not just the caller's own
    # data. Deliberately narrower.
    ("model", "admin"): {"ADMIN"},
    ("system", "read"): {"ADMIN", "SECURITY_ADMIN"},
    ("audit", "read"): {"ADMIN", "SECURITY_ADMIN"},
}


class PermissivePolicy:
    """Role-aware placeholder. Part 05 replaces this with the real engine.

    Named "permissive" because its classification rules are generous, not
    because it grants everything: unknown permissions are denied.
    """

    def check_permission(
        self,
        *,
        user_id: UUID,
        roles: list[str],
        resource: str,
        action: str,
        classification: str = "INTERNAL",
    ) -> tuple[bool, str]:
        if not roles:
            return False, "User has no assigned role."

        held = set(roles)
        permitted = PERMISSION_MATRIX.get((resource, action))
        if permitted is None:
            # Fail closed: an unmapped permission is a bug, and guessing in
            # the caller's favour is how privilege escalation happens.
            return False, f"No policy defines {resource}:{action}."
        if not held & permitted:
            return False, (
                f"{resource}:{action} requires one of "
                f"{sorted(permitted)}; caller holds {sorted(held)}."
            )

        ceiling = max(
            (ROLE_MAX_CLASSIFICATION.get(role, "PUBLIC") for role in held),
            key=CLASSIFICATION_ORDER.index,
        )
        if CLASSIFICATION_ORDER.index(classification) > CLASSIFICATION_ORDER.index(
            ceiling
        ):
            return False, (
                f"Roles {sorted(held)} are cleared to {ceiling}, "
                f"which is below {classification}."
            )
        return True, "allowed"

    def check_tool_allowed(
        self, tool: ToolDescriptor, roles: list[str], classification: str
    ) -> tuple[bool, str]:
        if classification == "HIGHLY_CONFIDENTIAL" and tool.risk_level == "high":
            return False, "High-risk tools are barred at HIGHLY_CONFIDENTIAL."
        return True, "allowed"

    def check_model_allowed(
        self, model: ModelDescriptor, *, classification: str
    ) -> tuple[bool, str]:
        level = classification.upper()

        # An explicit approval list on the model always wins. An empty list
        # means "not yet classified by Part 05", not "approved for nothing".
        approved = {value.upper() for value in model.approved_for}
        if approved and level not in approved:
            return False, f"not approved for {level} (approved: {sorted(approved)})"

        # The rule that matters on this system, stated even though every model
        # here is local: confidential data never reaches a remote model.
        if level in {"CONFIDENTIAL", "HIGHLY_CONFIDENTIAL"} and model.status != "ready":
            return False, f"model is {model.status}; {level} work needs a ready model"

        return True, f"permitted at {level}"


class InMemoryAudit:
    """Append-only in memory. Part 05 swaps in the Postgres ledger."""

    def __init__(self) -> None:
        self._events: list[AuditEvent] = []

    def record(self, event: AuditEvent) -> None:
        self._events.append(event)
        logger.info(
            "audit %s/%s task=%s user=%s",
            event.component,
            event.action,
            event.task_id,
            event.user_id,
        )

    def trace(self, task_id: UUID) -> list[AuditEvent]:
        return [event for event in self._events if event.task_id == task_id]


class NoopDocuments:
    """Part 03 replaces this with the real ingestion pipeline."""

    def ingest(self, file_id: UUID) -> None:
        logger.info("ingestion requested for file %s (Part 03 not wired yet)", file_id)


class EchoOrchestrator:
    """Proves the task lifecycle and the SSE stream without any agent logic.

    It walks a task through the real status transitions and emits the same
    event names Part 04 will emit, so the frontend timeline can be built and
    tested before the LangGraph orchestrator exists.
    """

    def __init__(self) -> None:
        self._cancelled: set[UUID] = set()

    async def start(self, task_id: UUID) -> None:
        from app.db.database import SessionLocal
        from app.db.repositories.tasks import TaskRepository

        try:
            for step, status in (
                ("planning", "planning"),
                ("executing", "running"),
            ):
                if task_id in self._cancelled:
                    break
                with SessionLocal() as db:
                    TaskRepository(db).set_status(task_id, status)
                event_bus.emit(
                    task_id,
                    "step_started",
                    "orchestrator",
                    {"step": step, "note": "stub orchestrator"},
                )
                await asyncio.sleep(0.2)

            final = "cancelled" if task_id in self._cancelled else "completed"
            with SessionLocal() as db:
                TaskRepository(db).set_status(task_id, final)
            event_bus.emit(
                task_id,
                f"task_{final}",
                "orchestrator",
                {"note": "stub orchestrator; Part 04 not wired yet"},
            )
        except Exception as exc:  # keep a crashed run from hanging the stream
            logger.exception("stub orchestrator failed for task %s", task_id)
            with SessionLocal() as db:
                TaskRepository(db).set_status(task_id, "failed", error=str(exc))
            event_bus.emit(task_id, "task_failed", "orchestrator", {"error": str(exc)})
        finally:
            self._cancelled.discard(task_id)

    async def cancel(self, task_id: UUID) -> None:
        self._cancelled.add(task_id)

    async def resume(self, task_id: UUID, *, approved: bool, note: str = "") -> None:
        event_bus.emit(
            task_id,
            "approval_granted" if approved else "approval_denied",
            "orchestrator",
            {"note": note},
        )
        if approved:
            await self.start(task_id)
        else:
            from app.db.database import SessionLocal
            from app.db.repositories.tasks import TaskRepository

            with SessionLocal() as db:
                TaskRepository(db).set_status(task_id, "cancelled")
            event_bus.emit(task_id, "task_cancelled", "orchestrator", {"note": note})


class LocalOllamaProbe:
    """Minimal Part 02 placeholder: proves the local runtime is reachable.

    It lists what Ollama has loaded and reports whether the daemon answers.
    It does no inference and makes no judgement about routing -- Part 02 owns
    the registry, the router and the adapters. The single purpose here is the
    Day 1 requirement that the API can see a locally running model, and the
    sovereignty claim that the only model endpoint is on this machine.
    """

    def __init__(self, base_url: str = "http://127.0.0.1:11434") -> None:
        self.base_url = base_url

    def available_models(self) -> list[ModelDescriptor]:
        try:
            with httpx.Client(timeout=2.0) as client:
                tags = client.get(f"{self.base_url}/api/tags").json()
        except Exception:
            return []

        descriptors = []
        for entry in tags.get("models", []):
            size_gb = round(entry.get("size", 0) / 1_000_000_000, 1)
            descriptors.append(
                ModelDescriptor(
                    model_id=entry.get("name", "unknown"),
                    type="reasoning",
                    capabilities=["text"],
                    context_length=0,  # Part 02 fills this from its registry
                    vram_required_gb=size_gb,
                    approved_for=[],  # Part 05 decides this
                    status="ready",
                )
            )
        return descriptors

    async def health(self) -> tuple[bool, str]:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
            count = len(response.json().get("models", []))
            return True, f"local runtime reachable, {count} model(s) present"
        except Exception as exc:
            return False, f"local runtime unreachable: {type(exc).__name__}"


class EmptyArtifacts:
    """Part 04 owns real artifacts; until then there are none to serve."""

    def get(self, artifact_id: UUID) -> Artifact | None:
        return None

    def list_for_task(self, task_id: UUID) -> list[Artifact]:
        return []


def audit_event(
    *,
    event_type: str,
    action: str,
    component: str = "api",
    user_id: UUID | None = None,
    task_id: UUID | None = None,
    metadata: dict | None = None,
) -> AuditEvent:
    return AuditEvent(
        task_id=task_id,
        user_id=user_id,
        event_type=event_type,
        component=component,
        action=action,
        metadata=metadata or {},
        timestamp=datetime.now(UTC),
    )
