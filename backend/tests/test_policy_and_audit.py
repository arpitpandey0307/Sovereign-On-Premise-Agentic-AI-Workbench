"""Part 05: classification, RBAC, the policy engine, the ledger and egress.

The theme running through these is that every decision fails closed. An
unmapped permission, an unrecognised role, an unknown tool risk and an
unclassifiable address are all denials, and each of them is a case where the
tempting default would have been to let it through.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.audit.ledger import audit_ledger
from app.schemas.shared import AuditEvent, ModelDescriptor, ToolDescriptor
from app.security import acl
from app.security.classification import (
    CLASSIFICATION_ORDER,
    at_or_below,
    classify,
    highest,
    normalise,
    rank,
    rules_for,
)
from app.security.network import EgressMonitor, is_local
from app.security.policy_engine import policy_engine

# --- classification -------------------------------------------------------


def test_the_ladder_is_ordered_least_to_most_sensitive():
    assert CLASSIFICATION_ORDER == [
        "PUBLIC",
        "INTERNAL",
        "CONFIDENTIAL",
        "HIGHLY_CONFIDENTIAL",
    ]
    assert rank("PUBLIC") < rank("CONFIDENTIAL") < rank("HIGHLY_CONFIDENTIAL")


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("confidential", "CONFIDENTIAL"),
        ("highly confidential", "HIGHLY_CONFIDENTIAL"),
        ("HIGHLY-CONFIDENTIAL", "HIGHLY_CONFIDENTIAL"),
        ("", "INTERNAL"),
        (None, "INTERNAL"),
        ("SUPER_SECRET", "INTERNAL"),
    ],
)
def test_an_unrecognised_level_becomes_the_safe_default(given, expected):
    assert normalise(given) == expected


def test_clearance_covers_everything_at_or_below_it():
    assert at_or_below("CONFIDENTIAL") == ["PUBLIC", "INTERNAL", "CONFIDENTIAL"]
    assert at_or_below("PUBLIC") == ["PUBLIC"]


def test_a_task_takes_the_most_sensitive_of_its_inputs():
    assert highest(["INTERNAL", "CONFIDENTIAL", "PUBLIC"]) == "CONFIDENTIAL"
    assert highest([]) == "INTERNAL"


def test_an_unmarked_document_is_internal_never_public():
    """An unmarked document is unreviewed, not publishable."""
    result = classify("notes.txt", "Routine shift handover notes.")
    assert result.level == "INTERNAL"
    assert result.reason


def test_public_has_to_be_claimed_explicitly():
    assert classify("bulletin.txt", "FOR PUBLIC RELEASE").level == "PUBLIC"


def test_a_marking_anywhere_raises_the_level():
    assert classify("board.pdf", "x").level == "INTERNAL"
    assert classify("x.pdf", "HIGHLY CONFIDENTIAL").level == "HIGHLY_CONFIDENTIAL"
    # The filename counts too.
    assert classify("HAZOP-report.pdf", "").level == "CONFIDENTIAL"


def test_the_higher_marking_wins_when_both_appear():
    result = classify("x.pdf", "CONFIDENTIAL ... STRICTLY CONFIDENTIAL")
    assert result.level == "HIGHLY_CONFIDENTIAL"


def test_a_marking_broken_across_a_line_is_still_found():
    """Which is exactly what OCR of a stamped header produces."""
    assert classify("scan.pdf", "HIGHLY\n   CONFIDENTIAL").level == (
        "HIGHLY_CONFIDENTIAL"
    )


def test_the_top_level_bars_high_risk_tools_and_demands_sign_off():
    rules = rules_for("HIGHLY_CONFIDENTIAL")
    assert rules.max_tool_risk == "medium"
    assert rules.human_approval_required
    assert rules.local_models_only


# --- RBAC -----------------------------------------------------------------


def test_an_unmapped_permission_is_denied():
    allowed, reason = acl.check(["ADMIN"], "reactor", "shutdown")
    assert not allowed
    assert "No policy defines reactor:shutdown" in reason


def test_an_unrecognised_role_gets_no_clearance():
    assert acl.clearance(["INTERN"]) is None
    assert acl.readable_classifications(["INTERN"]) == []


def test_no_role_at_all_is_denied():
    allowed, reason = acl.check([], "task", "read")
    assert not allowed
    assert "no assigned role" in reason


def test_engineers_stop_below_the_top_rung():
    assert acl.clearance(["ENGINEER"]) == "CONFIDENTIAL"
    assert "HIGHLY_CONFIDENTIAL" not in acl.readable_classifications(["ENGINEER"])
    assert "HIGHLY_CONFIDENTIAL" in acl.readable_classifications(["MANAGER"])


def test_a_security_admin_oversees_without_reading_the_corpus():
    """Separating oversight from access is the point of having the role."""
    assert acl.clearance(["SECURITY_ADMIN"]) == "PUBLIC"
    assert acl.check(["SECURITY_ADMIN"], "audit", "read")[0]
    assert not acl.check(["SECURITY_ADMIN"], "document", "read")[0]


def test_the_highest_role_wins_when_several_are_held():
    assert acl.clearance(["ENGINEER", "MANAGER"]) == "HIGHLY_CONFIDENTIAL"


def test_operational_actions_are_admin_only():
    assert not acl.check(["ENGINEER"], "model", "admin")[0]
    assert not acl.check(["MANAGER"], "model", "admin")[0]
    assert acl.check(["ADMIN"], "model", "admin")[0]


# --- the policy engine ----------------------------------------------------


def _model(model_id="reasoner-qwen3-8b-4bit", status="ready", approved=None):
    return ModelDescriptor(
        model_id=model_id,
        type="reasoning",
        capabilities=["reasoning"],
        context_length=8192,
        vram_required_gb=6.5,
        approved_for=approved or [],
        status=status,
    )


def _tool(name="python.execute", risk="high"):
    return ToolDescriptor(
        name=name, risk_level=risk, requires_approval=False, input_schema={}
    )


def test_permission_is_capped_by_clearance():
    allowed, reason = policy_engine.check_permission(
        user_id=uuid4(),
        roles=["ENGINEER"],
        resource="document",
        action="read",
        classification="HIGHLY_CONFIDENTIAL",
    )
    assert not allowed
    assert "cleared to CONFIDENTIAL" in reason


def test_a_model_not_on_its_approval_list_is_refused():
    allowed, reason = policy_engine.check_model_allowed(
        _model(approved=["PUBLIC", "INTERNAL"]), classification="CONFIDENTIAL"
    )
    assert not allowed
    assert "not approved for CONFIDENTIAL" in reason


def test_an_empty_approval_list_means_unreviewed_not_forbidden():
    """Otherwise a fresh catalogue would route nothing at all."""
    allowed, _ = policy_engine.check_model_allowed(
        _model(), classification="INTERNAL"
    )
    assert allowed


def test_confidential_work_needs_a_ready_model():
    allowed, reason = policy_engine.check_model_allowed(
        _model(status="unavailable"), classification="CONFIDENTIAL"
    )
    assert not allowed
    assert "needs a ready model" in reason


def test_filter_models_explains_each_exclusion():
    allowed, rejected = policy_engine.filter_models(
        [
            _model("a"),
            _model("b", approved=["PUBLIC"]),
            _model("c", status="unavailable"),
        ],
        "CONFIDENTIAL",
    )
    assert [model.model_id for model in allowed] == ["a"]
    assert set(rejected) == {"b", "c"}
    assert all(reason for reason in rejected.values())


def test_high_risk_tools_are_barred_at_the_top_level():
    """The case the spec singles out: no code execution on board material."""
    allowed, reason = policy_engine.check_tool_allowed(
        _tool(risk="high"), ["MANAGER"], "HIGHLY_CONFIDENTIAL"
    )
    assert not allowed
    assert "high-risk tools are barred" in reason

    permitted, _ = policy_engine.check_tool_allowed(
        _tool(risk="high"), ["MANAGER"], "CONFIDENTIAL"
    )
    assert permitted


def test_a_tool_with_an_unknown_risk_level_is_refused():
    tool = ToolDescriptor.model_construct(
        name="mystery", risk_level="catastrophic",
        requires_approval=False, input_schema={},
    )
    allowed, reason = policy_engine.check_tool_allowed(tool, ["ADMIN"], "INTERNAL")
    assert not allowed
    assert "unknown risk level" in reason


def test_a_roleless_caller_gets_no_tools():
    allowed, _ = policy_engine.check_tool_allowed(_tool(), [], "PUBLIC")
    assert not allowed


def test_document_access_is_bounded_by_clearance():
    assert policy_engine.check_document_access(["ENGINEER"], "CONFIDENTIAL")[0]
    assert not policy_engine.check_document_access(
        ["ENGINEER"], "HIGHLY_CONFIDENTIAL"
    )[0]


# --- the placeholder, now that every part has landed ----------------------


def test_the_uninstalled_policy_denies_everything():
    """If this is ever reached, Part 05 did not start."""
    from app.integrations.stubs import UninstalledPolicy

    placeholder = UninstalledPolicy()
    assert not placeholder.check_permission(
        user_id=uuid4(), roles=["ADMIN"], resource="task", action="read"
    )[0]
    assert not placeholder.check_tool_allowed(_tool(), ["ADMIN"], "PUBLIC")[0]
    assert placeholder.readable_classifications(["ADMIN"]) == []
    # Ingestion has to label a document as something; the safe answer is the
    # most restrictive level, not the least.
    assert placeholder.classify_document(filename="x", text="y")[0] == (
        "HIGHLY_CONFIDENTIAL"
    )


# --- the audit ledger -----------------------------------------------------


def _event(task_id, **overrides):
    from datetime import UTC, datetime

    payload = {
        "task_id": task_id,
        "user_id": uuid4(),
        "event_type": "TOOL_CALLED",
        "component": "tools",
        "action": "tool:knowledge.search",
        "metadata": {"tool": "knowledge.search"},
        "timestamp": datetime.now(UTC),
    }
    payload.update(overrides)
    return AuditEvent(**payload)


def test_the_ledger_exposes_no_way_to_change_a_row():
    """Append-only is enforced by there being no code that can do otherwise."""
    surface = {name for name in dir(audit_ledger) if not name.startswith("_")}
    assert surface == {"record", "trace", "recent", "event_types", "receipt"}


def test_events_are_written_and_read_back_in_order():
    task_id = uuid4()
    audit_ledger.record(_event(task_id, event_type="TASK_STARTED"))
    audit_ledger.record(_event(task_id, event_type="TOOL_CALLED"))
    audit_ledger.record(_event(task_id, event_type="TASK_COMPLETED"))

    trace = audit_ledger.trace(task_id)
    assert [event.event_type for event in trace] == [
        "TASK_STARTED",
        "TOOL_CALLED",
        "TASK_COMPLETED",
    ]


def test_a_failed_write_does_not_take_down_the_caller(monkeypatch):
    """Losing the user's work because an audit row failed is the worse outcome."""
    from app.audit import ledger as ledger_module

    def _explode():
        raise RuntimeError("database gone")

    monkeypatch.setattr(ledger_module, "SessionLocal", _explode)
    audit_ledger.record(_event(uuid4()))  # must not raise


