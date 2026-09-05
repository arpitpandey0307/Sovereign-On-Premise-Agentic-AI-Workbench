"""Document-level tables (Part 03).

Section 4 of the Part 03 spec puts document metadata in the relational store
and chunks in Neo4j. Chunks are kept here as well, and deliberately so: the
relational row is the record of what was ingested, and Neo4j holds the vector
and graph *index* over it. That split means an ingested document is never lost
because a graph database was down, and retrieval can degrade to a slower local
search instead of failing outright -- which matters on an air-gapped box where
nobody can be paged to restart a service.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.db.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


class Document(Base):
    """One ingested file. Mirrors the ``files`` row it was produced from."""

    __tablename__ = "documents"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    # The upload this was derived from. One file ingests to one document, so
    # re-ingesting replaces rather than duplicates.
    file_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("files.id", ondelete="CASCADE"), unique=True, index=True
    )
    owner_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )

    filename: Mapped[str] = mapped_column(String(512))
    mime_type: Mapped[str] = mapped_column(String(255))
    size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    department: Mapped[str] = mapped_column(String(128), default="")

    # Decided by Part 05's rules, asked for at ingestion time. Never guessed
    # here: this module supplies the text, the policy engine supplies the level.
    classification: Mapped[str] = mapped_column(
        String(32), default="INTERNAL", index=True
    )
    classification_reason: Mapped[str] = mapped_column(Text, default="")

    version: Mapped[int] = mapped_column(Integer, default=1)
    checksum: Mapped[str] = mapped_column(String(64), index=True)
    storage_path: Mapped[str] = mapped_column(String(1024))

    # "active" documents are the only ones retrieval will cite. Superseded
    # versions stay readable but drop out of search.
    status: Mapped[str] = mapped_column(String(32), default="active", index=True)
    kind: Mapped[str] = mapped_column(String(32), default="unknown")
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)

    # Set when the graph index actually accepted this document's chunks, so a
    # degraded retrieval path can say which documents it cannot search well.
    indexed_in_graph: Mapped[bool] = mapped_column(default=False)
    ingest_error: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    pages: Mapped[list[DocumentPage]] = relationship(
        back_populates="document", cascade="all, delete-orphan", lazy="selectin"
    )
    chunks: Mapped[list[DocumentChunk]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )
    entities: Mapped[list[DocumentEntity]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class DocumentPage(Base):
    """One page of extracted text, and how that text was obtained."""

    __tablename__ = "document_pages"
    __table_args__ = (UniqueConstraint("document_id", "page_number"),)

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    page_number: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, default="")
    # Rendered raster, kept only for pages a vision model still has to look at.
    image_path: Mapped[str] = mapped_column(String(1024), default="")

    # "native" | "ocr" | "empty" | "failed" -- how the text on this page was
    # obtained, which the citation UI shows so a reader knows whether a quote
    # came from a text layer or from an OCR guess.
    ocr_status: Mapped[str] = mapped_column(String(32), default="native")
    ocr_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    # True for drawings, photos and dense tables: the spec is explicit that
    # these get a vision pass rather than being trusted to OCR alone.
    needs_vision: Mapped[bool] = mapped_column(default=False)

    document: Mapped[Document] = relationship(back_populates="pages")


class DocumentChunk(Base):
    """A retrievable span of text with its page and section kept intact."""

    __tablename__ = "document_chunks"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
    page: Mapped[int] = mapped_column(Integer, default=1, index=True)
    section: Mapped[str | None] = mapped_column(String(255), nullable=True)
    text: Mapped[str] = mapped_column(Text)

    # Denormalised from the parent so a retrieval filter never has to join
    # before it can discard a chunk the caller is not cleared to see.
    classification: Mapped[str] = mapped_column(
        String(32), default="INTERNAL", index=True
    )

    embedding: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)
    embedding_model: Mapped[str] = mapped_column(String(128), default="")
    char_count: Mapped[int] = mapped_column(Integer, default=0)

    document: Mapped[Document] = relationship(back_populates="chunks")


class DocumentEntity(Base):
    """An equipment tag found in a document (``V-103``, ``P-12``, ``SOP-204``).

    Extracted for two reasons: exact-identifier search, which pure semantic
    similarity is bad at, and the P&ID equipment graph in section 7 of the spec.
    """

    __tablename__ = "document_entities"
    __table_args__ = (UniqueConstraint("document_id", "tag", "page"),)

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    tag: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(32), default="unknown")
    page: Mapped[int] = mapped_column(Integer, default=1)
    occurrences: Mapped[int] = mapped_column(Integer, default=1)

    document: Mapped[Document] = relationship(back_populates="entities")
