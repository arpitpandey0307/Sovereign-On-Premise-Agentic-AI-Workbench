"""Reranking of fused candidates.

Three tiers, tried in order, each falling through to the next:

1. **Cross-encoder** — a real reranking model, scored through vLLM's rerank
   endpoint. The best answer, and the only one that reads query and passage
   together. Ollama has no rerank endpoint at all, so this tier is silent on
   the dev laptop and becomes live the day the lab box serves the model.
2. **Model scoring** — a reasoning model rates the shortlist for relevance in
   a *single* structured-output call. Deliberately one call for the whole
   shortlist, not one per passage: N calls would put a reranker's latency on
   the critical path of every search on a laptop already holding a model in
   VRAM.
3. **Lexical** — always available, costs nothing, and fixes the one failure
   this corpus reliably produces: `V-103` and `V-104` are near-identical to an
   embedding model, so fusion alone will happily rank the wrong vessel first.
   Exact-identifier agreement breaks that tie.

The lexical signal is blended into every tier rather than replaced by it. A
model that has not been told which identifier matters can still be talked out
of the right passage, and on this corpus the identifier is usually the query.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.config import settings
from app.documents.entities import TAG_PATTERN

logger = logging.getLogger("workbench.reranker")

# Weight of the lexical adjustment against the fused retrieval score. Kept
# modest: this refines an ordering, it does not replace it.
TAG_BONUS = 0.35
TERM_WEIGHT = 0.15

# Weight given to a model's opinion when one is available. Higher than the
# lexical terms because a cross-encoder genuinely reads the passage, but not
# so high that it can bury an exact identifier match.
MODEL_WEIGHT = 0.50

# How many candidates are worth paying a model for. Reranking the whole fused
# list would cost more than the retrieval it is correcting.
SHORTLIST = 8

# Passages are truncated before they reach a model: a reranker needs the gist,
# and a full chunk per candidate would blow a 4k-8k context window.
SNIPPET_CHARS = 400

_WORD = re.compile(r"[a-z0-9]{3,}")

# Words that appear in nearly every query and carry no retrieval signal.
_STOPWORDS = frozenset(
    {
        "the", "and", "for", "what", "which", "how", "does", "did", "was", "were",
        "are", "with", "that", "this", "from", "into", "about", "have", "has",
        "should", "would", "could", "when", "where", "who", "why", "any", "all",
    }
)

RERANK_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "relevance": {"type": "number"},
                },
                "required": ["id", "relevance"],
            },
        }
    },
    "required": ["scores"],
}

RERANK_SYSTEM = (
    "You rate how well each passage answers a question about industrial "
    "plant documentation. Score 0.0 (irrelevant) to 1.0 (directly answers "
    "it). A passage naming a different equipment tag than the question asks "
    "about is not relevant, however similar it reads. Return only JSON."
)


@dataclass
class Candidate:
    chunk_id: str
    text: str
    fused_score: float


def query_terms(query: str) -> set[str]:
    return {word for word in _WORD.findall(query.lower()) if word not in _STOPWORDS}


def query_tags(query: str) -> set[str]:
    return {match.group(0) for match in TAG_PATTERN.finditer(query.upper())}


def rerank(query: str, candidates: list[Candidate]) -> list[tuple[str, float]]:
    """Lexical rerank. Always available, no model, no database."""
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
        tag_hit = sum(1 for tag in tags if tag in upper) / len(tags) if tags else 0.0

        scored.append(
            (
                candidate.chunk_id,
                candidate.fused_score + TERM_WEIGHT * coverage + TAG_BONUS * tag_hit,
            )
        )

    return sorted(scored, key=lambda item: item[1], reverse=True)


def rerank_with_model(
    db: Session,
    query: str,
    candidates: list[Candidate],
    *,
    classification: str = "INTERNAL",
) -> tuple[list[tuple[str, float]], str, str]:
    """Rerank using a model where one is available.

    Returns ``(ordering, method, reason)``. ``method`` names what actually ran,
    so the evidence panel can say whether a model was involved rather than
    implying one was, and ``reason`` says why a better tier did not -- a
    fallback that answers without explaining itself is how a broken tier stays
    broken, which is exactly how the graph client hid a bug.
    """
    lexical = rerank(query, candidates)
    if not settings.enable_model_rerank:
        return lexical, "lexical", "model rerank is disabled by configuration"
    if len(candidates) < 2:
        return lexical, "lexical", ""

    shortlist = [
        candidate
        for candidate in candidates
        if candidate.chunk_id in {chunk_id for chunk_id, _ in lexical[:SHORTLIST]}
    ]

    scores, method, reason = _model_scores(db, query, shortlist, classification)
    if scores is None:
        return lexical, "lexical", reason

    lexical_by_id = dict(lexical)
    blended = {
        chunk_id: score + MODEL_WEIGHT * scores.get(chunk_id, 0.0)
        for chunk_id, score in lexical_by_id.items()
    }
    ordered = sorted(blended.items(), key=lambda item: item[1], reverse=True)
    return ordered, method, ""


def _model_scores(
    db: Session, query: str, shortlist: list[Candidate], classification: str
) -> tuple[dict[str, float] | None, str, str]:
    """Try the cross-encoder, then model scoring.

    Returns ``(scores, method, reason)``; ``scores`` is ``None`` when neither
    tier ran, and ``reason`` then explains what stopped them.
    """
    from app.models.service import model_service
    from app.routing.model_router import ModelRouter, TaskRequirements

    router = ModelRouter(db)
    decision = router.route(
        TaskRequirements(
            task_type="reranking",
            model_type="reranking",
            required_capabilities=["reranking"],
            classification=classification,
        )
    )

    if decision.succeeded and decision.selected is not None:
        record = decision.selected
        provider = model_service.provider(record.provider)
        rerank_call = getattr(provider, "rerank", None)
        if rerank_call is not None:
            from app.knowledge.embeddings import run_sync

            try:
                raw = run_sync(
                    rerank_call(
                        record.model_identifier,
                        query,
                        [item.text[:SNIPPET_CHARS] for item in shortlist],
                    )
                )
                return (
                    {
                        item.chunk_id: float(score)
                        for item, score in zip(shortlist, raw, strict=False)
                    },
                    "cross_encoder",
                    "",
                )
            except Exception as exc:
                logger.warning("cross-encoder rerank failed: %s", exc)

    return _score_through_reasoning(db, query, shortlist, classification)


def _score_through_reasoning(
    db: Session, query: str, shortlist: list[Candidate], classification: str
) -> tuple[dict[str, float] | None, str, str]:
    """One structured-output call scoring the whole shortlist."""
    from app.knowledge.embeddings import run_sync
    from app.models.service import model_service
    from app.routing.model_router import TaskRequirements

    passages = "\n\n".join(
        f"[{index}] {candidate.text[:SNIPPET_CHARS]}"
        for index, candidate in enumerate(shortlist)
    )
    prompt = (
        f"Question: {query}\n\nPassages:\n{passages}\n\n"
        f"Return a relevance score for each passage id 0-{len(shortlist) - 1}."
    )

    try:
        outcome = run_sync(
            model_service.generate(
                db,
                TaskRequirements(
                    task_type="reranking",
                    model_type="reasoning",
                    classification=classification,
                    needs_structured_output=True,
                    estimated_context_tokens=len(prompt) // 3,
                ),
                prompt=prompt,
                system=RERANK_SYSTEM,
                max_tokens=512,
                response_schema=RERANK_SCHEMA,
            )
        )
    except Exception as exc:
        logger.warning("model rerank failed: %s", exc)
        return None, "lexical", f"{type(exc).__name__}: {exc}"

    if not outcome.succeeded:
        # Usually the router declining: no reasoning model is pulled, or the
        # one that is will not fit in the VRAM left after a resident model.
        return None, "lexical", outcome.error or "no reasoning model was available"
    if not outcome.response.structured:
        return None, "lexical", "the model did not return scoreable JSON"

    scores: dict[str, float] = {}
    for entry in outcome.response.structured.get("scores", []):
        index = entry.get("id")
        if isinstance(index, int) and 0 <= index < len(shortlist):
            try:
                scores[shortlist[index].chunk_id] = max(
                    0.0, min(1.0, float(entry.get("relevance", 0.0)))
                )
            except (TypeError, ValueError):
                continue

    if not scores:
        return None, "lexical", "the model returned no usable scores"
    return scores, "model_scored", ""