def test_oversized_metadata_is_trimmed_not_stored_whole():
    """The ledger must not become a second copy of the corpus."""
    task_id = uuid4()
    audit_ledger.record(
        _event(task_id, metadata={"text": "x" * 9000, "tool": "file.read"})
    )
    stored = audit_ledger.trace(task_id)[0].metadata
    assert len(stored["text"]) < 9000
    assert "chars]" in stored["text"]
    assert stored["tool"] == "file.read"


def test_recent_returns_newest_first_and_can_be_filtered():
    task_id = uuid4()
    audit_ledger.record(_event(task_id, event_type="APPROVAL_GRANTED"))
    events, total = audit_ledger.recent(limit=10, event_type="APPROVAL_GRANTED")
    assert total >= 1
    assert all(event.event_type == "APPROVAL_GRANTED" for event in events)


# --- the task receipt -----------------------------------------------------


def test_the_receipt_is_assembled_from_the_ledger_alone():
    task_id = uuid4()
    user_id = uuid4()
    audit_ledger.record(
        _event(task_id, user_id=user_id, event_type="TASK_STARTED", metadata={})
    )
    audit_ledger.record(
        _event(
            task_id, user_id=user_id, event_type="MODEL_SELECTED",
            metadata={"selected": "reasoner-qwen3-8b-4bit"},
        )
    )
    audit_ledger.record(
        _event(
            task_id, user_id=user_id, event_type="KNOWLEDGE_RETRIEVED",
            metadata={"documents": ["Maintenance SOP.pdf"]},
        )
    )
    audit_ledger.record(
        _event(
            task_id, user_id=user_id, event_type="TOOL_DENIED",
            metadata={"tool": "python.execute", "reason": "barred at this level"},
        )
    )
    audit_ledger.record(
        _event(
            task_id, user_id=user_id, event_type="TASK_COMPLETED",
            metadata={"artifacts": ["abc"]},
        )
    )

    receipt = audit_ledger.receipt(task_id)
    assert receipt["models_used"] == ["reasoner-qwen3-8b-4bit"]
    assert receipt["documents_consulted"] == ["Maintenance SOP.pdf"]
    assert receipt["artifacts"] == ["abc"]
    assert receipt["tools_denied"][0]["tool"] == "python.execute"
    # The line the whole system exists to print truthfully.
    assert receipt["external_calls"] == 0
    assert receipt["sovereignty"] == "INTACT"


