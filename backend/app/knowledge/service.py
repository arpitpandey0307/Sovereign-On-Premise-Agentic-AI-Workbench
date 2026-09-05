"""The knowledge layer's public face.

Part 04 calls ``search`` and gets citable ``Evidence`` back. It does not know
that there is a graph database, an embedding model, or a fallback path, and it
cannot ask for a chunk the caller is not cleared to read -- clearance is
resolved here from the caller's roles by asking Part 05, never passed in by
the caller.
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import func, select

from app.db.database import SessionLocal
from app.db.models import Document, DocumentChunk, DocumentEntity
from app.db.repositories.documents import DocumentRepository
from app.documents import ocr
from app.integrations import registry
from app.knowledge import retrieval
from app.knowledge.neo4j_client import neo4j_client
from app.schemas.shared import Evidence

logger = logging.getLogger("workbench.knowledge")


class KnowledgeService:
    """Retrieval, clearance-filtered, over whatever index is actually up."""

    # --- the port -----------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        roles: list[str],
        limit: int = 5,
        document_ids: list[UUID] | None = None,
    ) -> list[Evidence]:
        return self.search_with_diagnostics(
            query, roles=roles, limit=limit, document_ids=document_ids
        ).evidence

    def status(self) -> dict:
        graph = neo4j_client.status()
        ocr_ready, ocr_detail = ocr.availability()

        with SessionLocal() as db:
            documents = db.scalar(select(func.count()).select_from(Document)) or 0
            chunks = db.scalar(select(func.count()).select_from(DocumentChunk)) or 0
            embedded = (
                db.scalar(
                    select(func.count())
                    .select_from(DocumentChunk)
                    .where(DocumentChunk.embedding.is_not(None))
                )
                or 0
            )
            tags = db.scalar(select(func.count()).select_from(DocumentEntity)) or 0

        return {
            # The layer is usable whenever anything is indexed: the relational
            # fallback answers without Neo4j, just more slowly.
            "available": chunks > 0,
            "graph": graph,
            "ocr": {"available": ocr_ready, "detail": ocr_detail},
            "corpus": {
                "documents": int(documents),
                "chunks": int(chunks),
                "embedded_chunks": int(embedded),
                "entities": int(tags),
            },
            "retrieval_mode": (
                "hybrid (graph index)" if graph["reachable"] else "hybrid (local scan)"
            ),
        }

    # --- richer surface used by this part's own endpoints -------------------

    def search_with_diagnostics(
        self,
        query: str,
        *,
        roles: list[str],
        limit: int = 5,
        document_ids: list[UUID] | None = None,
    ) -> retrieval.SearchResult:
        """``search`` plus the reasoning, for the evidence panel."""
        classifications = self.readable_classifications(roles)
        with SessionLocal() as db:
            return retrieval.search(
                db,
                query,
                classifications=classifications,
                limit=max(1, min(limit, 25)),
                document_ids=document_ids,
            )

    def equipment_neighbours(
        self, tag: str, *, roles: list[str], depth: int = 1
    ) -> dict:
        """Answer "what is connected to this?" from the equipment graph.

        Neo4j does this as a traversal. Without it the relational store can
        still say which documents mention the tag and what else appears on the
        same page, which is the same evidence one hop out -- so the answer is
        labelled with how it was obtained rather than quietly changing shape.
        """
        classifications = self.readable_classifications(roles)
        if not classifications:
            return {"tag": tag.upper(), "source": "denied", "neighbours": []}

        graph = neo4j_client.equipment_neighbours(
            tag, depth=depth, classifications=classifications
        )
        if graph is not None:
            return {
                "tag": tag.upper(),
                "source": "graph_traversal",
                "neighbours": graph,
            }

        with SessionLocal() as db:
            repo = DocumentRepository(db)
            mentions = repo.documents_mentioning(tag, classifications=classifications)
            pages = {(document.id, entity.page) for document, entity in mentions}

            neighbours: dict[str, dict] = {}
            for document, _ in mentions:
                for entity in repo.entities(document.id):
                    if entity.tag == tag.upper():
                        continue
                    if (document.id, entity.page) not in pages:
                        continue
                    existing = neighbours.setdefault(
                        entity.tag,
                        {
                            "tag": entity.tag,
                            "type": entity.entity_type,
                            "hops": 1,
                            "documents": [],
                        },
                    )
                    existing["documents"].append(
                        {"id": str(document.id), "name": document.filename}
                    )

        return {
            "tag": tag.upper(),
            "source": "page_co_occurrence",
            "neighbours": sorted(neighbours.values(), key=lambda item: item["tag"]),
        }

    def readable_classifications(self, roles: list[str]) -> list[str]:
        """Ask Part 05 what these roles may read. Never decided here."""
        policy = registry.get_policy()
        resolve = getattr(policy, "readable_classifications", None)
        if resolve is None:
            # A policy engine that cannot answer must not be read as
            # permitting everything.
            logger.warning("policy engine exposes no clearance resolver; denying")
            return []
        return list(resolve(roles))


knowledge_service = KnowledgeService()
