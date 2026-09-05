"""Role-based access control: the permission matrix and role clearances.

Simple by design. The spec is explicit that the MVP is role → allowed
classifications → allowed tools, with attribute-based access control and
Keycloak as Phase 2. A more elaborate model here would be harder to reason
about in a review and no more correct.

Two rules the whole file exists to enforce:

**An unmapped permission is denied.** Not logged and allowed, not defaulted to
the caller's favour -- denied, with a reason saying no policy defines it. An
endpoint whose permission nobody declared is a bug, and guessing in the
caller's favour is how privilege escalation happens.

**An unrecognised role reads nothing.** A role the engine has never heard of
gets no clearance at all, rather than the lowest one, because inventing an
answer for an unknown principal is the same failure in a different place.
"""

from __future__ import annotations

from app.security.classification import CLASSIFICATION_ORDER, at_or_below

ROLES = ("ENGINEER", "ANALYST", "MANAGER", "ADMIN", "SECURITY_ADMIN")

# How far up the classification ladder each role may read. ENGINEER and
# ANALYST stop below the top rung: the material there is board-level, and the
# people who work with plant documentation daily are not its audience.
ROLE_CLEARANCE: dict[str, str] = {
    "ENGINEER": "CONFIDENTIAL",
    "ANALYST": "CONFIDENTIAL",
    "MANAGER": "HIGHLY_CONFIDENTIAL",
    "ADMIN": "HIGHLY_CONFIDENTIAL",
    # Reads the audit trail and the security dashboard, not the corpus. A
    # security administrator has no business in the documents themselves, and
    # separating the two is the point of having the role.
    "SECURITY_ADMIN": "PUBLIC",
}

_WORKERS = {"ENGINEER", "ANALYST", "MANAGER", "ADMIN"}
_OVERSIGHT = {"ADMIN", "SECURITY_ADMIN"}

# Who may do what. Anything absent is denied.
PERMISSIONS: dict[tuple[str, str], set[str]] = {
    ("conversation", "read"): _WORKERS,
    ("conversation", "write"): _WORKERS,
    ("file", "read"): _WORKERS,
    ("file", "upload"): _WORKERS,
    ("file", "delete"): _WORKERS,
    ("document", "read"): _WORKERS,
    ("document", "search"): _WORKERS,
    ("document", "ingest"): _WORKERS,
    ("task", "read"): _WORKERS,
    ("task", "create"): _WORKERS,
    ("artifact", "download"): _WORKERS,
    ("model", "read"): _WORKERS | {"SECURITY_ADMIN"},
    # Operational actions that change system state, not just the caller's own
    # data. Deliberately narrower.
    ("model", "admin"): {"ADMIN"},
    ("system", "read"): _OVERSIGHT,
    ("audit", "read"): _OVERSIGHT,
    ("security", "read"): _OVERSIGHT,
}


def clearance(roles: list[str]) -> str | None:
    """The highest classification these roles may read, or ``None`` if unknown."""
    known = [role for role in roles if role in ROLE_CLEARANCE]
    if not known:
        return None
    return max(
        (ROLE_CLEARANCE[role] for role in known),
        key=CLASSIFICATION_ORDER.index,
    )


def readable_classifications(roles: list[str]) -> list[str]:
    """Every level these roles may read. Empty means no clearance at all."""
    ceiling = clearance(roles)
    return at_or_below(ceiling) if ceiling else []


def check(roles: list[str], resource: str, action: str) -> tuple[bool, str]:
    """Return ``(allowed, reason)``. A denial always carries a reason."""
    if not roles:
        return False, "User has no assigned role."

    permitted = PERMISSIONS.get((resource, action))
    if permitted is None:
        return False, f"No policy defines {resource}:{action}."

    held = set(roles)
    if not held & permitted:
        return False, (
            f"{resource}:{action} requires one of {sorted(permitted)}; "
            f"caller holds {sorted(held)}."
        )
    return True, "allowed"


def describe(roles: list[str]) -> dict:
    """What these roles may do, for the admin console."""
    held = set(roles)
    return {
        "roles": sorted(held),
        "clearance": clearance(roles) or "none",
        "readable_classifications": readable_classifications(roles),
        "permissions": sorted(
            f"{resource}:{action}"
            for (resource, action), allowed in PERMISSIONS.items()
            if held & allowed
        ),
    }
