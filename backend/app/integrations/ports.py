"""Interfaces Part 01 depends on, owned by other parts.

Part 01 never imports another part's internals. It calls these protocols, and
each owning part registers a concrete implementation at startup (see
``app/integrations/registry.py``). Until a part lands, a stub in
``app/integrations/stubs.py`` stands in, so the API is runnable end to end
from day one.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable
from uuid import UUID

from app.schemas.shared import (
    Artifact,
    AuditEvent,
    Evidence,
    ModelDescriptor,
    ToolDescriptor,
)


@runtime_checkable
class ModelPort(Protocol):
    """Part 02 -- the model router.

    Part 01 never calls this during a request; the orchestrator is the only
    caller in normal operation. It is declared here so the registry can report
    model-runtime reachability on ``/health``, which is what makes an
    air-gapped deployment verifiable before a demo starts.
    """

    def available_models(self) -> list[ModelDescriptor]: ...

    async def health(self) -> tuple[bool, str]:
        """Return ``(reachable, detail)`` for the local model runtime."""
        ...


@runtime_checkable
class PolicyPort(Protocol):
    """Part 05 -- permission checks performed before an endpoint acts."""

    def check_permission(
        self,
        *,
        user_id: UUID,
        roles: list[str],
        resource: str,
        action: str,
        classification: str = "INTERNAL",
    ) -> tuple[bool, str]:
        """Return ``(allowed, reason)``. A denial must always carry a reason."""
        ...

    def check_tool_allowed(
        self, tool: ToolDescriptor, roles: list[str], classification: str
    ) -> tuple[bool, str]: ...

    def check_model_allowed(
        self, model: ModelDescriptor, *, classification: str
    ) -> tuple[bool, str]:
        """Part 02's policy-filter stage calls this for every candidate.

        Part 02 never decides whether a model may see a classification -- it
        asks here and records the answer in the routing rationale.
        """
        ...

    def classify_document(self, *, filename: str, text: str) -> tuple[str, str]:
        """Return ``(classification, reason)`` for a document being ingested.

        Part 03 supplies the text and never decides the level: sensitivity is
        Part 05's rule set, and a second implementation of it in the ingestion
        pipeline is a second thing to keep correct.
        """
        ...

    def readable_classifications(self, roles: list[str]) -> list[str]:
        """The levels these roles may read, for filtering retrieval.

        Returned as a list rather than a ceiling so a caller cannot be handed
        a level by getting the ordering wrong.
        """
        ...


@runtime_checkable
class AuditPort(Protocol):
    """Part 05 -- append-only ledger. Writes here are never updated or deleted."""

    def record(self, event: AuditEvent) -> None: ...

    def trace(self, task_id: UUID) -> list[AuditEvent]:
        """Full historical trace for ``GET /tasks/{id}/trace``."""
        ...


@runtime_checkable
class DocumentsPort(Protocol):
    """Part 03 -- ingestion is triggered by Part 01 on upload."""

    def ingest(self, file_id: UUID) -> None: ...


@runtime_checkable
class KnowledgePort(Protocol):
    """Part 03 -- retrieval, exposed to Part 04 as a tool.

    The orchestrator never queries the knowledge store directly; it calls
    ``search`` and gets back citable ``Evidence``. Keeping that boundary is
    what lets the store change from Neo4j to anything else without the agent
    noticing.
    """

    def search(
        self,
        query: str,
        *,
        roles: list[str],
        limit: int = 5,
        document_ids: list[UUID] | None = None,
    ) -> list[Evidence]:
        """Ranked evidence the caller's roles are cleared to read."""
        ...

    def status(self) -> dict:
        """Index reachability and corpus size, for the system status view."""
        ...


@runtime_checkable
class OrchestratorPort(Protocol):
    """Part 04 -- task execution. Part 01 only starts, cancels and resumes."""

    async def start(self, task_id: UUID) -> None: ...

    async def cancel(self, task_id: UUID) -> None: ...

    async def resume(self, task_id: UUID, *, approved: bool, note: str = "") -> None: ...


@runtime_checkable
class ArtifactsPort(Protocol):
    """Part 04 -- Part 01 proxies downloads after an auth check."""

    def get(self, artifact_id: UUID) -> Artifact | None: ...

    def list_for_task(self, task_id: UUID) -> list[Artifact]: ...