# --- the egress monitor ---------------------------------------------------


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "localhost", "::1", "10.1.2.3", "192.168.0.5", "172.16.4.4",
     "host.docker.internal", "postgres", "neo4j", "ollama"],
)
def test_local_addresses_are_recognised(host):
    assert is_local(host)


@pytest.mark.parametrize(
    "host",
    ["8.8.8.8", "1.1.1.1", "api.openai.com", "huggingface.co", "example.com",
     "", "93.184.216.34"],
)
def test_anything_not_provably_local_counts_as_external(host):
    """A monitor that guessed permissively would report a clean sheet it had
    not earned."""
    assert not is_local(host)


def test_a_local_connection_is_counted_but_not_flagged():
    monitor = EgressMonitor()
    monitor._on_connect(("socket", ("127.0.0.1", 11434)))
    snapshot = monitor.snapshot()
    assert snapshot.local_connections == 1
    assert snapshot.external_connections == 0
    assert snapshot.as_dict()["network_egress"] == "BLOCKED"


def test_an_external_connection_is_flagged_and_kept(monkeypatch):
    monitor = EgressMonitor()
    monkeypatch.setattr(monitor, "_persist", lambda *args, **kwargs: None)

    monitor._on_connect(("socket", ("8.8.8.8", 443)))
    snapshot = monitor.snapshot()
    assert snapshot.external_connections == 1
    assert snapshot.recent_external[0]["host"] == "8.8.8.8"
    assert snapshot.as_dict()["network_egress"] == "BREACHED"


