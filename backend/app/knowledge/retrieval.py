"""Hybrid retrieval: semantic search, exact-identifier search, and the merge.

Industrial documents defeat pure semantic search. "Which valves feed V-103"
embeds almost identically to a passage about V-104, and an engineer reading a
confident citation to the wrong vessel is worse served than one who got
nothing. So two independent searches run and their rankings are fused:

    vector search   -- what the passage means
    keyword search  -- which identifiers it literally contains

Fusion is Reciprocal Rank Fusion, which combines *rankings* rather than
scores. That matters because Neo4j's cosine similarity and its Lucene score
are on unrelated scales; averaging them would let whichever happened to
produce larger numbers dominate.

Both searches prefer Neo4j and fall back to the relational store when the
graph is unreachable, so retrieval degrades in quality rather than failing.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy.orm import Session

from app.db.models import Document, DocumentChunk
from app.db.repositories.documents import DocumentRepository
from app.knowledge import embeddings
from app.knowledge.neo4j_client import GraphHit, neo4j_client
from app.knowledge.reranker import (
    Candidate,
    query_tags,
    query_terms,
    rerank_with_model,
)
from app.routing.policies import CLASSIFICATION_ORDER
from app.schemas.shared import Evidence

logger = logging.getLogger("workbench.retrieval")

# RRF's smoothing constant. 60 is the value from the original paper and the
# usual default; it flattens the contribution of deep ranks so that being
# 40th in one list cannot outweigh being 2nd in the other.
RRF_K = 60

# How many candidates each arm contributes before fusion. Wider than the
# requested limit so the two lists actually have room to disagree.
ARM_CANDIDATES = 25

_WORD = re.compile(r"[a-z0-9]{3,}")


@dataclass
class SearchDiagnostics:
    """Why the results look the way they do. Shown in the evidence panel."""

    vector_backend: str = "none"
    keyword_backend: str = "none"
    # "cross_encoder" | "model_scored" | "lexical" -- which reranker actually
    # ran, so the evidence panel never implies a model was involved when the
    # lexical fallback did the work.
    rerank_method: str = "none"
    vector_hits: int = 0
    keyword_hits: int = 0
    considered: int = 0
    classifications_allowed: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "vector_backend": self.vector_backend,
            "keyword_backend": self.keyword_backend,
            "rerank_method": self.rerank_method,
            "vector_hits": self.vector_hits,
            "keyword_hits": self.keyword_hits,
            "chunks_considered": self.considered,
            "classifications_allowed": self.classifications_allowed,
            "notes": self.notes,
        }


@dataclass
class SearchResult:
    evidence: list[Evidence]
    diagnostics: SearchDiagnostics


def search(
    db: Session,
    query: str,
    *,
    classifications: list[str],
    limit: int = 5,
    document_ids: list[UUID] | None = None,
) -> SearchResult:
    """Run both arms, fuse, rerank, and return citable evidence.

    ``classifications`` is the set of levels the caller is cleared to read,
    decided by Part 05 and passed in. This function never widens it.
    """
    diagnostics = SearchDiagnostics(classifications_allowed=sorted(classifications))
    if not query.strip() or not classifications:
        return SearchResult(evidence=[], diagnostics=diagnostics)

    repo = DocumentRepository(db)
    chunks = repo.searchable_chunks(
        classifications=classifications, document_ids=document_ids
    )
    diagnostics.considered = len(chunks)
    if not chunks:
        diagnostics.notes.append("no readable chunks are indexed")
        return SearchResult(evidence=[], diagnostics=diagnostics)

    by_id = {str(chunk.id): chunk for chunk in chunks}

    vector_ranking = _vector_arm(db, query, classifications, by_id, diagnostics)
    keyword_ranking = _keyword_arm(query, classifications, by_id, diagnostics)

    fused = _reciprocal_rank_fusion([vector_ranking, keyword_ranking])
    if not fused:
        return SearchResult(evidence=[], diagnostics=diagnostics)

    ordered, method, rerank_reason = rerank_with_model(
        db,
        query,
        [
            Candidate(chunk_id=chunk_id, text=by_id[chunk_id].text, fused_score=score)
            for chunk_id, score in fused.items()
            if chunk_id in by_id
        ],
        classification=max(classifications, key=CLASSIFICATION_ORDER.index),
    )
    diagnostics.rerank_method = method
    if rerank_reason:
        diagnostics.notes.append(f"rerank fell back to lexical: {rerank_reason}")

    documents = {
        document.id: document
        for document in repo.get_many(
            list({by_id[chunk_id].document_id for chunk_id, _ in ordered[:limit]})
        )
    }

    evidence = [
        _to_evidence(by_id[chunk_id], documents.get(by_id[chunk_id].document_id), score)
        for chunk_id, score in ordered[:limit]
        if by_id[chunk_id].document_id in documents
    ]
    return SearchResult(evidence=evidence, diagnostics=diagnostics)


# --- the two arms ---------------------------------------------------------


def _vector_arm(
    db: Session,
    query: str,
    classifications: list[str],
    by_id: dict[str, DocumentChunk],
    diagnostics: SearchDiagnostics,
) -> list[str]:
    """Semantic candidates, from Neo4j's vector index or a local scan."""
    vector = embeddings.embed_query(db, query)
    if vector is None:
        diagnostics.vector_backend = "unavailable"
        diagnostics.notes.append(
            "semantic search skipped: no embedding model is available"
        )
        return []

    hits = neo4j_client.vector_search(
        vector, limit=ARM_CANDIDATES, classifications=classifications
    )
    if hits is not None:
        diagnostics.vector_backend = "neo4j"
        ranked = [hit.chunk_id for hit in hits if hit.chunk_id in by_id]
        diagnostics.vector_hits = len(ranked)
        return ranked

    # The graph did not answer. Cosine over the stored vectors is O(n) rather
    # than indexed, which is fine at MVP corpus size and honest about being
    # slower.
    diagnostics.vector_backend = "local_scan"
    diagnostics.notes.append(_fallback_note("semantic"))

    scored = [
        (str(chunk.id), embeddings.cosine(vector, chunk.embedding))
        for chunk in by_id.values()
        if chunk.embedding
    ]
    scored = [item for item in scored if item[1] > 0.0]
    scored.sort(key=lambda item: item[1], reverse=True)
    ranked = [chunk_id for chunk_id, _ in scored[:ARM_CANDIDATES]]
    diagnostics.vector_hits = len(ranked)
    return ranked


