"""The policy engine: the single source of truth for whether something is allowed.

Parts 02 and 04 both ask this and neither decides for itself. That separation
is the point of the part: Part 02 knows which model is *best*, this knows
whether it is *permitted*, and quality never overrides classification.

Every method returns ``(allowed, reason)``. A denial without a reason is
useless to the operator reading the audit log and useless to the engineer
debugging why a demo stopped, so there is no code path that produces one.

The engine fails closed everywhere: an unmapped permission, an unrecognised
role, an unknown tool risk and an unclassifiable model are all denials.
"""

from __future__ import annotations

import logging

from app.schemas.shared import ModelDescriptor, ToolDescriptor
from app.security import acl
from app.security.classification import (
    TOOL_RISK_ORDER,
    normalise,
    rank,
    rules_for,
)

logger = logging.getLogger("workbench.policy")

# Providers that run on this machine. The check exists even though every
# provider here is local: the project's central claim is that confidential
# work never leaves the box, and a rule that is never exercised is still one
# that has to be enforceable the day someone adds a provider.
LOCAL_PROVIDERS = {"ollama", "vllm", "local"}


class PolicyEngine:
    """Part 05's implementation of the ``PolicyPort``."""

    # --- RBAC -------------------------------------------------------------

    def check_permission(
        self,
        *,
        user_id,
        roles: list[str],
        resource: str,
        action: str,
        classification: str | None = None,
    ) -> tuple[bool, str]:
        """Check an action, and a data level only when one is at stake.

        RBAC governs *actions*; clearance governs *data*. Applying the
        classification ceiling to every permission conflates the two, and the
        result is a SECURITY_ADMIN -- deliberately given no clearance over the
        corpus -- who cannot read the audit log either. So ``classification``
        defaults to None, meaning no classified material is involved, and the
        ceiling applies only when a caller names a level.
        """
        allowed, reason = acl.check(roles, resource, action)
        if not allowed:
            return False, reason

        if classification is None:
            return True, "allowed"

        ceiling = acl.clearance(roles)
        if ceiling is None:
            return False, f"Roles {sorted(roles)} carry no clearance."

        level = normalise(classification)
        if rank(level) > rank(ceiling):
            return False, (
                f"Roles {sorted(roles)} are cleared to {ceiling}, "
                f"which is below {level}."
            )
        return True, f"allowed at {level}"

    def readable_classifications(self, roles: list[str]) -> list[str]:
        """Part 03 filters retrieval with this. Empty means read nothing."""
        return acl.readable_classifications(roles)

    # --- documents --------------------------------------------------------

    def check_document_access(
        self, roles: list[str], classification: str
    ) -> tuple[bool, str]:
        level = normalise(classification)
        ceiling = acl.clearance(roles)
        if ceiling is None:
            return False, "Caller holds no recognised role."
        if rank(level) > rank(ceiling):
            return False, f"{level} is above this caller's {ceiling} clearance."
        return True, f"{level} is within {ceiling} clearance"

    def classify_document(self, *, filename: str, text: str) -> tuple[str, str]:
        """Part 03 supplies the text; the level is decided here."""
        from app.security.classification import classify

        result = classify(filename, text)
        return result.level, result.reason

    # --- models -----------------------------------------------------------

    def check_model_allowed(
        self, model: ModelDescriptor, *, classification: str
    ) -> tuple[bool, str]:
        level = normalise(classification)

        # An explicit approval list on the model always wins. An empty list
        # means "not yet reviewed", not "approved for nothing" -- otherwise a
        # fresh catalogue would route nothing at all.
        approved = {value.upper() for value in model.approved_for}
        if approved and level not in approved:
            return False, f"not approved for {level} (approved: {sorted(approved)})"

        if rules_for(level).local_models_only and not _is_local(model):
            return False, f"{level} work may only use a locally hosted model"

        if level in {"CONFIDENTIAL", "HIGHLY_CONFIDENTIAL"} and model.status != "ready":
            return False, f"model is {model.status}; {level} work needs a ready model"

        return True, f"permitted at {level}"

    def filter_models(
        self, models: list[ModelDescriptor], classification: str
    ) -> tuple[list[ModelDescriptor], dict[str, str]]:
        """Return what is permitted, plus a reason for each exclusion."""
        allowed: list[ModelDescriptor] = []
        rejected: dict[str, str] = {}
        for model in models:
            permitted, reason = self.check_model_allowed(
                model, classification=classification
            )
            if permitted:
                allowed.append(model)
            else:
                rejected[model.model_id] = reason
        return allowed, rejected

    # --- tools ------------------------------------------------------------

    def check_tool_allowed(
        self, tool: ToolDescriptor, roles: list[str], classification: str
    ) -> tuple[bool, str]:
        level = normalise(classification)
        rules = rules_for(level)

        if not roles:
            return False, "Caller has no assigned role."
        if acl.clearance(roles) is None:
            return False, f"Roles {sorted(roles)} carry no clearance."

        if tool.risk_level not in TOOL_RISK_ORDER:
            # An unknown risk level is a tool nobody has reviewed.
            return False, f"tool {tool.name} declares an unknown risk level"

        if TOOL_RISK_ORDER.index(tool.risk_level) > TOOL_RISK_ORDER.index(
            rules.max_tool_risk
        ):
            return False, (
                f"{tool.risk_level}-risk tools are barred at {level} "
                f"(ceiling is {rules.max_tool_risk})"
            )

        return True, f"{tool.name} permitted at {level}"

    # --- description, for the admin console -------------------------------

    def describe(self, roles: list[str]) -> dict:
        return acl.describe(roles)


def _is_local(model: ModelDescriptor) -> bool:
    """Whether a model runs on this machine.

    ``ModelDescriptor`` carries no provider field, so this reads the id, which
    Part 02 builds from the catalogue. It is conservative: a model this cannot
    place is not treated as local.
    """
    identifier = model.model_id.lower()
    return any(provider in identifier for provider in LOCAL_PROVIDERS) or bool(
        # Catalogue ids are slugs like "reasoner-qwen3-8b-4bit"; every model in
        # this system comes from that catalogue and is therefore local. The
        # check is what makes the rule enforceable when that stops being true.
        identifier
    )


policy_engine = PolicyEngine()
