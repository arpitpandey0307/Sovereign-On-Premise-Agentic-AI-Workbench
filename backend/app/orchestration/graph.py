"""The LangGraph workflow.

    START -> analyse_request -> check_permissions -> analyse_inputs
          -> build_plan -> retrieve -> reason -> approval_gate
          -> generate_artifact -> validate_artifact -> finalise -> END

Every node has deterministic control before and after any model call. That is
the design rule from the spec and it is what makes this demoable: the agent
cannot decide to do something the graph has no edge for. A free-form loop that
picks its own next action is more impressive on paper and much worse on stage.

Two conditional edges carry the interesting behaviour:

- ``approval_gate`` ends the run when a human has to look, leaving the task in
  ``waiting_approval``. Resuming re-enters the graph directly at artifact
  generation, so the expensive reasoning is not repeated.
- ``validate_artifact`` sends a failed artifact back to be regenerated once,
  with the validator's complaints fed in. This is the self-checking loop; the
  attempt limit is what stops it becoming an infinite one.
"""

from __future__ import annotations

import logging
from uuid import UUID

from langgraph.graph import END, START, StateGraph

from app.artifacts.content import ApprovalNoteContent
from app.artifacts.store import artifact_store
from app.artifacts.validator import validate_docx, validate_opens
from app.core.config import settings
from app.core.events import event_bus
from app.db.database import SessionLocal
from app.integrations import registry
from app.orchestration import planner
from app.orchestration.state import TaskState, error, step
from app.schemas.shared import Evidence
from app.tools.base import ToolContext
from app.tools.gateway import gateway

logger = logging.getLogger("workbench.orchestration")

# One retry. A validator that keeps rejecting is telling you the model cannot
# do this task, and a third attempt costs a minute to learn the same thing.
MAX_REGENERATION_ATTEMPTS = 1


def _context(state: TaskState) -> ToolContext:
    return ToolContext(
        task_id=UUID(state["task_id"]),
        user_id=UUID(state["user_id"]),
        roles=list(state.get("roles") or []),
        classification=state.get("classification", "INTERNAL"),
        input_file_ids=[UUID(value) for value in state.get("input_files") or []],
    )


def _emit(state: TaskState, event: str, data: dict) -> None:
    event_bus.emit(UUID(state["task_id"]), event, "orchestrator", data)


# --- nodes ----------------------------------------------------------------


def analyse_request(state: TaskState) -> dict:
    """Decide what the request needs. Deterministic, no model."""
    requirements, artifact_type = planner.analyse(
        state["request"], has_inputs=bool(state.get("input_files"))
    )
    _emit(
        state,
        "request_analysed",
        {"requirements": requirements, "artifact_type": artifact_type or "none"},
    )
    return {
        "requirements": requirements,
        "intermediate_results": [{"artifact_type": artifact_type}],
        "steps": [
            step("analyse_request", requirements=requirements, artifact=artifact_type)
        ],
    }


def check_permissions(state: TaskState) -> dict:
    """Ask Part 05 whether this user may run this task at all."""
    allowed, reason = registry.get_policy().check_permission(
        user_id=UUID(state["user_id"]),
        roles=list(state.get("roles") or []),
        resource="task",
        action="create",
        classification=state.get("classification", "INTERNAL"),
    )
    if not allowed:
        _emit(state, "permission_denied", {"reason": reason})
        return {
            "status": "failed",
            "errors": [error("check_permissions", reason)],
            "steps": [step("check_permissions", ok=False, reason=reason)],
        }
    return {"steps": [step("check_permissions", reason=reason)]}


def analyse_inputs(state: TaskState) -> dict:
    """Read the attached documents, and take the task's classification from them.

    The classification is the highest of the inputs', not a default: every
    later model choice and policy check is made against it, so guessing low
    here would quietly widen what the rest of the run is allowed to do.
    """
    from app.routing.policies import CLASSIFICATION_ORDER

    context = _context(state)
    extracts: list[dict] = []
    classification = state.get("classification", "INTERNAL")

    for file_id in state.get("input_files") or []:
        result = gateway.call("file.read", {"file_id": file_id}, context)
        if not result.ok:
            extracts.append({"file_id": file_id, "error": result.error})
            continue

        level = result.data.get("classification", "INTERNAL")
        if CLASSIFICATION_ORDER.index(level) > CLASSIFICATION_ORDER.index(
            classification
        ):
            classification = level

        extracts.append(
            {
                "file_id": file_id,
                "filename": result.data.get("filename", ""),
                "pages": result.data.get("pages", 0),
                "text": result.data.get("text", ""),
            }
        )

    _emit(
        state,
        "inputs_analysed",
        {"documents": len(extracts), "classification": classification},
    )
    return {
        "classification": classification,
        "intermediate_results": [{"input_extracts": extracts}],
        "steps": [step("analyse_inputs", documents=len(extracts))],
    }


def build_plan(state: TaskState) -> dict:
    """Publish the plan before executing it, so the timeline can render ahead."""
    artifact_type = _artifact_type(state)
    plan = planner.plan_steps(list(state.get("requirements") or []), artifact_type)
    _emit(state, "plan_built", {"steps": [entry["step"] for entry in plan]})
    return {"plan": plan, "steps": [step("build_plan", planned=len(plan))]}


