"""Working out what a request needs, and what the agent should say about it.

Two jobs, kept apart on purpose.

``analyse`` is **deterministic**. It reads the request text and the task's
inputs and decides which capabilities are needed. No model is consulted,
because this decision governs which models are then allowed to run, and asking
a model what it is permitted to do is circular.

``draft_approval_note`` is the one genuinely generative step: a reasoning
model is given the retrieved evidence and asked for structured JSON matching
``ApprovalNoteContent``. It is asked for JSON rather than prose because the
generator downstream consumes fields, and because a schema is checkable in a
way a paragraph is not.
"""

from __future__ import annotations

import logging
import re

from sqlalchemy.orm import Session

from app.artifacts.content import APPROVAL_NOTE_SCHEMA, ApprovalNoteContent
from app.knowledge.embeddings import run_sync
from app.models.service import model_service
from app.routing.model_router import TaskRequirements

logger = logging.getLogger("workbench.planner")

# Signals that a request wants a deliverable rather than an answer. Matched on
# the request text, which is the only thing the user actually asked for.
_ARTIFACT_WORDS = re.compile(
    r"\b(approval note|note|report|memo|document|docx|word|"
    r"summar[iy]|write up|write-up|draft)\b",
    re.I,
)
_SPREADSHEET_WORDS = re.compile(r"\b(spreadsheet|xlsx|excel|workbook|table of)\b", re.I)
_DECK_WORDS = re.compile(r"\b(deck|slides|presentation|pptx|powerpoint)\b", re.I)
_CALCULATION_WORDS = re.compile(
    r"\b(calculat|comput|percentage|total|sum|average|tolerance|deviation|"
    r"how much|how many)\w*", re.I
)

DRAFT_SYSTEM = (
    "You are reviewing industrial plant documentation for a refinery. You are "
    "given a request and passages retrieved from the document corpus. Produce "
    "an approval note as JSON.\n\n"
    "Rules you must follow:\n"
    "- Every finding must cite the document name and page it came from, taken "
    "from the passages you were given. Do not cite a document or page that is "
    "not in those passages.\n"
    "- If the passages do not support a claim, do not make it. It is correct "
    "to report that the evidence is insufficient.\n"
    "- Do not perform arithmetic in your answer. Any figure you state must "
    "appear in a passage.\n"
    "- Severity is one of: informational, minor, major, critical."
)


def analyse(request: str, *, has_inputs: bool) -> tuple[list[str], str]:
    """Return ``(requirements, artifact_type)`` for a request.

    ``artifact_type`` is empty when the request wants an answer rather than a
    file. Guessing wrong towards "produce a document" would be the worse
    error: it turns a question into a download.
    """
    requirements: list[str] = ["reasoning"]

    if has_inputs:
        requirements.append("document_understanding")
    # Retrieval is always worth doing: even a question with no attachments is
    # better answered against the corpus than from a model's memory.
    requirements.append("retrieval")

    if _CALCULATION_WORDS.search(request):
        requirements.append("calculation")

    artifact_type = ""
    if _DECK_WORDS.search(request):
        artifact_type = "pptx"
    elif _SPREADSHEET_WORDS.search(request):
        artifact_type = "xlsx"
    elif _ARTIFACT_WORDS.search(request):
        artifact_type = "docx"

    if artifact_type:
        requirements.append("artifact_generation")

    return requirements, artifact_type


def plan_steps(requirements: list[str], artifact_type: str) -> list[dict]:
    """The steps the graph will take, as a list the UI can render up front."""
    steps = [{"step": "analyse_inputs", "why": "read the attached documents"}]
    if "retrieval" in requirements:
        steps.append(
            {"step": "retrieve", "why": "find supporting passages in the corpus"}
        )
    steps.append({"step": "reason", "why": "compare the findings against the sources"})
    if "calculation" in requirements:
        steps.append(
            {"step": "calculate", "why": "compute figures exactly, in the sandbox"}
        )
    if artifact_type:
        steps.append(
            {"step": "generate_artifact", "why": f"build the {artifact_type} deliverable"}
        )
        steps.append(
            {"step": "validate_artifact", "why": "check it against the evidence"}
        )
    return steps


def draft_approval_note(
    db: Session,
    *,
    request: str,
    evidence: list[dict],
    document_text: str,
    classification: str,
) -> tuple[ApprovalNoteContent | None, str, str]:
    """Ask a reasoning model for the note. Returns ``(content, model, error)``."""
    prompt = _build_prompt(request, evidence, document_text)

    outcome = run_sync(
        model_service.generate(
            db,
            TaskRequirements(
                task_type="approval_note",
                model_type="reasoning",
                classification=classification,
                needs_structured_output=True,
                estimated_context_tokens=len(prompt) // 3,
            ),
            prompt=prompt,
            system=DRAFT_SYSTEM,
            max_tokens=1600,
            response_schema=APPROVAL_NOTE_SCHEMA,
        )
    )

    if not outcome.succeeded or outcome.response is None:
        return None, "", outcome.error or "no reasoning model was available"

    structured = outcome.response.structured
    if not structured:
        return (
            None,
            outcome.model_used or "",
            "the model did not return JSON matching the requested schema",
        )

    try:
        content = ApprovalNoteContent.model_validate(structured)
    except Exception as exc:
        return None, outcome.model_used or "", f"the JSON did not validate: {exc}"

    return content, outcome.model_used or "", ""


def _build_prompt(request: str, evidence: list[dict], document_text: str) -> str:
    parts = [f"Request:\n{request}\n"]

    if document_text.strip():
        # Bounded: the attached report and the retrieved passages both have to
        # fit alongside the answer in a 4k-8k window.
        parts.append(f"Attached document extract:\n{document_text[:6000]}\n")

    if evidence:
        passages = "\n\n".join(
            f"[{item['document_name']}, p.{item['page']}"
            + (f", {item['section']}" if item.get("section") else "")
            + f"]\n{item['text'][:900]}"
            for item in evidence
        )
        parts.append(f"Retrieved passages:\n{passages}\n")
    else:
        parts.append(
            "Retrieved passages: none. Say so in the summary rather than "
            "asserting anything the corpus does not support.\n"
        )

    parts.append(
        "Produce the approval note as JSON. Cite only the documents and pages "
        "listed above."
    )
    return "\n".join(parts)