def _keyword_arm(
    query: str,
    classifications: list[str],
    by_id: dict[str, DocumentChunk],
    diagnostics: SearchDiagnostics,
) -> list[str]:
    """Exact-identifier and term candidates."""
    hits = neo4j_client.fulltext_search(
        _lucene_query(query), limit=ARM_CANDIDATES, classifications=classifications
    )
    if hits is not None:
        diagnostics.keyword_backend = "neo4j"
        ranked = [hit.chunk_id for hit in hits if hit.chunk_id in by_id]
        diagnostics.keyword_hits = len(ranked)
        return ranked

    diagnostics.keyword_backend = "local_scan"
    diagnostics.notes.append(_fallback_note("keyword"))

    terms = query_terms(query)
    tags = query_tags(query)
    if not terms and not tags:
        return []

    scored: list[tuple[str, float]] = []
    for chunk_id, chunk in by_id.items():
        haystack = chunk.text.lower()
        upper = chunk.text.upper()
        # An exact tag match is weighted far above a term match: it is the
        # difference between the right vessel and a plausible one.
        score = sum(3.0 for tag in tags if tag in upper)
        score += sum(1.0 for term in terms if term in haystack)
        if score > 0:
            scored.append((chunk_id, score))

    scored.sort(key=lambda item: item[1], reverse=True)
    ranked = [chunk_id for chunk_id, _ in scored[:ARM_CANDIDATES]]
    diagnostics.keyword_hits = len(ranked)
    return ranked


def _fallback_note(arm: str) -> str:
    """Say why an arm fell back, distinguishing absence from failure.

    A graph that is down is an environment the operator can fix. A graph that
    is up while its query fails is a bug, and reporting the two identically is
    how a broken query stays broken -- the fallback answers, so nothing looks
    wrong.
    """
    status = neo4j_client.status()
    if not status["reachable"]:
        return f"{arm} search: graph index unreachable; used the local scan"
    return (
        f"{arm} search: the graph is reachable but its query failed "
        f"({status['detail']}); used the local scan"
    )


# --- fusion ---------------------------------------------------------------


def _reciprocal_rank_fusion(rankings: list[list[str]]) -> dict[str, float]:
    """Fuse ranked id lists. A chunk found by both arms outranks either."""
    fused: dict[str, float] = {}
    for ranking in rankings:
        for position, chunk_id in enumerate(ranking, start=1):
            fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.0 / (RRF_K + position)
    return dict(sorted(fused.items(), key=lambda item: item[1], reverse=True))


def _lucene_query(query: str) -> str:
    """Turn a natural question into a Lucene expression Neo4j will accept.

    Identifiers are quoted so the hyphen is not read as a NOT operator, which
    would silently exclude every chunk containing the tag being searched for.
    """
    tags = query_tags(query)
    terms = query_terms(query)
    parts = [f'"{tag}"^3' for tag in sorted(tags)]
    parts.extend(sorted(terms - {tag.lower() for tag in tags}))
    return " OR ".join(parts) if parts else query.strip()


# --- evidence -------------------------------------------------------------


def _to_evidence(
    chunk: DocumentChunk, document: Document | None, score: float
) -> Evidence:
    return Evidence(
        document_id=chunk.document_id,
        document_name=document.filename if document else "unknown document",
        page=chunk.page,
        section=chunk.section,
        text=chunk.text,
        score=round(score, 4),
    )


def graph_hits_to_ids(hits: list[GraphHit]) -> list[str]:
    return [hit.chunk_id for hit in hits]
