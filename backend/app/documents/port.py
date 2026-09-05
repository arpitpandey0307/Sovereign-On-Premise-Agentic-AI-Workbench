"""Part 03's implementations of the ports Part 01 declared.

Registering these at startup replaces the no-op documents placeholder and the
empty knowledge placeholder, so an upload actually gets ingested and a search
actually returns evidence -- with no change anywhere else in the codebase.
"""

from __future__ import annotations

import logging
from uuid import UUID

from app.db.database import SessionLocal
from app.documents.ingestion import ingest_file

logger = logging.getLogger("workbench.documents")


class DocumentPipeline:
    """The ``DocumentsPort`` Part 01 calls after a successful upload."""

    def ingest(self, file_id: UUID) -> None:
        # Its own session: this runs in the background threadpool, after the
        # request that triggered it has already closed its session.
        with SessionLocal() as db:
            report = ingest_file(db, file_id)
        if report.degraded:
            logger.warning(
                "document %s ingested with degradation: %s",
                report.document_id,
                "; ".join(report.degraded),
            )


def install() -> None:
    """Swap the placeholders for the real document and knowledge layers."""
    from app.integrations import registry
    from app.knowledge.service import knowledge_service

    registry.register_documents(DocumentPipeline())
    registry.register_knowledge(knowledge_service)
