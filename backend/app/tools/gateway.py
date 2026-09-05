"""The tool gateway: the single place a tool call can happen.

    agent -> gateway -> policy check (Part 05) -> tool -> audit

Nothing in the orchestrator calls ``tool.execute`` directly, and nothing else
in the codebase imports a tool module. That is deliberate and worth keeping:
the gateway is where the policy check, the audit record and the trace event
live, and a second call path would bypass all three at once.

The gateway fails closed. An unknown tool, a denied policy check, arguments
that do not match the declared schema, or a tool that raises are all refused
with a reason -- never waved through, and never reported to the agent as
though the tool had run and found nothing.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.dependencies import record_audit
from app.core.events import event_bus
from app.integrations import registry
from app.tools.base import Tool, ToolContext, ToolResult, descriptor

logger = logging.getLogger("workbench.tools")

# Arguments are truncated before they reach the audit ledger and the trace.
# A tool call carrying a page of confidential text must not turn the audit
# log into a second copy of the corpus.
ARG_PREVIEW_CHARS = 300


class ToolGateway:
    """Holds the registry and mediates every call into it."""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    # --- registry ---------------------------------------------------------

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return sorted(self._tools)

    def catalogue(self) -> list[dict]:
        """What the agent is told it may ask for."""
        return [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
                "risk_level": tool.risk_level,
                "requires_approval": tool.requires_approval,
            }
            for tool in (self._tools[name] for name in self.names())
        ]

    # --- the one call path ------------------------------------------------

    def call(self, name: str, args: dict, context: ToolContext) -> ToolResult:
        tool = self._tools.get(name)
        if tool is None:
            # A model asking for a tool that does not exist is a routine
            # hallucination, not an error condition -- it is told plainly.
            return self._refuse(
                name, args, context, f"No tool named {name!r} is registered."
            )

        invalid = _validate(args, tool.input_schema)
        if invalid:
            return self._refuse(name, args, context, invalid)

        allowed, reason = registry.get_policy().check_tool_allowed(
            descriptor(tool), context.roles, context.classification
        )
        if not allowed:
            return self._refuse(name, args, context, f"Policy denied: {reason}")

        event_bus.emit(
            context.task_id,
            "tool_called",
            "tools",
            {
                "tool": name,
                "risk_level": tool.risk_level,
                "args": _preview(args),
            },
        )

        try:
            result = tool.execute(args, context)
        except Exception as exc:
            logger.exception("tool %s raised", name)
            result = ToolResult.failed(f"{type(exc).__name__}: {exc}")

        record_audit(
            event_type="TOOL_CALLED",
            action=f"tool:{name}",
            component="tools",
            user_id=context.user_id,
            task_id=context.task_id,
            metadata={
                "tool": name,
                "risk_level": tool.risk_level,
                "ok": result.ok,
                "args": _preview(args),
                "error": result.error[:300] if result.error else "",
            },
        )
        event_bus.emit(
            context.task_id,
            "tool_completed",
            "tools",
            {"tool": name, "ok": result.ok, "detail": result.detail[:300]},
        )
        return result

    def _refuse(
        self, name: str, args: dict, context: ToolContext, reason: str
    ) -> ToolResult:
        """Record a refusal as deliberately as an execution."""
        record_audit(
            event_type="TOOL_DENIED",
            action=f"tool:{name}",
            component="tools",
            user_id=context.user_id,
            task_id=context.task_id,
            metadata={"tool": name, "reason": reason, "args": _preview(args)},
        )
        event_bus.emit(
            context.task_id,
            "tool_denied",
            "tools",
            {"tool": name, "reason": reason},
        )
        return ToolResult.failed(reason)


def _validate(args: dict, schema: dict) -> str:
    """Check arguments against the declared schema.

    Deliberately small rather than a full JSON Schema implementation: the
    schemas here are flat, and the failure this guards against is a model
    inventing an argument name, not a subtle type coercion. Anything richer
    belongs in a library, and this stays honest about what it checks.
    """
    if not isinstance(args, dict):
        return "Arguments must be an object."

    properties = schema.get("properties", {})
    required = schema.get("required", [])

    missing = [key for key in required if key not in args]
    if missing:
        return f"Missing required argument(s): {', '.join(sorted(missing))}."

    unknown = [key for key in args if key not in properties]
    if unknown:
        return f"Unknown argument(s): {', '.join(sorted(unknown))}."

    expected = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
        "array": list,
        "object": dict,
    }
    for key, value in args.items():
        declared = properties.get(key, {}).get("type")
        python_type = expected.get(declared)
        if python_type is None:
            continue
        # bool is a subclass of int in Python; an argument declared integer
        # must not silently accept True.
        if declared in {"integer", "number"} and isinstance(value, bool):
            return f"Argument {key!r} must be a {declared}."
        if not isinstance(value, python_type):
            return f"Argument {key!r} must be a {declared}."
    return ""


def _preview(args: dict) -> dict:
    """A loggable shape of the arguments, with long values cut short."""
    preview: dict[str, Any] = {}
    for key, value in (args or {}).items():
        if isinstance(value, str) and len(value) > ARG_PREVIEW_CHARS:
            preview[key] = value[:ARG_PREVIEW_CHARS] + f"... [{len(value)} chars]"
        elif isinstance(value, list | dict):
            preview[key] = f"<{type(value).__name__} of {len(value)}>"
        else:
            preview[key] = value
    return preview


gateway = ToolGateway()
