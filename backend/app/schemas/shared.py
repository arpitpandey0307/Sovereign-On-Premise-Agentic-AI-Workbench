"""Cross-part data contracts.

Every part of the backend serialises and deserialises these objects. They are
defined once here and imported everywhere; no part redefines them locally.
Ownership is noted per model -- the owning part is the only one that mutates
the underlying record, everyone else treats it as read-only.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

TaskStatus = Literal[
    "pending",
    "planning",
    "running",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
]

ModelType = Literal["reasoning", "vision", "coding", "embedding", "reranking"]
RiskLevel = Literal["low", "medium", "high"]
ArtifactType = Literal["docx", "xlsx", "pptx", "pdf", "code"]
ValidationStatus = Literal["pending", "passed", "failed"]


class Task(BaseModel):
    """Owned by Part 01, read by Parts 02-05."""

    task_id: UUID
    user_id: UUID
    conversation_id: UUID
    request_text: str
    input_file_ids: list[UUID] = Field(default_factory=list)
    task_type: str
    status: TaskStatus
    created_at: datetime


class AgentEvent(BaseModel):
    """Emitted by Part 04, streamed to the browser by Part 01's SSE endpoint."""

    task_id: UUID
    event: str
    component: str
    timestamp: datetime
    data: dict = Field(default_factory=dict)


class ModelDescriptor(BaseModel):
    """Owned by Part 02, consulted by Parts 04 and 05."""

    model_config = ConfigDict(protected_namespaces=())

    model_id: str
    type: ModelType
    capabilities: list[str] = Field(default_factory=list)
    context_length: int
    vram_required_gb: float
    approved_for: list[str] = Field(default_factory=list)
    status: Literal["ready", "loading", "unavailable"]


class ToolDescriptor(BaseModel):
    """Owned by Part 04, checked against Part 05's policy engine."""

    name: str
    risk_level: RiskLevel
    requires_approval: bool
    input_schema: dict = Field(default_factory=dict)


class Evidence(BaseModel):
    """Produced by Part 03, consumed by Part 04 and the citation UI."""

    document_id: UUID
    document_name: str
    page: int
    section: str | None = None
    text: str
    score: float


class Artifact(BaseModel):
    """Produced by Part 04, served by Part 01, logged by Part 05."""

    artifact_id: UUID
    task_id: UUID
    type: ArtifactType
    storage_path: str
    validation_status: ValidationStatus


class AuditEvent(BaseModel):
    """Written by every part; only Part 05 owns the ledger table."""

    task_id: UUID | None = None
    user_id: UUID | None = None
    event_type: str
    component: str
    action: str
    metadata: dict = Field(default_factory=dict)
    timestamp: datetime
