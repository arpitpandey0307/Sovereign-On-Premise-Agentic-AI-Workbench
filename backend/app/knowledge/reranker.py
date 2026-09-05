"""Reranking of fused candidates.

Section 5 of the spec marks a cross-encoder reranker as optional for the MVP,
and it is deliberately not used here: a reranking model is a second model
resident in VRAM next to the reasoner on an 8 GB card, and it buys precision
the demo does not yet need.

What is here instead is a lexical rerank that costs nothing and fixes the one
failure this corpus reliably produces: a chunk that mentions ``V-103`` and a
chunk that mentions ``V-104`` are near-identical to an embedding model, so
fusion alone will happily rank the wrong vessel first. Exact-identifier
agreement breaks that tie, which is exactly what an engineer asking about a
specific valve expects.

The interface is a pure function so a cross-encoder can replace the body in
Phase 2 without any caller changing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.documents.entities import TAG_PATTERN

# Weight of the lexical adjustment against the fused retrieval score. Kept
# modest: this refines an ordering, it does not replace it.
TAG_BONUS = 0.35
TERM_WEIGHT = 0.15

_WORD = re.compile(r"[a-z0-9]{3,}")

# Words that appear in nearly every query and carry no retrieval signal.
_STOPWORDS = frozenset(
    {
        "the", "and", "for", "what", "which", "how", "does", "did", "was", "were",
        "are", "with", "that", "this", "from", "into", "about", "have", "has",
        "should", "would", "could", "when", "where", "who", "why", "any", "all",
    }
)


@dataclass
class Candidate:
    chunk_id: str
    text: str
    fused_score: float


def query_terms(query: str) -> set[str]:
    return {
        word for word in _WORD.findall(query.lower()) if word not in _STOPWORDS
    }


def query_tags(query: str) -> set[str]:
    return {match.group(0) for match in TAG_PATTERN.finditer(query.upper())}


def rerank(query: str, candidates: list[Candidate]) -> list[tuple[str, float]]:
    """Return ``(chunk_id, score)`` ordered best first."""
    terms = query_terms(query)
    tags = query_tags(query)

    scored: list[tuple[str, float]] = []
    for candidate in candidates:
        haystack = candidate.text.lower()
        upper = candidate.text.upper()

        coverage = (
            sum(1 for term in terms if term in haystack) / len(terms) if terms else 0.0
        )
        # An identifier the caller named explicitly is a hard signal; one they
        # did not is irrelevant, so absence is neutral rather than penalised.
        tag_hit = (
            sum(1 for tag in tags if tag in upper) / len(tags) if tags else 0.0
        )

        score = (
            candidate.fused_score
            + TERM_WEIGHT * coverage
            + TAG_BONUS * tag_hit
        )
        scored.append((candidate.chunk_id, score))

    return sorted(scored, key=lambda item: item[1], reverse=True)
