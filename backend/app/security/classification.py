"""Data classification: the ladder, and what each rung permits.

Every document and every task carries one of four levels, and the policy rules
key off them. This module owns both the ordering and the rules, so there is
one place to read when someone asks "what does CONFIDENTIAL actually mean
here" -- a question that gets asked in exactly the review where a vague answer
is expensive.

Two decisions worth stating:

**Classification is never guessed downward.** An unmarked document is one
nobody has reviewed yet, so it lands at INTERNAL. PUBLIC has to be claimed
explicitly, because treating an unreviewed document as publishable is the
failure that actually matters.

**A marking anywhere wins.** A report whose body is unremarkable but whose
header says HIGHLY CONFIDENTIAL is a highly confidential report. The scan
looks at the filename and the opening pages, which is where markings live.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# The ladder, lowest first. Everything else in this part indexes into it, so
# the order is the definition rather than a convention.
CLASSIFICATION_ORDER: list[str] = [
    "PUBLIC",
    "INTERNAL",
    "CONFIDENTIAL",
    "HIGHLY_CONFIDENTIAL",
]

DEFAULT_CLASSIFICATION = "INTERNAL"


def normalise(level: str | None) -> str:
    """Coerce anything unrecognised to the safe default rather than trusting it."""
    value = (level or "").strip().upper().replace(" ", "_").replace("-", "_")
    return value if value in CLASSIFICATION_ORDER else DEFAULT_CLASSIFICATION


def rank(level: str) -> int:
    return CLASSIFICATION_ORDER.index(normalise(level))


def at_or_below(level: str) -> list[str]:
    """Every level a holder of ``level`` clearance may read."""
    return CLASSIFICATION_ORDER[: rank(level) + 1]


def highest(levels: list[str]) -> str:
    """The most sensitive of several. Used when a task has many inputs."""
    if not levels:
        return DEFAULT_CLASSIFICATION
    return max((normalise(level) for level in levels), key=rank)


@dataclass(frozen=True)
class ClassificationRules:
    """What a level permits. Read by the policy engine, never by callers."""

    level: str
    local_models_only: bool = True
    external_tools_allowed: bool = False
    max_tool_risk: str = "high"
    human_approval_required: bool = False
    restricted_artifact_storage: bool = False
    notes: str = ""


RULES: dict[str, ClassificationRules] = {
    "PUBLIC": ClassificationRules(
        level="PUBLIC",
        max_tool_risk="high",
        notes="Broadest tool access. External network is still never allowed.",
    ),
    "INTERNAL": ClassificationRules(
        level="INTERNAL",
        max_tool_risk="high",
        notes="Default. Broad tool access, no external calls.",
    ),
    "CONFIDENTIAL": ClassificationRules(
        level="CONFIDENTIAL",
        max_tool_risk="high",
        notes="Local models only, internal tools only.",
    ),
    "HIGHLY_CONFIDENTIAL": ClassificationRules(
        level="HIGHLY_CONFIDENTIAL",
        # A high-risk tool at this level is the case the spec singles out.
        # Code execution against the most sensitive material waits for a
        # person even though the sandbox is sound.
        max_tool_risk="medium",
        human_approval_required=True,
        restricted_artifact_storage=True,
        notes="Local models only, no high-risk tools, sign-off before finalising.",
    ),
}

TOOL_RISK_ORDER = ["low", "medium", "high"]


def rules_for(level: str) -> ClassificationRules:
    return RULES[normalise(level)]


# --- detecting a marking --------------------------------------------------

# Ordered most sensitive first: the first hit wins, so a document carrying
# both "confidential" and "highly confidential" lands on the higher rung.
_MARKERS: list[tuple[str, tuple[str, ...]]] = [
    (
        "HIGHLY_CONFIDENTIAL",
        (
            "HIGHLY CONFIDENTIAL",
            "STRICTLY CONFIDENTIAL",
            "TOP SECRET",
            "RESTRICTED ACCESS",
            "BOARD CONFIDENTIAL",
            "TRADE SECRET",
        ),
    ),
    (
        "CONFIDENTIAL",
        (
            "CONFIDENTIAL",
            "COMMERCIAL IN CONFIDENCE",
            "PROPRIETARY",
            "NOT FOR CIRCULATION",
            "INTERNAL USE ONLY",
            "P&ID",
            "PIPING AND INSTRUMENTATION",
            "HAZOP",
        ),
    ),
    ("PUBLIC", ("FOR PUBLIC RELEASE", "PUBLIC DOMAIN", "UNCLASSIFIED")),
]

_WHITESPACE = re.compile(r"\s+")


@dataclass
class ClassificationResult:
    level: str
    reason: str
    matched: list[str] = field(default_factory=list)


def classify(filename: str, text: str) -> ClassificationResult:
    """Decide a document's level from its markings.

    Whitespace is collapsed first so a marking broken across a line break --
    which is what OCR of a stamped header usually produces -- is still found.
    """
    haystack = _WHITESPACE.sub(" ", f"{filename} {text}").upper()

    for level, markers in _MARKERS:
        hits = [marker for marker in markers if marker in haystack]
        if hits:
            return ClassificationResult(
                level=level,
                reason=f"matched {', '.join(sorted(hits)[:3])}",
                matched=sorted(hits),
            )

    return ClassificationResult(
        level=DEFAULT_CLASSIFICATION,
        reason="no sensitivity marking found; defaulted to INTERNAL",
    )
