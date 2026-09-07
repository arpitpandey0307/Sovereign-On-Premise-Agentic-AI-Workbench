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
from app.core.dependencies import record_audit
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
    has_inputs = bool(state.get("input_files"))

    # Small talk and general questions are answered directly. An assistant that
    # cannot say "hello" without searching a document corpus does not read as
    # rigorous, and a greeting answered with citations teaches people to
    # ignore citations.
    if planner.is_conversational(state["request"], has_inputs=has_inputs):
        _emit(
            state,
            "request_analysed",
            {"requirements": ["conversation"], "artifact_type": "none"},
        )
        return {
            "conversational": True,
            "requirements": ["conversation"],
            "intermediate_results": [{"artifact_type": ""}],
            "steps": [step("analyse_request", requirements=["conversation"])],
        }

    requirements, artifact_type = planner.analyse(state["request"], has_inputs=has_inputs)
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

    documents = sorted({item["document_name"] for item in sources})
    _emit(
        state,
        "retrieval_completed",
        {"results": len(sources), "documents": documents},
    )
    # Written to the ledger as well as the stream: the stream is for the live
    # timeline and is discarded, the ledger is what the task receipt is built
    # from afterwards.
    record_audit(
        event_type="KNOWLEDGE_RETRIEVED",
        action="knowledge:search",
        component="orchestrator",
        user_id=UUID(state["user_id"]),
        task_id=UUID(state["task_id"]),
        metadata={"results": len(sources), "documents": documents},
    )
    return {
        "retrieved_sources": sources,
        "selected_tools": ["knowledge.search"],
        "steps": [step("retrieve", ok=result.ok, results=len(sources))],
    }


MAX_CODE_ATTEMPTS = 2


PREVIEW_LINES = 4
PREVIEW_CHARS = 600


def _preview(payload: bytes) -> str:
    """The first few lines of a text-shaped file, for the code prompt."""
    try:
        text = payload[:8192].decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - a binary file simply has no preview
        return ""
    lines = [line for line in text.splitlines() if line.strip()][:PREVIEW_LINES]
    return "\n".join(lines)[:PREVIEW_CHARS]


def _stage_inputs(state: TaskState) -> tuple[list[str], dict[str, str]]:
    """Copy the task's attached files into its sandbox workspace.

    The sandbox mounts the workspace, not the object store, so a file has to
    be put there before a program can open it. Raw bytes rather than the
    extracted text: a program computing over a CSV needs the CSV, not a prose
    rendering of it.
    """
    from app.core.storage import storage
    from app.db.repositories.files import FileRepository
    from app.tools import workspace

    staged: list[str] = []
    previews: dict[str, str] = {}
    file_ids = [UUID(value) for value in state.get("input_files") or []]
    if not file_ids:
        return staged, previews

    with SessionLocal() as db:
        repo = FileRepository(db)
        for file_id in file_ids:
            record = repo.get(file_id)
            if record is None:
                continue
            try:
                payload = storage.read(record.storage_path)
                workspace.write(UUID(state["task_id"]), record.filename, payload)
                staged.append(record.filename)
                previews[record.filename] = _preview(payload)
            except (OSError, workspace.WorkspaceError, ValueError):
                # A file too large for the workspace, or missing from storage.
                # The run continues without it and the program is told only
                # about the files that are genuinely there.
                continue
    return staged, previews


