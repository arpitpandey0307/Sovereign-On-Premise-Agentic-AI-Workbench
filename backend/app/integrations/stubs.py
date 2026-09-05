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
    Evidence,
    ModelDescriptor,
    ToolDescriptor,
)

logger = logging.getLogger("workbench.stub")

class UninstalledPolicy:
    """Denies everything. In use only if Part 05 failed to install.

    This was a permissive placeholder while Part 05 was unbuilt. Now that the
    real engine exists, a second copy of the rules here would be a second
    source of truth for security decisions -- and the copy that drifts is
    always the one nobody is looking at.

    So it denies instead. If these reasons appear in a log, the policy engine
    did not start, and denying every request is the correct way for that to be
    noticed rather than a quiet downgrade to placeholder security.
    """

    _REASON = (
        "The policy engine is not installed, so no permission can be granted."
    )

    def check_permission(
        self,
        *,
        user_id: UUID,
        roles: list[str],
        resource: str,
        action: str,
        classification: str | None = None,
    ) -> tuple[bool, str]:
        logger.error("policy check reached the uninstalled placeholder")
        return False, self._REASON

    def check_tool_allowed(
        self, tool: ToolDescriptor, roles: list[str], classification: str
    ) -> tuple[bool, str]:
        logger.error("tool check reached the uninstalled placeholder")
        return False, self._REASON

    def check_model_allowed(
        self, model: ModelDescriptor, *, classification: str
    ) -> tuple[bool, str]:
        return False, self._REASON

    def classify_document(self, *, filename: str, text: str) -> tuple[str, str]:
        # The one method that cannot refuse: ingestion has to label the
        # document as something. The most sensitive level is the safe answer.
        logger.error("classification reached the uninstalled placeholder")
        return "HIGHLY_CONFIDENTIAL", (
            "the policy engine is not installed; defaulted to the most "
            "restrictive level"
        )

    def readable_classifications(self, roles: list[str]) -> list[str]:
        return []


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


class EmptyKnowledge:
    """Part 03 replaces this. Until then there is nothing to retrieve.

    It returns no evidence rather than fabricating any: an agent that is told
    a document says something it does not is worse than one that is told
    nothing is indexed.
    """

    def search(
        self,
        query: str,
        *,
        roles: list[str],
        limit: int = 5,
        document_ids: list[UUID] | None = None,
    ) -> list[Evidence]:
        logger.info("knowledge search for %r (Part 03 not wired yet)", query[:80])
        return []

    def status(self) -> dict:
        return {"available": False, "detail": "Part 03 not wired yet"}


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
