"""Embedding generation, obtained through Part 02.

This module never names a model and never talks to a runtime. It states what
it needs -- an embedding-capable model, cleared for this document's
classification -- and Part 02's router answers. That indirection is what makes
the classification rule real: embedding a HIGHLY_CONFIDENTIAL document through
a model Part 05 has not approved is refused here, not caught later.

Embedding is also allowed to fail. A local runtime that is down must not cost
the operator their document: ingestion continues without vectors and retrieval
falls back to keyword search, which is degraded but honest.
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.service import model_service
from app.routing.model_router import ModelRouter, TaskRequirements

logger = logging.getLogger("workbench.embeddings")

# Ollama holds the whole batch in memory while it runs. Small batches keep the
# footprint predictable next to a resident reasoning model on an 8 GB card.
BATCH_SIZE = 16


@dataclass
class EmbeddingResult:
    model_id: str = ""
    vectors: list[list[float]] = field(default_factory=list)
    error: str = ""

    @property
    def succeeded(self) -> bool:
        return bool(self.vectors) and not self.error

    @property
    def dimensions(self) -> int:
        return len(self.vectors[0]) if self.vectors else 0


def embed(
    db: Session, texts: list[str], *, classification: str = "INTERNAL"
) -> EmbeddingResult:
    """Embed a list of texts, or explain why it could not be done."""
    if not texts:
        return EmbeddingResult()

    decision = ModelRouter(db).route(
        TaskRequirements(
            task_type="embedding",
            model_type="embedding",
            required_capabilities=["embedding"],
            classification=classification,
            estimated_context_tokens=512,
        )
    )
    if not decision.succeeded or decision.selected is None:
        return EmbeddingResult(error=decision.failure_reason)

    record = decision.selected
    provider = model_service.provider(record.provider)
    if provider is None:
        return EmbeddingResult(error=f"no adapter for provider {record.provider}")

    embed_call = getattr(provider, "embed", None)
    if embed_call is None:
        # vLLM's adapter has no embedding endpoint yet. Say so plainly rather
        # than silently indexing nothing.
        return EmbeddingResult(
            error=f"{record.provider} adapter does not implement embeddings"
        )

    vectors: list[list[float]] = []
    try:
        for start in range(0, len(texts), BATCH_SIZE):
            batch = texts[start : start + BATCH_SIZE]
            vectors.extend(
                _run(embed_call(record.model_identifier, batch))
            )
    except Exception as exc:
        logger.warning("embedding failed on %s: %s", record.id, exc)
        return EmbeddingResult(model_id=record.id, error=str(exc))

    if len(vectors) != len(texts):
        return EmbeddingResult(
            model_id=record.id,
            error=f"runtime returned {len(vectors)} vectors for {len(texts)} inputs",
        )
    return EmbeddingResult(model_id=record.id, vectors=vectors)


def embed_query(
    db: Session, query: str, *, classification: str = "INTERNAL"
) -> list[float] | None:
    """Embed a single search query. Returns ``None`` when unavailable."""
    result = embed(db, [query], classification=classification)
    return result.vectors[0] if result.succeeded else None


def _run(coro):
    """Run one coroutine from synchronous code.

    Ingestion runs in FastAPI's background threadpool, where there is no
    running loop, so ``asyncio.run`` is correct. Retrieval can also be called
    from inside a request's loop, and running a second loop on that thread
    would raise, so that case is handed to a worker thread.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def cosine(left: list[float], right: list[float]) -> float:
    """Cosine similarity, used by the fallback search when Neo4j is absent."""
    if not left or not right or len(left) != len(right):
        return 0.0

    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = sum(a * a for a in left) ** 0.5
    right_norm = sum(b * b for b in right) ** 0.5
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)
