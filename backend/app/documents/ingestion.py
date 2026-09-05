"""The ingestion pipeline.

    uploaded file
      -> detect type
      -> extract native text, or render and OCR
      -> flag drawings and photos for a vision pass
      -> chunk, page-aware
      -> classify (Part 05 decides the level, this module supplies the text)
      -> embed (Part 02 picks and runs the model)
      -> write chunks and the equipment graph to Neo4j
      -> record the document in the relational store

Each stage is allowed to degrade. OCR without Tesseract, embedding without a
model runtime, and indexing without Neo4j all leave the document ingested and
readable with a recorded reason, because on an air-gapped machine a failed
upload is a dead end for the operator rather than a ticket for someone else.

The pipeline runs in FastAPI's background threadpool, off the upload response:
OCR of a scanned P&ID takes seconds, and the upload must not wait for it.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.dependencies import record_audit
from app.core.storage import storage
from app.db.models import DocumentChunk, DocumentEntity, DocumentPage
from app.db.repositories.documents import DocumentRepository
from app.db.repositories.files import FileRepository
from app.documents import entities as entity_extraction
from app.documents import ocr, parser
from app.documents.chunker import chunk_pages
from app.knowledge import embeddings
from app.knowledge.neo4j_client import neo4j_client

logger = logging.getLogger("workbench.ingestion")


@dataclass
class IngestionReport:
    """What actually happened, in a form the API and the audit log can show."""

    document_id: UUID | None = None
    kind: str = "unknown"
    pages: int = 0
    ocr_pages: int = 0
    vision_pages: int = 0
    chunks: int = 0
    embedded: int = 0
    entities: int = 0
    classification: str = "INTERNAL"
    indexed_in_graph: bool = False
    degraded: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "document_id": str(self.document_id) if self.document_id else None,
            "kind": self.kind,
            "pages": self.pages,
            "ocr_pages": self.ocr_pages,
            "vision_pages": self.vision_pages,
            "chunks": self.chunks,
            "embedded_chunks": self.embedded,
            "entities": self.entities,
            "classification": self.classification,
            "indexed_in_graph": self.indexed_in_graph,
            "degraded": self.degraded,
        }


def ingest_file(db: Session, file_id: UUID) -> IngestionReport:
    """Run the whole pipeline for one uploaded file."""
    report = IngestionReport()

    record = FileRepository(db).get(file_id)
    if record is None:
        raise ValueError("File not found.")

    path = storage.resolve(record.storage_path)
    if not Path(path).exists():
        raise FileNotFoundError("The stored file is missing.")

    extraction = parser.extract(path, record.mime_type, record.filename)
    report.kind = extraction.kind
    if not extraction.pages:
        raise ValueError(f"Nothing extractable: {extraction.detail}")

    repo = DocumentRepository(db)
    document = repo.upsert(
        file_id=record.id,
        owner_id=record.owner_id,
        filename=record.filename,
        mime_type=record.mime_type,
        size_bytes=record.size_bytes,
        checksum=record.sha256,
        storage_path=record.storage_path,
        kind=extraction.kind,
    )
    report.document_id = document.id

    pages = _resolve_pages(extraction.pages, owner_id=record.owner_id, report=report)
    repo.add_pages(
        [
            DocumentPage(
                document_id=document.id,
                page_number=page.page_number,
                text=page.text,
                image_path=image_path,
                ocr_status=page.ocr_status,
                ocr_confidence=confidence,
                needs_vision=page.needs_vision,
            )
            for page, image_path, confidence in pages
        ]
    )
    report.pages = len(pages)

    page_texts = [(page.page_number, page.text) for page, _, _ in pages]
    chunks = chunk_pages(page_texts)
    report.chunks = len(chunks)

    classification, reason = _classify(document.filename, page_texts)
    report.classification = classification

    vectors = _embed(db, [chunk.text for chunk in chunks], classification, report)

    rows = [
        DocumentChunk(
            document_id=document.id,
            ordinal=chunk.ordinal,
            page=chunk.page,
            section=chunk.section,
            text=chunk.text,
            classification=classification,
            embedding=vectors.vectors[index] if vectors.succeeded else None,
            embedding_model=vectors.model_id,
            char_count=len(chunk.text),
        )
        for index, chunk in enumerate(chunks)
    ]
    repo.add_chunks(rows)
    repo.set_classification(document, classification, reason)

    tags = entity_extraction.extract_tags(page_texts)
    if tags:
        repo.add_entities(
            [
                DocumentEntity(
                    document_id=document.id,
                    tag=tag.tag,
                    entity_type=tag.entity_type,
                    page=tag.page,
                    occurrences=count,
                )
                for tag, count in tags
            ]
        )
    report.entities = len(tags)

    report.indexed_in_graph = _index(document, rows, vectors, tags, classification)
    if not report.indexed_in_graph:
        report.degraded.append(
            "graph index unavailable; search will use the slower local path"
        )

    repo.finish(
        document,
        page_count=report.pages,
        chunk_count=report.chunks,
        indexed_in_graph=report.indexed_in_graph,
        error="; ".join(report.degraded),
    )

    record_audit(
        event_type="DOCUMENT_INGESTED",
        action="document:ingest",
        component="documents",
        user_id=record.owner_id,
        metadata={"file_id": str(file_id), **report.as_dict()},
    )
    logger.info(
        "ingested %s: %d page(s), %d chunk(s), %s",
        record.filename,
        report.pages,
        report.chunks,
        classification,
    )
    return report


# --- stages ---------------------------------------------------------------


def _resolve_pages(
    extracted: list[parser.ExtractedPage], *, owner_id: UUID, report: IngestionReport
) -> list[tuple[parser.ExtractedPage, str, float]]:
    """Run OCR where needed and persist the rasters a vision pass will want."""
    resolved: list[tuple[parser.ExtractedPage, str, float]] = []
    ocr_unavailable_noted = False

    for page in extracted:
        confidence = 0.0

        if page.ocr_status == "pending_ocr" and page.image:
            result = ocr.recognise(page.image)
            page.text = result.text or page.text
            page.ocr_status = result.status
            confidence = result.confidence
            if result.status == "ocr":
                report.ocr_pages += 1
            elif result.status == "unavailable" and not ocr_unavailable_noted:
                report.degraded.append(f"OCR skipped: {result.detail}")
                ocr_unavailable_noted = True
        elif page.ocr_status == "pending_ocr":
            page.ocr_status = "failed"

        image_path = ""
        if page.needs_vision and page.image:
            # The raster is kept only for pages a vision model still has to
            # look at. Storing every page would multiply the corpus on disk
            # for no retrieval benefit.
            image_path, _, _ = storage.save(
                io.BytesIO(page.image),
                owner_id=owner_id,
                filename=f"page-{page.page_number}.png",
            )
            report.vision_pages += 1

        # The pixels are not carried past this point; only the path is.
        page.image = None
        resolved.append((page, image_path, confidence))

    return resolved


def _classify(filename: str, pages: list[tuple[int, str]]) -> tuple[str, str]:
    """Ask Part 05 what sensitivity level this document carries.

    Only a sample of the text is sent: classification rules key off markings
    and vocabulary, which appear early, and handing the engine a whole
    inspection report would cost more than it can use.
    """
    from app.integrations import registry

    sample = "\n".join(text for _, text in pages[:3])[:8000]
    policy = registry.get_policy()

    classify = getattr(policy, "classify_document", None)
    if classify is None:
        return "INTERNAL", "policy engine exposes no classifier; defaulted"
    return classify(filename=filename, text=sample)


def _embed(
    db: Session, texts: list[str], classification: str, report: IngestionReport
) -> embeddings.EmbeddingResult:
    if not texts:
        return embeddings.EmbeddingResult()

    result = embeddings.embed(db, texts, classification=classification)
    if result.succeeded:
        report.embedded = len(result.vectors)
    else:
        report.degraded.append(f"embeddings unavailable: {result.error}")
    return result


def _index(
    document,
    rows: list[DocumentChunk],
    vectors: embeddings.EmbeddingResult,
    tags,
    classification: str,
) -> bool:
    """Mirror the persisted chunks and the equipment graph into Neo4j.

    The graph node id is the relational chunk id, so a hit from the vector
    index resolves straight back to the row that owns the text -- there is no
    second identity to keep in step.
    """
    if not vectors.succeeded:
        # Writing chunks with no embedding would create an index that silently
        # returns nothing. The relational fallback covers this case properly.
        return False

    payload = [
        {
            "id": str(row.id),
            "text": row.text,
            "page": row.page,
            "section": row.section,
            "embedding": row.embedding,
            "classification": classification,
        }
        for row in rows
        if row.embedding
    ]
    if not payload:
        return False

    written = neo4j_client.upsert_document(
        document_id=document.id,
        name=document.filename,
        classification=classification,
        version=document.version,
        chunks=payload,
        dimensions=vectors.dimensions,
    )
    if not written:
        return False

    neo4j_client.upsert_equipment(
        document_id=document.id,
        tags=[
            {
                "tag": tag.tag,
                "entity_type": tag.entity_type,
                "page": tag.page,
                "occurrences": count,
            }
            for tag, count in tags
        ],
        connections=[
            {"source": source, "target": target, "weight": weight}
            for source, target, weight in entity_extraction.co_occurring(tags)
        ],
    )
    return True