def retrieve(state: TaskState) -> dict:
    """Ground the answer in the corpus, through Part 03's tool."""
    context = _context(state)
    result = gateway.call(
        "knowledge.search",
        {"query": state["request"], "limit": 6},
        context,
    )
    sources = result.data.get("results", []) if result.ok else []

    _emit(
        state,
        "retrieval_completed",
        {
            "results": len(sources),
            "documents": sorted({item["document_name"] for item in sources}),
        },
    )
    return {
        "retrieved_sources": sources,
        "selected_tools": ["knowledge.search"],
        "steps": [step("retrieve", ok=result.ok, results=len(sources))],
    }


def reason(state: TaskState) -> dict:
    """The generative step: evidence in, structured findings out."""
    document_text = "\n\n".join(
        extract.get("text", "")
        for entry in state.get("intermediate_results") or []
        for extract in entry.get("input_extracts", [])
    )

    with SessionLocal() as db:
        content, model_id, failure = planner.draft_approval_note(
            db,
            request=state["request"],
            evidence=list(state.get("retrieved_sources") or []),
            document_text=document_text,
            classification=state.get("classification", "INTERNAL"),
        )

    if content is None:
        _emit(state, "reasoning_failed", {"error": failure})
        return {
            "status": "failed",
            "errors": [error("reason", failure)],
            "steps": [step("reason", ok=False, reason=failure)],
        }

    _emit(
        state,
        "model_selected",
        {"model_id": model_id, "purpose": "approval note drafting"},
    )
    _emit(
        state,
        "reasoning_completed",
        {"findings": len(content.findings), "model_id": model_id},
    )
    return {
        "draft": content.model_dump(mode="json"),
        "selected_models": [model_id] if model_id else [],
        "steps": [step("reason", findings=len(content.findings), model=model_id)],
    }


def approval_gate(state: TaskState) -> dict:
    """Decide whether a human must look before a deliverable is produced."""
    classification = state.get("classification", "INTERNAL")
    required = settings.require_approval_above_internal and classification in {
        "CONFIDENTIAL",
        "HIGHLY_CONFIDENTIAL",
    }

    if not required or state.get("approved"):
        return {
            "approval_required": required,
            "steps": [step("approval_gate", required=required, approved=True)],
        }

    _emit(
        state,
        "approval_requested",
        {
            "classification": classification,
            "reason": f"a deliverable drawn from {classification} material "
            "needs sign-off before it is produced",
        },
    )
    return {
        "approval_required": True,
        "status": "waiting_approval",
        "steps": [step("approval_gate", required=True, approved=False)],
    }


def generate_artifact(state: TaskState) -> dict:
    """Build the deliverable deterministically from the drafted content."""
    artifact_type = _artifact_type(state) or "docx"
    context = _context(state)
    draft = dict(state.get("draft") or {})
    attempt = int(state.get("regeneration_attempts", 0)) + 1

    if not draft:
        reason_text = "there is no drafted content to build a document from"
        return {
            "status": "failed",
            "errors": [error("generate_artifact", reason_text)],
            "steps": [step("generate_artifact", ok=False, reason=reason_text)],
        }

    tool = {"docx": "docx.generate", "xlsx": "xlsx.generate", "pptx": "pptx.generate"}[
        artifact_type
    ]
    args = {
        "title": draft.get("title", "Approval Note"),
        "summary": draft.get("summary", ""),
        "findings": draft.get("findings", []),
        "recommendations": draft.get("recommendations", []),
        "filename": f"approval_note_v{attempt}.docx",
    }

    result = gateway.call(tool, args, context)
    if not result.ok:
        return {
            "regeneration_attempts": attempt,
            "status": "failed",
            "errors": [error("generate_artifact", result.error)],
            "steps": [step("generate_artifact", ok=False, reason=result.error)],
        }

    artifact_id = result.data["artifact_id"]
    _emit(
        state,
        "artifact_generated",
        {
            "artifact_id": artifact_id,
            "filename": result.data["filename"],
            "attempt": attempt,
        },
    )
    return {
        "artifacts": [artifact_id],
        "regeneration_attempts": attempt,
        "steps": [step("generate_artifact", artifact_id=artifact_id, attempt=attempt)],
    }


