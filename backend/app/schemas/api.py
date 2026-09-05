"""Request and response models for the HTTP surface.

These are the wire shapes the frontend codes against. They are separate from
``schemas/shared.py``: that file holds cross-part contracts, this one holds
Part 01's own API envelope.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, computed_field

from app.schemas.shared import TaskStatus

# Deliberately not ``EmailStr``: it rejects reserved internal TLDs such as
# ``.local`` and ``.internal``, which are precisely the domains an air-gapped
# on-premise deployment uses. Shape is validated, deliverability is not.
InternalEmail = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        max_length=320,
        pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
    ),
]


class Page[T](BaseModel):
    items: list[T]
    total: int
    limit: int
    offset: int


# --- auth -----------------------------------------------------------------


class LoginRequest(BaseModel):
    email: InternalEmail
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: datetime


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    name: str
    roles: list[str]


# --- conversations --------------------------------------------------------


class ConversationCreate(BaseModel):
    title: str = Field(default="New conversation", max_length=255)


class MessageCreate(BaseModel):
    content: str = Field(min_length=1)
    role: str = Field(default="user", pattern="^(user|assistant|system)$")


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    conversation_id: UUID
    role: str
    content: str
    created_at: datetime


class ConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    title: str
    created_at: datetime


class ConversationDetailResponse(ConversationResponse):
    messages: list[MessageResponse] = []


# --- files ----------------------------------------------------------------


class FileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    owner_id: UUID
    filename: str
    mime_type: str
    size_bytes: int
    sha256: str
    ingestion_status: str
    uploaded_at: datetime


# --- tasks ----------------------------------------------------------------


class TaskCreate(BaseModel):
    conversation_id: UUID
    request_text: str = Field(min_length=1)
    task_type: str = Field(default="general", max_length=64)
    input_file_ids: list[UUID] = Field(default_factory=list)


class TaskStepResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    step_name: str
    status: str
    started_at: datetime
    finished_at: datetime | None


class TaskResponse(BaseModel):
    """Wire shape for a task.

    The field is ``task_id``, matching the shared ``Task`` contract in
    ``schemas/shared.py`` and the response shape in the Part 01 spec. ``id``
    is serialised alongside it as an alias so a client written against either
    name works.
    """

    model_config = ConfigDict(from_attributes=True)

    task_id: UUID
    conversation_id: UUID
    user_id: UUID
    request_text: str
    task_type: str
    status: TaskStatus
    input_file_ids: list[UUID] = []
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def id(self) -> UUID:
        return self.task_id


class TaskDetailResponse(TaskResponse):
    steps: list[TaskStepResponse] = []


class TaskResumeRequest(BaseModel):
    approved: bool = True
    note: str = ""


class TraceEntry(BaseModel):
    task_id: UUID | None
    event_type: str
    component: str
    action: str
    metadata: dict
    timestamp: datetime


# --- artifacts ------------------------------------------------------------


class ArtifactResponse(BaseModel):
    artifact_id: UUID
    task_id: UUID
    type: str
    validation_status: str
    download_url: str


# --- documents and knowledge (Part 03) ------------------------------------


class DocumentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    file_id: UUID
    filename: str
    mime_type: str
    kind: str
    classification: str
    classification_reason: str
    version: int
    status: str
    page_count: int
    chunk_count: int
    indexed_in_graph: bool
    ingest_error: str
    created_at: datetime


class DocumentPageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    page_number: int
    text: str
    # How the text was obtained. The viewer shows this so a reader knows
    # whether a quotation came from a text layer or from an OCR guess.
    ocr_status: str
    ocr_confidence: float
    needs_vision: bool
    # What a vision model said about the page, kept apart from ``text`` so the
    # viewer can show a description as a description and never as a quotation.
    vision_summary: str = ""
    vision_model: str = ""
    vision_status: str = "not_required"


class DocumentEntityResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    tag: str
    entity_type: str
    page: int
    occurrences: int


class DocumentDetailResponse(DocumentResponse):
    pages: list[DocumentPageResponse] = []
    entities: list[DocumentEntityResponse] = []


class EvidenceResponse(BaseModel):
    """The citation contract from ``schemas/shared.py``, on the wire."""

    document_id: UUID
    document_name: str
    page: int
    section: str | None = None
    text: str
    score: float


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    limit: int = Field(default=5, ge=1, le=25)
    # Narrow the search to specific documents, for "ask about this file".
    document_ids: list[UUID] = Field(default_factory=list)


class SearchResponse(BaseModel):
    query: str
    evidence: list[EvidenceResponse]
    # Which backend answered, what was filtered, and why -- this is what makes
    # a retrieval result auditable rather than a black box.
    diagnostics: dict
