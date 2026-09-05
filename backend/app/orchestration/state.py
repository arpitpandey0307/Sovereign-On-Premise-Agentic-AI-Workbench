"""The orchestrator's state.

This is what LangGraph carries between nodes and what gets checkpointed, so it
has to stay JSON-serialisable: ids are strings, evidence is dicts. Anything
that cannot survive a round trip through JSON cannot survive a pause at an
approval gate, and the whole point of the gate is that the task can wait.

The state is also the execution trace. Every node appends to ``steps`` rather
than overwriting a status field, so "what did the agent actually do" is
answerable from one object after the fact -- which is what the timeline UI
renders and what makes a failed run debuggable.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, TypedDict


def _append(existing: list, incoming: list) -> list:
    """Reducer: nodes add to these lists, they never replace them."""
    return [*(existing or []), *(incoming or [])]


class TaskState(TypedDict, total=False):
    # --- identity, set once at the start ---
    task_id: str
    user_id: str
    roles: list[str]
    request: str
    task_type: str
    input_files: list[str]
    classification: str

    # --- what the planner decided ---
    requirements: list[str]
    plan: list[dict]
    selected_models: Annotated[list[str], _append]
    selected_tools: list[str]

    # --- what execution produced ---
    retrieved_sources: list[dict]
    intermediate_results: Annotated[list[dict], _append]
    draft: dict
    artifacts: Annotated[list[str], _append]
    validation_results: dict

    # --- control ---
    status: str
    approval_required: bool
    approved: bool
    approval_note: str
    resume_from_approval: bool
    regeneration_attempts: int

    # --- the trace ---
    steps: Annotated[list[dict], _append]
    errors: Annotated[list[dict], _append]


def initial_state(
    *,
    task_id: str,
    user_id: str,
    roles: list[str],
    request: str,
    task_type: str,
    input_files: list[str],
) -> TaskState:
    return TaskState(
        task_id=task_id,
        user_id=user_id,
        roles=roles,
        request=request,
        task_type=task_type,
        input_files=input_files,
        classification="INTERNAL",
        requirements=[],
        plan=[],
        selected_models=[],
        selected_tools=[],
        retrieved_sources=[],
        intermediate_results=[],
        draft={},
        artifacts=[],
        validation_results={},
        status="planning",
        approval_required=False,
        approved=False,
        approval_note="",
        resume_from_approval=False,
        regeneration_attempts=0,
        steps=[],
        errors=[],
    )


def step(name: str, ok: bool = True, **detail: Any) -> dict:
    """One entry in the trace."""
    return {
        "step": name,
        "ok": ok,
        "at": datetime.now(UTC).isoformat(),
        **detail,
    }


def error(node: str, message: str) -> dict:
    return {"node": node, "message": message, "at": datetime.now(UTC).isoformat()}
