"""Walking the application's real route table.

FastAPI stores included routers as ``_IncludedRouter`` wrappers rather than
flattening their routes into ``app.routes``, so the obvious loop over
``app.routes`` sees only the handful of endpoints defined directly on the app
-- six, out of nearly fifty. A security test written that way passes without
ever looking at the endpoints it is meant to be checking, which is exactly
what happened here.

This walks the wrappers and reassembles the full paths, so anything asking
"which endpoints does this application actually expose" gets a truthful
answer.
"""

from __future__ import annotations

from typing import Any

# Methods every route answers, which say nothing about what it does.
_UNINTERESTING = {"HEAD", "OPTIONS"}


def iter_routes(app: Any) -> list[tuple[str, str, bool]]:
    """Every routed endpoint as ``(method, path, included_in_schema)``."""
    found: list[tuple[str, str, bool]] = []
    _walk(getattr(app, "routes", []), "", found)
    return found


def paths(app: Any, method: str | None = None) -> set[str]:
    """The set of paths, optionally for one HTTP method."""
    return {
        path
        for verb, path, _ in iter_routes(app)
        if method is None or verb == method.upper()
    }


def _walk(routes: Any, prefix: str, found: list[tuple[str, str, bool]]) -> None:
    for route in routes or []:
        methods = getattr(route, "methods", None)
        if methods:
            path = prefix + getattr(route, "path", "")
            in_schema = getattr(route, "include_in_schema", True)
            for method in sorted(set(methods) - _UNINTERESTING):
                found.append((method, path, in_schema))
            continue

        nested = getattr(route, "original_router", None)
        if nested is None:
            continue

        # The include context already carries the prefix chain the parent
        # applied, and each router bakes its own prefix into its routes'
        # paths -- so adding the router's ``prefix`` here as well would
        # double it.
        context = getattr(route, "include_context", None)
        added = prefix + (getattr(context, "prefix", "") or "")
        _walk(getattr(nested, "routes", []), added, found)