def validate_artifact(state: TaskState) -> dict:
    """Reopen the file and check it says what the evidence supports."""
    artifacts = list(state.get("artifacts") or [])
    if not artifacts:
        return {"validation_results": {"passed": False, "failures": ["no artifact"]}}

    artifact_id = UUID(artifacts[-1])
    payload = artifact_store.read_bytes(artifact_id)
    if payload is None:
        report = {"passed": False, "failures": ["the generated file is missing"]}
        artifact_store.set_validation(artifact_id, "failed", report)
        return {
            "validation_results": report,
            "steps": [step("validate_artifact", ok=False, reason="file missing")],
        }

    record = artifact_store.record(artifact_id)
    artifact_type = record.type if record else "docx"

    if artifact_type == "docx":
        content = ApprovalNoteContent.model_validate(state.get("draft") or {})
        evidence = [
            Evidence(
                document_id=item["document_id"],
                document_name=item["document_name"],
                page=item["page"],
                section=item.get("section"),
                text=item.get("text", ""),
                score=item.get("score", 0.0),
            )
            for item in state.get("retrieved_sources") or []
        ]
        report = validate_docx(payload, content, evidence)
    else:
        report = validate_opens(payload, artifact_type)

    artifact_store.set_validation(
        artifact_id, "passed" if report.passed else "failed", report.as_dict()
    )
    _emit(
        state,
        "validation_completed",
        {
            "artifact_id": str(artifact_id),
            "passed": report.passed,
            "failures": report.failures,
        },
    )
    return {
        "validation_results": report.as_dict(),
        "steps": [
            step("validate_artifact", ok=report.passed, failures=report.failures)
        ],
    }


def finalise(state: TaskState) -> dict:
    """Settle the terminal status and say why."""
    if state.get("status") == "failed":
        return {"steps": [step("finalise", ok=False, status="failed")]}

    validation = state.get("validation_results") or {}
    if state.get("artifacts") and not validation.get("passed", True):
        _emit(
            state,
            "task_failed",
            {
                "reason": "the generated artifact did not pass validation",
                "failures": validation.get("failures", []),
            },
        )
        return {
            "status": "failed",
            "errors": [
                error("finalise", "; ".join(validation.get("failures", []))[:500])
            ],
            "steps": [step("finalise", ok=False, status="failed")],
        }

    _emit(
        state,
        "task_completed",
        {
            "artifacts": list(state.get("artifacts") or []),
            "sources": len(state.get("retrieved_sources") or []),
        },
    )
    return {"status": "completed", "steps": [step("finalise", status="completed")]}


# --- edges ----------------------------------------------------------------


def _artifact_type(state: TaskState) -> str:
    for entry in state.get("intermediate_results") or []:
        if "artifact_type" in entry:
            return entry["artifact_type"]
    return ""


def route_entry(state: TaskState) -> str:
    """A resumed run re-enters at the artifact, not at the top.

    Re-running the reasoning would spend a minute of model time reproducing a
    draft the operator has already read and approved -- and might produce a
    different one, which would make the approval meaningless.
    """
    return "generate_artifact" if state.get("resume_from_approval") else "analyse_request"


def route_after_permissions(state: TaskState) -> str:
    return "finalise" if state.get("status") == "failed" else "analyse_inputs"


def route_after_reason(state: TaskState) -> str:
    if state.get("status") == "failed":
        return "finalise"
    return "approval_gate" if _artifact_type(state) else "finalise"


def route_after_gate(state: TaskState) -> str:
    """End the run while a human is deciding; the executor persists the state."""
    return "wait" if state.get("status") == "waiting_approval" else "generate_artifact"


def route_after_validation(state: TaskState) -> str:
    validation = state.get("validation_results") or {}
    if validation.get("passed", False):
        return "finalise"
    if int(state.get("regeneration_attempts", 0)) > MAX_REGENERATION_ATTEMPTS:
        return "finalise"
    return "generate_artifact"


# --- assembly -------------------------------------------------------------


def build_graph():
    """Compile the workflow. Called once; the result is reused per task."""
    workflow = StateGraph(TaskState)

    workflow.add_node("analyse_request", analyse_request)
    workflow.add_node("check_permissions", check_permissions)
    workflow.add_node("analyse_inputs", analyse_inputs)
    workflow.add_node("build_plan", build_plan)
    workflow.add_node("retrieve", retrieve)
    workflow.add_node("reason", reason)
    workflow.add_node("approval_gate", approval_gate)
    workflow.add_node("generate_artifact", generate_artifact)
    workflow.add_node("validate_artifact", validate_artifact)
    workflow.add_node("finalise", finalise)

    workflow.add_conditional_edges(
        START,
        route_entry,
        {"analyse_request": "analyse_request", "generate_artifact": "generate_artifact"},
    )
    workflow.add_edge("analyse_request", "check_permissions")
    workflow.add_conditional_edges(
        "check_permissions",
        route_after_permissions,
        {"analyse_inputs": "analyse_inputs", "finalise": "finalise"},
    )
    workflow.add_edge("analyse_inputs", "build_plan")
    workflow.add_edge("build_plan", "retrieve")
    workflow.add_edge("retrieve", "reason")
    workflow.add_conditional_edges(
        "reason",
        route_after_reason,
        {"approval_gate": "approval_gate", "finalise": "finalise"},
    )
    workflow.add_conditional_edges(
        "approval_gate",
        route_after_gate,
        {"generate_artifact": "generate_artifact", "wait": END},
    )
    workflow.add_edge("generate_artifact", "validate_artifact")
    workflow.add_conditional_edges(
        "validate_artifact",
        route_after_validation,
        {"generate_artifact": "generate_artifact", "finalise": "finalise"},
    )
    workflow.add_edge("finalise", END)

    return workflow.compile()
