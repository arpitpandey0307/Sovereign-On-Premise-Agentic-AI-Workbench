"""The audit ledger: append-only, and the only write path into it.

Every part writes here; only this part owns the table. The class exposes
``record``, ``trace``, ``recent`` and ``receipt`` -- and deliberately no
update or delete. Append-only is enforced by there being no code that can do
otherwise, which is the honest MVP position: this is tamper-*resistant*, not
tamper-*evident*. Signed records are a later hardening step and claiming them
now would be the wrong thing to tell a judge.

Writes never raise into the caller. An audit failure must not take down the
request that was being audited -- it is logged at error level instead, which
is loud enough to notice and quiet enough not to lose the user's work.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import desc, select

from app.db.database import SessionLocal
from app.db.models.audit import AuditEventRecord, NetworkEvent
from app.schemas.shared import AuditEvent

logger = logging.getLogger("workbench.audit")

# Metadata is a record of what happened, not a copy of what was said. A tool
# call carrying a page of confidential text must not turn the ledger into a
# second corpus, so values are capped.
MAX_METADATA_CHARS = 2000


class AuditLedger:
    """Part 05's implementation of the ``AuditPort``."""

    def record(self, event: AuditEvent) -> None:
        try:
            with SessionLocal() as db:
                db.add(
                    AuditEventRecord(
                        task_id=event.task_id,
                        user_id=event.user_id,
                        event_type=event.event_type[:64],
                        component=event.component[:64],
                        action=event.action[:128],
                        event_metadata=_trim(event.metadata),
                        timestamp=event.timestamp or datetime.now(UTC),
                    )
                )
                db.commit()
        except Exception as exc:  # noqa: BLE001
            # Losing an audit row is bad; losing the user's task because the
            # audit row could not be written is worse.
            logger.error("could not write audit event %s: %s", event.event_type, exc)

    # --- reads ------------------------------------------------------------

    def trace(self, task_id: UUID) -> list[AuditEvent]:
        """Everything recorded for one task, oldest first."""
        with SessionLocal() as db:
            rows = db.scalars(
                select(AuditEventRecord)
                .where(AuditEventRecord.task_id == task_id)
                .order_by(AuditEventRecord.timestamp)
            )
            return [_to_contract(row) for row in rows]

    def recent(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        event_type: str | None = None,
        user_id: UUID | None = None,
    ) -> tuple[list[AuditEvent], int]:
        """The activity feed on the security dashboard, newest first."""
        from sqlalchemy import func

        with SessionLocal() as db:
            stmt = select(AuditEventRecord)
            if event_type:
                stmt = stmt.where(AuditEventRecord.event_type == event_type)
            if user_id:
                stmt = stmt.where(AuditEventRecord.user_id == user_id)

            total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
            rows = db.scalars(
                stmt.order_by(desc(AuditEventRecord.timestamp))
                .limit(limit)
                .offset(offset)
            )
            return [_to_contract(row) for row in rows], int(total)

    def event_types(self) -> list[str]:
        with SessionLocal() as db:
            return sorted(
                value
                for value in db.scalars(
                    select(AuditEventRecord.event_type).distinct()
                )
            )

    # --- the task receipt -------------------------------------------------

    def receipt(self, task_id: UUID) -> dict:
        """Assemble a task's receipt from the ledger alone.

        No new subsystem: this is a query. It is the single most convincing
        artefact to put in front of a reviewer, because every line of it is
        derived from records written as the work happened rather than
        summarised afterwards by the thing being audited.
        """
        events = self.trace(task_id)

        models: list[str] = []
        tools: list[str] = []
        documents: set[str] = set()
        artifacts: list[str] = []
        approvals: list[dict] = []
        denials: list[dict] = []

        for event in events:
            metadata = event.metadata or {}
            if event.event_type == "MODEL_SELECTED" and metadata.get("selected"):
                models.append(str(metadata["selected"]))
            elif event.event_type == "TOOL_CALLED" and metadata.get("tool"):
                tools.append(str(metadata["tool"]))
            elif event.event_type == "TOOL_DENIED":
                denials.append(
                    {"tool": metadata.get("tool"), "reason": metadata.get("reason")}
                )
            elif event.event_type == "KNOWLEDGE_RETRIEVED":
                documents.update(metadata.get("documents") or [])
            elif event.event_type == "DOCUMENT_ACCESSED" and metadata.get(
                "document_id"
            ):
                documents.add(str(metadata["document_id"]))
            elif event.event_type in {"APPROVAL_REQUESTED", "APPROVAL_GRANTED",
                                      "APPROVAL_DENIED"}:
                approvals.append(
                    {
                        "event": event.event_type,
                        "at": event.timestamp.isoformat(),
                        "note": metadata.get("note", ""),
                    }
                )
            elif event.event_type == "ARTIFACT_GENERATED" and metadata.get(
                "artifact_id"
            ):
                artifacts.append(str(metadata["artifact_id"]))
            elif event.event_type == "TASK_COMPLETED":
                artifacts.extend(
                    str(value) for value in metadata.get("artifacts") or []
                )

        with SessionLocal() as db:
            external = (
                db.scalar(
                    select(NetworkEvent).where(
                        NetworkEvent.task_id == task_id,
                        NetworkEvent.scope == "external",
                    )
                )
                is not None
            )
            external_count = len(
                list(
                    db.scalars(
                        select(NetworkEvent).where(
                            NetworkEvent.task_id == task_id,
                            NetworkEvent.scope == "external",
                        )
                    )
                )
            )

        started = events[0].timestamp if events else None
        finished = events[-1].timestamp if events else None

        return {
            "task_id": str(task_id),
            "user_id": str(events[0].user_id) if events and events[0].user_id else None,
            "started_at": started.isoformat() if started else None,
            "finished_at": finished.isoformat() if finished else None,
            "events_recorded": len(events),
            "models_used": sorted(set(models)),
            "tools_used": sorted(set(tools)),
            "tools_denied": denials,
            "documents_consulted": sorted(documents),
            "artifacts": sorted(set(artifacts)),
            "approvals": approvals,
            # The line the whole system exists to be able to print truthfully.
            "external_calls": external_count,
            "sovereignty": "BREACHED" if external else "INTACT",
        }


def _trim(metadata: dict | None) -> dict:
    """Cap what goes into the ledger, keeping the shape readable."""
    trimmed: dict = {}
    for key, value in (metadata or {}).items():
        if isinstance(value, str) and len(value) > MAX_METADATA_CHARS:
            trimmed[key] = value[:MAX_METADATA_CHARS] + f"... [{len(value)} chars]"
        else:
            trimmed[key] = value
    return trimmed


def _to_contract(row: AuditEventRecord) -> AuditEvent:
    return AuditEvent(
        task_id=row.task_id,
        user_id=row.user_id,
        event_type=row.event_type,
        component=row.component,
        action=row.action,
        metadata=row.event_metadata or {},
        timestamp=row.timestamp,
    )


audit_ledger = AuditLedger()