def calculate(state: TaskState) -> dict:
    """Write a program, run it in the sandbox, and keep what it printed.

    The planner has always listed this step -- "compute figures exactly, in
    the sandbox" -- and nothing performed it, so the plan named a step the
    system never took. This is that step.

    Figures are computed rather than reasoned because a language model doing
    arithmetic over a 10,000-row file is guessing, and a plant cannot act on a
    guessed number. The program's stdout becomes evidence the reasoning step
    is given; if the sandbox cannot run at all, that is reported as such and
    the run continues without computed figures rather than inventing them.
    """
    context = _context(state)
    staged, previews = _stage_inputs(state)

    code = ""
    model_id = ""
    last_error = ""

    for attempt in range(1, MAX_CODE_ATTEMPTS + 1):
        with SessionLocal() as db:
            code, model_id, failure = planner.write_calculation_code(
                db,
                request=state["request"],
                filenames=staged,
                previews=previews,
                classification=state.get("classification", "INTERNAL"),
                previous_error=last_error,
                effort=state.get("effort", "balanced"),
            )
        if not code:
            _emit(state, "calculation_skipped", {"reason": failure})
            return {
                "steps": [step("calculate", ok=False, reason=failure)],
            }

        _emit(
            state,
            "tool_called",
            {"tool": "python.execute", "risk_level": "high", "attempt": attempt},
        )
        result = gateway.call(
            "python.execute",
            {"code": code, "input_files": staged},
            context,
        )

        data = result.data or {}
        stdout = str(data.get("stdout", ""))
        stderr = str(data.get("stderr", ""))
        exit_code = data.get("exit_code")

        # The sandbox never started. That is not a failed calculation -- no
        # arithmetic was attempted -- and saying so is the difference between
        # "the code was wrong" and "nothing ran".
        if data.get("status") == "unavailable" or (not result.ok and not stderr):
            _emit(
                state,
                "tool_completed",
                {
                    "tool": "python.execute",
                    "ok": False,
                    "component": "sandbox",
                    "detail": result.error or "the code sandbox is unavailable",
                },
            )
            return {
                "steps": [
                    step("calculate", ok=False, reason=result.error, ran=False)
                ],
            }

        _emit(
            state,
            "tool_completed",
            {
                "tool": "python.execute",
                "ok": bool(result.ok),
                "exit_code": exit_code,
                "stdout": stdout[:4000],
                "stderr": stderr[:2000],
                "detail": result.detail,
                "attempt": attempt,
            },
        )

        if result.ok:
            _emit(
                state,
                "calculation_completed",
                {"model_id": model_id, "attempt": attempt, "output": stdout[:2000]},
            )
            return {
                "computation": {
                    "code": code,
                    "stdout": stdout,
                    "model": model_id,
                    "attempts": attempt,
                },
                "selected_tools": ["python.execute"],
                "steps": [
                    step("calculate", model=model_id, attempt=attempt, ran=True)
                ],
            }

        last_error = stderr or result.error

    # Both attempts ran and both failed on their own terms. The failure is
    # reported and the run continues: an answer without computed figures, and
    # honest about it, beats an answer with figures nobody computed.
    return {
        "computation": {
            "code": code,
            "stdout": "",
            "error": last_error,
            "model": model_id,
        },
        "selected_tools": ["python.execute"],
        "steps": [
            step("calculate", ok=False, reason=last_error[:300], ran=True)
        ],
    }


def _as_prose(content, computation: dict | None = None) -> str:
    """Render the model's structured findings as something a person reads.

    The reasoning step has always produced real prose -- a summary, findings
    each with their citations, recommendations -- and it went straight into the
    artifact without ever reaching the thread. So a grounded question returned
    sources and the words "the task finished without returning text", which
    reads as a failure rather than as an answer.

    This is a rendering of what the model actually said, not a second
    generation: nothing is added, and the citations shown beside it are the
    same evidence the findings name.
    """
    parts: list[str] = []

    # Computed figures lead. Someone who asked for a mean wants the number,
    # not a paragraph about the data it came from -- and these are the only
    # numbers in the answer that were calculated rather than described, so
    # burying them among prose is the one thing not to do with them.
    printed = ((computation or {}).get("stdout") or "").strip()
    if printed:
        parts.append(printed)

    summary = (getattr(content, "summary", "") or "").strip()
    if summary:
        parts.append(summary)

    findings = getattr(content, "findings", None) or []
    if findings:
        lines = []
        for finding in findings:
            text = (getattr(finding, "text", "") or "").strip()
            if not text:
                continue
            citation = (getattr(finding, "citation", "") or "").strip()
            lines.append(f"- {text}" + (f" [{citation}]" if citation else ""))
        if lines:
            parts.append("Findings:\n" + "\n".join(lines))

    recommendations = [
        r.strip() for r in (getattr(content, "recommendations", None) or []) if r.strip()
    ]
    if recommendations:
        parts.append(
            "Recommendations:\n" + "\n".join(f"- {r}" for r in recommendations)
        )

    return "\n\n".join(parts).strip()


