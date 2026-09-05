"""Part 04's implementation of the ``OrchestratorPort``.

Part 01 starts, cancels and resumes a task; everything between those calls is
owned here. The executor's job is to run the graph, keep the task row and the
event stream in step with it, and persist the state so an approval gate can
outlive the request that reached it.

The graph is synchronous and can spend a minute inside a model call, so it is
run in a worker thread. Blocking the event loop would stall the SSE stream
that is meant to be showing the run happen -- the one feature that makes this
look like an agent rather than a slow endpoint.
"""

from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from app.core.dependencies import record_audit
from app.core.events import event_bus
from app.db.database import SessionLocal
from app.db.models.artifact import TaskRun
from app.db.repositories.tasks import TaskRepository
from app.db.repositories.users import UserRepository
from app.orchestration.graph import build_graph
from app.orchestration.state import TaskState, initial_state

logger = logging.getLogger("workbench.orchestration")


class LangGraphOrchestrator:
    """Drives the workflow for one task at a time."""

    def __init__(self) -> None:
        self._graph = build_graph()
        self._cancelled: set[UUID] = set()

    # --- the port ---------------------------------------------------------

    async def start(self, task_id: UUID) -> None:
        state = self._load_initial(task_id)
        if state is None:
            return
        await self._run(task_id, state)

    async def cancel(self, task_id: UUID) -> None:
        # Cooperative: the graph is mid-node in a worker thread and cannot be
        # interrupted safely, so the flag is checked when it next surfaces.
        # Part 01 has already set the row to cancelled either way.
        self._cancelled.add(task_id)
        event_bus.emit(task_id, "task_cancelled", "orchestrator", {})

    async def resume(self, task_id: UUID, *, approved: bool, note: str = "") -> None:
        state = self._load_persisted(task_id)
        if state is None:
            self._fail(
                task_id,
                "The paused state for this task is no longer available, so it "
                "cannot be resumed. Start it again.",
            )
            return

        if not approved:
            with SessionLocal() as db:
                TaskRepository(db).set_status(task_id, "cancelled", error=note)
            event_bus.emit(
                task_id, "task_cancelled", "orchestrator", {"note": note}
            )
            self._persist(task_id, state, last_node="approval_denied")
            return

        state["approved"] = True
        state["approval_note"] = note
        state["resume_from_approval"] = True
        state["status"] = "running"
        await self._run(task_id, state)

    # --- running ----------------------------------------------------------

    async def _run(self, task_id: UUID, state: TaskState) -> None:
        with SessionLocal() as db:
            TaskRepository(db).set_status(task_id, "planning")
        event_bus.emit(task_id, "task_started", "orchestrator", {})

        try:
            # The graph blocks; the loop must not. asyncio.to_thread keeps the
            # SSE stream responsive while a model is generating.
            final = await asyncio.to_thread(self._invoke, task_id, state)
        except Exception as exc:
            logger.exception("orchestrator failed for task %s", task_id)
            self._fail(task_id, f"{type(exc).__name__}: {exc}")
            return

        if task_id in self._cancelled:
            self._cancelled.discard(task_id)
            self._persist(task_id, final, last_node="cancelled")
            return

        self._settle(task_id, final)

    def _invoke(self, task_id: UUID, state: TaskState) -> TaskState:
        """Stream the graph, keeping the task row in step with it.

        Streamed rather than invoked so the task leaves ``planning`` the
        moment the plan exists. The status is not cosmetic: Part 01's
        transition table refuses ``planning -> completed``, and a run that
        never announced it had started would be stuck at the end.
        """
        final = state
        announced = False

        # A recursion limit well above the node count: the only loop in this
        # graph is the single regeneration retry, so anything approaching this
        # is a bug rather than a long task.
        for snapshot in self._graph.stream(
            state, {"recursion_limit": 40}, stream_mode="values"
        ):
            final = snapshot
            if not announced and snapshot.get("plan"):
                announced = True
                with SessionLocal() as db:
                    TaskRepository(db).set_status(task_id, "running")

        if not announced:
            # A run that failed before planning still has to leave "planning",
            # or the terminal status below is refused.
            with SessionLocal() as db:
                TaskRepository(db).set_status(task_id, "running")
        return final

    def _settle(self, task_id: UUID, final: TaskState) -> None:
        """Write the terminal status, persist the state, close the stream."""
        status = final.get("status", "completed")
        self._persist(task_id, final, last_node=status)

        if status == "waiting_approval":
            with SessionLocal() as db:
                TaskRepository(db).set_status(task_id, "waiting_approval")
            record_audit(
                event_type="APPROVAL_REQUESTED",
                action="task:approval",
                component="orchestrator",
                task_id=task_id,
                metadata={"classification": final.get("classification", "INTERNAL")},
            )
            # Deliberately no terminal event: the stream stays open because
            # the task is not finished, it is waiting for a person.
            return

        message = ""
        if status == "failed":
            errors = final.get("errors") or []
            message = errors[-1]["message"] if errors else "the task failed"

        with SessionLocal() as db:
            TaskRepository(db).set_status(task_id, status, error=message or None)

        record_audit(
            event_type="TASK_COMPLETED" if status == "completed" else "TASK_FAILED",
            action="task:finish",
            component="orchestrator",
            task_id=task_id,
            metadata={
                "status": status,
                "artifacts": list(final.get("artifacts") or []),
                "models": list(final.get("selected_models") or []),
                "steps": len(final.get("steps") or []),
                "error": message[:500],
            },
        )
        if status == "failed":
            event_bus.emit(task_id, "task_failed", "orchestrator", {"error": message})

    def _fail(self, task_id: UUID, message: str) -> None:
        with SessionLocal() as db:
            TaskRepository(db).set_status(task_id, "failed", error=message)
        event_bus.emit(task_id, "task_failed", "orchestrator", {"error": message})

    # --- state ------------------------------------------------------------

    def _load_initial(self, task_id: UUID) -> TaskState | None:
        with SessionLocal() as db:
            task = TaskRepository(db).get(task_id)
            if task is None:
                logger.warning("orchestrator asked for unknown task %s", task_id)
                return None
            user = UserRepository(db).get(task.user_id)
            roles = user.role_names if user else []

        return initial_state(
            task_id=str(task_id),
            user_id=str(task.user_id),
            roles=roles,
            request=task.request_text,
            task_type=task.task_type,
            input_files=list(task.input_file_ids or []),
        )

    def _persist(self, task_id: UUID, state: TaskState, *, last_node: str) -> None:
        """Write the state so a paused task survives a restart."""
        with SessionLocal() as db:
            run = (
                db.query(TaskRun).filter(TaskRun.task_id == task_id).one_or_none()
            )
            if run is None:
                run = TaskRun(task_id=task_id)
                db.add(run)
            run.state = dict(state)
            run.last_node = last_node
            errors = state.get("errors") or []
            run.error = errors[-1]["message"][:2000] if errors else ""
            db.commit()

    def _load_persisted(self, task_id: UUID) -> TaskState | None:
        with SessionLocal() as db:
            run = (
                db.query(TaskRun).filter(TaskRun.task_id == task_id).one_or_none()
            )
            return TaskState(**run.state) if run and run.state else None

    # --- read surface for Part 01 ----------------------------------------

    def trace(self, task_id: UUID) -> dict:
        """The execution trace, for the timeline UI."""
        state = self._load_persisted(task_id)
        if state is None:
            return {"steps": [], "plan": [], "status": "unknown"}
        return {
            "status": state.get("status", "unknown"),
            "plan": state.get("plan", []),
            "steps": state.get("steps", []),
            "models": state.get("selected_models", []),
            "tools": state.get("selected_tools", []),
            "sources": state.get("retrieved_sources", []),
            "artifacts": state.get("artifacts", []),
            "validation": state.get("validation_results", {}),
            "errors": state.get("errors", []),
        }


def install() -> None:
    """Swap the placeholders for the real orchestrator and artifact store."""
    from app.artifacts.store import artifact_store
    from app.integrations import registry
    from app.tools import register_default_tools

    register_default_tools()
    registry.register_orchestrator(LangGraphOrchestrator())
    registry.register_artifacts(artifact_store)
