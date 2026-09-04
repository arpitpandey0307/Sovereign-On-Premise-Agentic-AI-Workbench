"""Thin wrapper over Part 05's policy engine.

Part 02 never decides whether a model may see a given classification. It asks,
and it records the answer. This module exists so that when Part 05 lands, the
only thing that changes is what the registry returns -- not the router.
"""

from __future__ import annotations

from app.db.models.model_registry import ModelRecord
from app.integrations import registry as integrations
from app.models.registry import to_descriptor

# Section 3 of the Part 05 spec. Compared case-insensitively because the spec
# writes them lowercase in policy rules and uppercase in the classification
# ladder.
CLASSIFICATION_ORDER = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_CONFIDENTIAL"]


def normalise(classification: str) -> str:
    value = (classification or "INTERNAL").upper()
    return value if value in CLASSIFICATION_ORDER else "INTERNAL"


def filter_models(
    records: list[ModelRecord], classification: str
) -> tuple[list[ModelRecord], dict[str, str]]:
    """Return the models Part 05 permits, plus a reason for each exclusion."""
    level = normalise(classification)
    policy = integrations.get_policy()

    allowed: list[ModelRecord] = []
    rejected: dict[str, str] = {}

    for record in records:
        permitted, reason = policy.check_model_allowed(
            to_descriptor(record), classification=level
        )
        if permitted:
            allowed.append(record)
        else:
            rejected[record.id] = reason

    return allowed, rejected


def is_local(record: ModelRecord) -> bool:
    """Every provider in this system is local.

    The check exists anyway, and is visible in the routing rationale, because
    the project's central claim is that confidential work never leaves the
    machine. A rule that is never exercised still has to be enforceable.
    """
    return record.provider in {"ollama", "vllm", "local"}
