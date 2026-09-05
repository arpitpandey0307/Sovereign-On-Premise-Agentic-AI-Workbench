"""The vision pass over pages that cannot be understood from text alone.

A P&ID is the case that motivates this. OCR of an engineering drawing returns
a bag of tags with no structure: it will happily give you `V-103`, `P-12` and
`FIC-101` while losing the one thing the drawing exists to convey, which is
what connects to what. The spec is explicit that such pages get a vision-model
pass rather than being trusted to OCR alone.

What comes back is stored separately from the page text and never merged into
it. A model's description of a drawing is not a quotation from the drawing,
and a citation has to be able to tell a reader which it is looking at.

The pass is capped per document and skips cleanly when no vision model is
loaded: on an 8 GB card a VLM sits next to the reasoner, and a 200-page scan
that ran a model on every page would stall ingestion for minutes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.config import settings
from app.knowledge.embeddings import run_sync
from app.models.service import model_service
from app.routing.model_router import TaskRequirements

logger = logging.getLogger("workbench.vision")

# Short on purpose. This is a description that will be chunked and embedded
# alongside the page, not a report -- a long generation would dominate the
# retrieval index for that document and slow ingestion for no gain.
MAX_TOKENS = 400

VISION_SYSTEM = (
    "You are reading a page from confidential industrial plant documentation "
    "-- an engineering drawing, a scanned form, or a table. Describe only what "
    "is actually visible. List every equipment tag you can read (such as "
    "P-103, V-12, PSV-2201) exactly as printed. If it is a P&ID or a flow "
    "diagram, say which items are connected to which, and by what. If it is a "
    "table, give its columns and what it records. Never guess a tag you cannot "
    "read, and never infer a connection the drawing does not show. If the page "
    "is unreadable, say so plainly."
)

VISION_PROMPT = (
    "Describe this page. Begin with one line saying what kind of page it is, "
    "then the equipment tags visible, then the relationships or structure."
)


@dataclass
class VisionResult:
    text: str = ""
    model_id: str = ""
    # "described" | "unavailable" | "failed" | "not_required"
    status: str = "not_required"
    detail: str = ""

    @property
    def succeeded(self) -> bool:
        return self.status == "described" and bool(self.text.strip())


def describe(
    db: Session, image: bytes, *, classification: str = "INTERNAL"
) -> VisionResult:
    """Ask Part 02 for a vision model and have it read one page.

    The classification is passed through so Part 05 can refuse a model that is
    not cleared for the document. This module never picks a model and never
    talks to a runtime directly.
    """
    if not image:
        return VisionResult(status="failed", detail="no rendered page to look at")

    try:
        outcome = run_sync(
            model_service.generate(
                db,
                TaskRequirements(
                    task_type="vision",
                    model_type="vision",
                    required_capabilities=["vision"],
                    classification=classification,
                    needs_vision=True,
                    estimated_context_tokens=1024,
                ),
                prompt=VISION_PROMPT,
                system=VISION_SYSTEM,
                images=[image],
                max_tokens=MAX_TOKENS,
            )
        )
    except Exception as exc:
        logger.warning("vision pass raised: %s", exc)
        return VisionResult(status="failed", detail=f"{type(exc).__name__}: {exc}")

    if not outcome.succeeded or outcome.response is None:
        # No vision model pulled, or every candidate failed. The page keeps
        # its OCR text and the document still ingests.
        return VisionResult(
            status="unavailable",
            detail=outcome.error or "no vision model was available",
        )

    return VisionResult(
        text=outcome.response.text.strip(),
        model_id=outcome.model_used or "",
        status="described",
        detail=f"{outcome.response.latency_ms} ms",
    )


def selected_pages(pages: list, limit: int | None = None) -> list:
    """Choose which flagged pages are worth a model call.

    Pages carrying more graphics and less text are described first: a drawing
    gains far more from being looked at than a mostly-textual page with a logo
    on it does. Ties keep document order so the choice is reproducible.
    """
    budget = settings.vision_pass_max_pages if limit is None else limit
    if budget <= 0:
        return []

    candidates = [page for page in pages if page.needs_vision and page.image]
    ranked = sorted(candidates, key=lambda page: (len(page.text or ""), page.page_number))
    chosen = ranked[:budget]
    return sorted(chosen, key=lambda page: page.page_number)
