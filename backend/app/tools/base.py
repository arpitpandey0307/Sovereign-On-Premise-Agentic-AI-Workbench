"""The tool interface.

A tool is a capability the agent may ask for. It is never something the model
invokes: the model names a tool and supplies arguments, and the gateway
decides whether that call happens. Keeping the two apart is the whole reason
this layer exists -- a model that could call tools directly would make Part
05's policy engine advisory rather than enforcing.

Every tool declares its risk level and whether it needs a human, and those
declarations are what the gateway and the approval gate read. A tool does not
get to decide at call time that it is safe.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable
from uuid import UUID

from app.schemas.shared import ToolDescriptor


@dataclass
class ToolContext:
    """Who is asking, on whose behalf, and at what sensitivity.

    Passed to every tool rather than being read from a global, so a tool
    cannot accidentally act with more authority than the task it serves.
    """

    task_id: UUID
    user_id: UUID
    roles: list[str] = field(default_factory=list)
    classification: str = "INTERNAL"
    # Files the task was created with. A tool may only touch these.
    input_file_ids: list[UUID] = field(default_factory=list)


@dataclass
class ToolResult:
    ok: bool
    data: dict[str, Any] = field(default_factory=dict)
    error: str = ""
    # Free-form detail for the execution trace. Never fed back to a model as
    # if it were tool output.
    detail: str = ""

    @classmethod
    def failed(cls, error: str, **detail: Any) -> ToolResult:
        return cls(ok=False, error=error, data=dict(detail))


@runtime_checkable
class Tool(Protocol):
    name: str
    description: str
    input_schema: dict
    risk_level: str
    requires_approval: bool

    def execute(self, args: dict, context: ToolContext) -> ToolResult: ...


def descriptor(tool: Tool) -> ToolDescriptor:
    """The cross-part view Part 05's policy engine checks."""
    return ToolDescriptor(
        name=tool.name,
        risk_level=tool.risk_level,  # type: ignore[arg-type]
        requires_approval=tool.requires_approval,
        input_schema=tool.input_schema,
    )