def reason(state: TaskState) -> dict:
    """The generative step: evidence in, structured findings out."""
    document_text = "\n\n".join(
        extract.get("text", "")
        for entry in state.get("intermediate_results") or []
        for extract in entry.get("input_extracts", [])
    )

    # Anything the sandbox computed is given to the model as fact. It is put
    # in with the document text rather than the evidence list because it is
    # not a retrieved passage -- it is a figure this run produced, and the
    # validator must not be able to mistake it for a citation.
    computation = state.get("computation") or {}
    if computation.get("stdout"):
        document_text = (
            f"--- computed in the sandbox ---\n{computation['stdout']}\n\n"
            f"{document_text}"
        ).strip()

    with SessionLocal() as db:
        content, model_id, failure = planner.draft_approval_note(
            db,
            request=state["request"],
            evidence=list(state.get("retrieved_sources") or []),
            document_text=document_text,
            classification=state.get("classification", "INTERNAL"),
            effort=state.get("effort", "balanced"),
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
    record_audit(
        event_type="MODEL_SELECTED",
        action="model:route",
        component="orchestrator",
        user_id=UUID(state["user_id"]),
        task_id=UUID(state["task_id"]),
        metadata={
            "selected": model_id,
            "purpose": "approval note drafting",
            "classification": state.get("classification", "INTERNAL"),
        },
    )
    answer = _as_prose(content, computation)
    _emit(
        state,
        "reasoning_completed",
        {
            "findings": len(content.findings),
            "model_id": model_id,
            # The answer itself, so the thread shows it as it arrives rather
            # than reporting that nothing came back.
            "output_text": answer,
            "grounded": True,
        },
    )
    return {
        "draft": content.model_dump(mode="json"),
        "answer": answer,
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
    record_audit(
        event_type="ARTIFACT_GENERATED",
        action="artifact:generate",
        component="orchestrator",
        user_id=UUID(state["user_id"]),
        task_id=UUID(state["task_id"]),
        metadata={
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


def converse(state: TaskState) -> dict:
    """Answer a conversational turn with the model alone.

    No retrieval and no artifact: the answer is the deliverable. The text is
    put on the event stream so the thread renders it as it arrives, and kept on
    the state so a reopened conversation shows the same words.
    """
    with SessionLocal() as db:
        answer, model_id, failure = planner.answer_directly(
            db,
            request=state["request"],
            classification=state.get("classification", "INTERNAL"),
            effort=state.get("effort", "balanced"),
        )

    if not answer:
        _emit(state, "reasoning_failed", {"error": failure})
        return {
            "status": "failed",
            "errors": [error("converse", failure)],
            "steps": [step("converse", ok=False, reason=failure)],
        }

    if model_id:
        _emit(state, "model_selected", {"model_id": model_id, "purpose": "conversation"})

    _emit(
        state,
        "reasoning_completed",
        {"model_id": model_id, "output_text": answer, "grounded": False},
    )
    return {
        "answer": answer,
        "selected_models": [model_id] if model_id else [],
        "steps": [step("converse", model=model_id, characters=len(answer))],
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
    if state.get("status") == "failed":
        return "finalise"
    return "converse" if state.get("conversational") else "analyse_inputs"


def route_after_retrieval(state: TaskState) -> str:
    """Compute figures before reasoning about them, when any were asked for."""
    if state.get("status") == "failed":
        return "reason"
    return "calculate" if "calculation" in (state.get("requirements") or []) else "reason"


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
    workflow.add_node("converse", converse)
    workflow.add_node("calculate", calculate)
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
        {
            "analyse_inputs": "analyse_inputs",
            "converse": "converse",
            "finalise": "finalise",
        },
    )
    workflow.add_edge("converse", "finalise")
    workflow.add_edge("analyse_inputs", "build_plan")
    workflow.add_edge("build_plan", "retrieve")
    workflow.add_conditional_edges(
        "retrieve",
        route_after_retrieval,
        {"calculate": "calculate", "reason": "reason"},
    )
    workflow.add_edge("calculate", "reason")
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
