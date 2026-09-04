"""Conversation and message CRUD."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status

from app.core.dependencies import DbSession, record_audit, require
from app.core.errors import NotFoundError
from app.db.models import User
from app.db.repositories.conversations import ConversationRepository
from app.schemas.api import (
    ConversationCreate,
    ConversationDetailResponse,
    ConversationResponse,
    MessageCreate,
    MessageResponse,
    Page,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])

ReadUser = Annotated[User, Depends(require("conversation", "read"))]
WriteUser = Annotated[User, Depends(require("conversation", "write"))]


def _owned(db: DbSession, conversation_id: UUID, user: User):
    conversation = ConversationRepository(db).get(conversation_id)
    # A conversation belonging to someone else is reported as absent rather
    # than forbidden, so ids cannot be probed for existence.
    if conversation is None or conversation.user_id != user.id:
        raise NotFoundError("Conversation not found.")
    return conversation


@router.post("", response_model=ConversationResponse, status_code=status.HTTP_201_CREATED)
def create_conversation(
    payload: ConversationCreate, user: WriteUser, db: DbSession
) -> ConversationResponse:
    conversation = ConversationRepository(db).create(
        user_id=user.id, title=payload.title
    )
    record_audit(
        event_type="CONVERSATION_CREATED",
        action="conversation:create",
        user_id=user.id,
        metadata={"conversation_id": str(conversation.id)},
    )
    return ConversationResponse.model_validate(conversation)


@router.get("", response_model=Page[ConversationResponse])
def list_conversations(
    user: ReadUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[ConversationResponse]:
    repo = ConversationRepository(db)
    items = repo.list_for_user(user.id, limit=limit, offset=offset)
    return Page(
        items=[ConversationResponse.model_validate(item) for item in items],
        total=repo.count_for_user(user.id),
        limit=limit,
        offset=offset,
    )


@router.get("/{conversation_id}", response_model=ConversationDetailResponse)
def get_conversation(
    conversation_id: UUID, user: ReadUser, db: DbSession
) -> ConversationDetailResponse:
    conversation = _owned(db, conversation_id, user)
    messages = ConversationRepository(db).messages(conversation_id)
    return ConversationDetailResponse(
        id=conversation.id,
        user_id=conversation.user_id,
        title=conversation.title,
        created_at=conversation.created_at,
        messages=[MessageResponse.model_validate(message) for message in messages],
    )


@router.post(
    "/{conversation_id}/messages",
    response_model=MessageResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_message(
    conversation_id: UUID, payload: MessageCreate, user: WriteUser, db: DbSession
) -> MessageResponse:
    _owned(db, conversation_id, user)
    message = ConversationRepository(db).add_message(
        conversation_id=conversation_id, role=payload.role, content=payload.content
    )
    return MessageResponse.model_validate(message)
