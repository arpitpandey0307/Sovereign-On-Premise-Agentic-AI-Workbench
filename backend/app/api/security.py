"""Security, audit and sovereignty endpoints.

Part 05 computes all of this; Part 01 owns the HTTP surface, so the routes sit
alongside the others. They power the security dashboard, the audit log viewer,
the admin console and the sovereignty widget.

Everything here is ADMIN or SECURITY_ADMIN only. The audit ledger records who
did what across the whole system, and the sovereignty view describes how the
system is defended -- neither is something an ordinary engineer needs, and
both are useful to someone probing it.

The one exception is the task receipt, which the task's own owner may read:
it is the evidence that *their* work stayed on the machine, and withholding it
from them would defeat its purpose.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.audit.events import EVENT_TYPES
from app.audit.ledger import audit_ledger
from app.core.dependencies import DbSession, require
from app.core.errors import NotFoundError
from app.db.models import User
from app.db.repositories.tasks import TaskRepository
from app.schemas.api import TraceEntry
from app.security import acl
from app.security.classification import CLASSIFICATION_ORDER, RULES
from app.security.network import egress_monitor

router = APIRouter(tags=["security"])

SecurityUser = Annotated[User, Depends(require("security", "read"))]
AuditUser = Annotated[User, Depends(require("audit", "read"))]
TaskUser = Annotated[User, Depends(require("task", "read"))]


@router.get("/api/v1/security/status")
def security_status(user: SecurityUser) -> dict:
    """The security dashboard: policy in force and egress observed."""
    egress = egress_monitor.snapshot()
    return {
        "classification_levels": CLASSIFICATION_ORDER,
        "policy": {
            level: {
                "local_models_only": rules.local_models_only,
                "max_tool_risk": rules.max_tool_risk,
                "human_approval_required": rules.human_approval_required,
                "restricted_artifact_storage": rules.restricted_artifact_storage,
                "notes": rules.notes,
            }
            for level, rules in RULES.items()
        },
        "roles": {
            role: {
                "clearance": acl.ROLE_CLEARANCE[role],
                "readable_classifications": acl.readable_classifications([role]),
            }
            for role in acl.ROLES
        },
        "sovereignty": egress.as_dict(),
    }


@router.get("/api/v1/security/sovereignty")
def sovereignty(user: SecurityUser) -> dict:
    """The network monitor widget, backed by real counts.

    ``monitoring`` matters as much as the numbers: zero external calls from a
    monitor that is not running is not evidence of anything, so the widget is
    told whether it is looking at an observation or at silence.
    """
    egress = egress_monitor.snapshot()
    payload = egress.as_dict()
    payload["how_it_is_enforced"] = [
        "in-process audit hook on every socket connect and DNS lookup",
        "code sandbox runs with no network interface at all",
        "model runtimes are refused at construction unless the endpoint is local",
        "compose publishes every service on loopback only",
    ]
    return payload


@router.get("/api/v1/security/network-events")
def network_events(
    user: SecurityUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict:
    """External connection attempts that were actually observed.

    Expected to be empty. It exists so the claim can be checked rather than
    believed, and so a breach would be visible rather than merely counted.
    """
    from sqlalchemy import desc, select

    from app.db.models.audit import NetworkEvent

    rows = db.scalars(
        select(NetworkEvent)
        .where(NetworkEvent.scope == "external")
        .order_by(desc(NetworkEvent.timestamp))
        .limit(limit)
    )
    events = [
        {
            "host": row.host,
            "port": row.port,
            "kind": row.kind,
            "task_id": str(row.task_id) if row.task_id else None,
            "detail": row.detail,
            "at": row.timestamp.isoformat(),
        }
        for row in rows
    ]
    return {"external_events": events, "count": len(events)}


@router.get("/api/v1/security/audit")
def audit_log(
    user: AuditUser,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    event_type: str | None = None,
    user_id: UUID | None = None,
) -> dict:
    """The audit log viewer, newest first."""
    events, total = audit_ledger.recent(
        limit=limit, offset=offset, event_type=event_type, user_id=user_id
    )
    return {
        "items": [
            TraceEntry(
                task_id=event.task_id,
                event_type=event.event_type,
                component=event.component,
                action=event.action,
                metadata=event.metadata,
                timestamp=event.timestamp,
            ).model_dump(mode="json")
            for event in events
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
        "known_event_types": list(EVENT_TYPES),
    }


@router.get("/api/v1/security/permissions")
def my_permissions(user: TaskUser) -> dict:
    """What the calling user may do. Readable by anyone, about themselves only.

    Deliberately not parameterised by user id: this answers "what can I do",
    not "what can they do". The second question is the admin console's, and
    routing it through here would make an ordinary role able to map the
    permission model.
    """
    return acl.describe(user.role_names)


@router.get("/api/v1/tasks/{task_id}/receipt")
def task_receipt(task_id: UUID, user: TaskUser, db: DbSession) -> dict:
    """A task's receipt, assembled from the audit ledger.

    Readable by the task's owner as well as by oversight roles: it is the
    evidence that their own work stayed on this machine.
    """
    task = TaskRepository(db).get(task_id)
    if task is None:
        raise NotFoundError("Task not found.")

    oversight = {"ADMIN", "SECURITY_ADMIN"} & set(user.role_names)
    if task.user_id != user.id and not oversight:
        raise NotFoundError("Task not found.")

    receipt = audit_ledger.receipt(task_id)
    receipt["request"] = task.request_text
    receipt["status"] = task.status
    receipt["input_files"] = list(task.input_file_ids or [])
    return receipt
