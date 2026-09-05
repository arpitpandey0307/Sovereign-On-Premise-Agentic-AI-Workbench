"""Data access for ingested documents, their pages, chunks and entities."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.db.models import Document, DocumentChunk, DocumentEntity, DocumentPage


class DocumentRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    # --- documents --------------------------------------------------------

    def get(self, document_id: UUID) -> Document | None:
        return self.db.get(Document, document_id)

    def get_by_file(self, file_id: UUID) -> Document | None:
        return self.db.scalar(select(Document).where(Document.file_id == file_id))

    def get_many(self, document_ids: list[UUID]) -> list[Document]:
        if not document_ids:
            return []
        return list(
            self.db.scalars(select(Document).where(Document.id.in_(document_ids)))
        )

    def list_for_owner(
        self, owner_id: UUID, *, limit: int = 50, offset: int = 0
    ) -> tuple[list[Document], int]:
        base = select(Document).where(Document.owner_id == owner_id)
        total = self.db.scalar(select(func.count()).select_from(base.subquery()))
        stmt = base.order_by(Document.created_at.desc()).limit(limit).offset(offset)
        return list(self.db.scalars(stmt)), int(total or 0)

    def upsert(
        self,
        *,
        file_id: UUID,
        owner_id: UUID,
        filename: str,
        mime_type: str,
        size_bytes: int,
        checksum: str,
        storage_path: str,
        kind: str,
    ) -> Document:
        """Create the document, or reset an existing one for re-ingestion.

        Re-ingesting bumps the version and clears the derived rows. Keeping
        the same document id means citations already handed out keep resolving
        to the same document rather than dangling.
        """
        existing = self.get_by_file(file_id)
        if existing is not None:
            self.clear_derived(existing.id)
            existing.version += 1
            existing.filename = filename
            existing.mime_type = mime_type
            existing.size_bytes = size_bytes
            existing.checksum = checksum
            existing.storage_path = storage_path
            existing.kind = kind
            existing.status = "active"
            existing.ingest_error = ""
            existing.indexed_in_graph = False
            self.db.commit()
            self.db.refresh(existing)
            return existing

        document = Document(
            file_id=file_id,
            owner_id=owner_id,
            filename=filename,
            mime_type=mime_type,
            size_bytes=size_bytes,
            checksum=checksum,
            storage_path=storage_path,
            kind=kind,
        )
        self.db.add(document)
        self.db.commit()
        self.db.refresh(document)
        return document

    def clear_derived(self, document_id: UUID) -> None:
        """Drop pages, chunks and entities without touching the document row."""
        for model in (DocumentPage, DocumentChunk, DocumentEntity):
            self.db.execute(delete(model).where(model.document_id == document_id))
        self.db.commit()

    def set_classification(
        self, document: Document, classification: str, reason: str
    ) -> None:
        document.classification = classification
        document.classification_reason = reason
        # Chunks carry the level too, so a retrieval filter never has to join
        # before it can discard something the caller may not see.
        self.db.execute(
            update(DocumentChunk)
            .where(DocumentChunk.document_id == document.id)
            .values(classification=classification)
        )
        self.db.commit()

    def finish(
        self,
        document: Document,
        *,
        page_count: int,
        chunk_count: int,
        indexed_in_graph: bool,
        error: str = "",
    ) -> None:
        document.page_count = page_count
        document.chunk_count = chunk_count
        document.indexed_in_graph = indexed_in_graph
        document.ingest_error = error
        self.db.commit()

    # --- pages ------------------------------------------------------------

    def add_pages(self, pages: list[DocumentPage]) -> None:
        self.db.add_all(pages)
        self.db.commit()

    def pages(self, document_id: UUID) -> list[DocumentPage]:
        stmt = (
            select(DocumentPage)
            .where(DocumentPage.document_id == document_id)
            .order_by(DocumentPage.page_number)
        )
        return list(self.db.scalars(stmt))

    def page(self, document_id: UUID, page_number: int) -> DocumentPage | None:
        return self.db.scalar(
            select(DocumentPage).where(
                DocumentPage.document_id == document_id,
                DocumentPage.page_number == page_number,
            )
        )

    # --- chunks -----------------------------------------------------------

    def add_chunks(self, chunks: list[DocumentChunk]) -> None:
        self.db.add_all(chunks)
        self.db.commit()

    def chunks(self, document_id: UUID) -> list[DocumentChunk]:
        stmt = (
            select(DocumentChunk)
            .where(DocumentChunk.document_id == document_id)
            .order_by(DocumentChunk.ordinal)
        )
        return list(self.db.scalars(stmt))

    def searchable_chunks(
        self,
        *,
        classifications: list[str],
        document_ids: list[UUID] | None = None,
    ) -> list[DocumentChunk]:
        """Chunks of active documents at a classification the caller may read.

        The filter is applied in SQL rather than after the fact, so a chunk
        above the caller's clearance is never loaded into the process that
        answers them.
        """
        if not classifications:
            return []
        stmt = (
            select(DocumentChunk)
            .join(Document, Document.id == DocumentChunk.document_id)
            .where(
                Document.status == "active",
                DocumentChunk.classification.in_(classifications),
            )
        )
        if document_ids:
            stmt = stmt.where(DocumentChunk.document_id.in_(document_ids))
        return list(self.db.scalars(stmt))

    # --- entities ---------------------------------------------------------

    def add_entities(self, entities: list[DocumentEntity]) -> None:
        self.db.add_all(entities)
        self.db.commit()

    def entities(self, document_id: UUID) -> list[DocumentEntity]:
        stmt = (
            select(DocumentEntity)
            .where(DocumentEntity.document_id == document_id)
            .order_by(DocumentEntity.tag)
        )
        return list(self.db.scalars(stmt))

    def documents_mentioning(
        self, tag: str, *, classifications: list[str]
    ) -> list[tuple[Document, DocumentEntity]]:
        if not classifications:
            return []
        stmt = (
            select(Document, DocumentEntity)
            .join(DocumentEntity, DocumentEntity.document_id == Document.id)
            .where(
                DocumentEntity.tag == tag.upper(),
                Document.status == "active",
                Document.classification.in_(classifications),
            )
            .order_by(DocumentEntity.page)
        )
        return [(row[0], row[1]) for row in self.db.execute(stmt)]