def test_an_external_dns_lookup_is_flagged(monkeypatch):
    monitor = EgressMonitor()
    monkeypatch.setattr(monitor, "_persist", lambda *args, **kwargs: None)

    monitor._on_dns(("api.openai.com", 443))
    assert monitor.snapshot().external_dns == 1
    monitor._on_dns(("localhost", 5432))
    assert monitor.snapshot().local_dns == 1


def test_the_hook_never_raises_into_the_process():
    """A monitor that breaks what it watches is worse than none."""
    monitor = EgressMonitor()
    for bad in [(), (None,), ("socket", None), ("socket", 12345)]:
        monitor._hook("socket.connect", bad)
        monitor._hook("socket.getaddrinfo", bad)
    monitor._hook("some.other.event", ("whatever",))


def test_persisting_an_attempt_cannot_recurse(monkeypatch):
    """Writing the row opens a database connection, which is itself a socket.

    Without a guard that goes straight back into the hook and recurses without
    bound -- one stray external call would take the process down, which is a
    worse outcome than the call itself.
    """
    from app.db import database

    monitor = EgressMonitor()

    def _reentrant_session():
        # Stand in for the connection the real write opens.
        monitor._on_connect(("socket", ("8.8.8.8", 443)))
        raise RuntimeError("no database in this test")

    monkeypatch.setattr(database, "SessionLocal", _reentrant_session)

    monitor._on_connect(("socket", ("8.8.8.8", 443)))

    # The outer attempt and the one its own write provoked, and then it stops:
    # the second call finds the guard set and returns without persisting.
    assert monitor.snapshot().external_connections == 2


def test_every_event_type_written_is_also_declared():
    """The declared list is the dashboard's filter menu.

    An event type that is written but not listed is one nobody can filter
    for, which is how a whole category of activity becomes invisible in the
    audit viewer without anyone noticing.
    """
    import pathlib
    import re

    from app.audit.events import EVENT_TYPES

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    written: set[str] = set()
    for source in root.rglob("*.py"):
        text = source.read_text(encoding="utf-8")
        written.update(re.findall(r'event_type="([A-Z_]+)"', text))
        written.update(re.findall(r'"([A-Z_]+)" if .* else "([A-Z_]+)"', text) and [])
        for first, second in re.findall(
            r'event_type=\s*"([A-Z_]+)" if [^\n]*? else "([A-Z_]+)"', text
        ):
            written.update({first, second})

    undeclared = sorted(written - set(EVENT_TYPES))
    assert undeclared == [], f"written but not declared: {undeclared}"
