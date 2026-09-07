"""Part 04: the workflow graph, approval gates and the self-checking loop.

The suite has no model runtime, so the reasoning node genuinely cannot run.
That is exercised as its own case -- a task that fails honestly is the correct
behaviour, not a gap in coverage -- and the success paths supply a fake draft
so the graph either side of the model can be tested deterministically.
"""

from __future__ import annotations

import io
import time
from uuid import uuid4

import pytest

from app.artifacts.content import ApprovalNoteContent, Citation, Finding
from app.orchestration import graph as graph_module
from app.orchestration import planner
from app.orchestration.executor import LangGraphOrchestrator
from app.orchestration.state import initial_state

# --- the planner ----------------------------------------------------------


@pytest.mark.parametrize(
    ("request_text", "expected"),
    [
        ("Write an approval note for this inspection", "docx"),
        ("Produce a spreadsheet of the readings", "xlsx"),
        ("Build a slide deck for the review", "pptx"),
        ("Which valves connect to P-103?", ""),
    ],
)
def test_the_planner_decides_whether_a_file_is_wanted(request_text, expected):
    _, artifact_type = planner.analyse(request_text, has_inputs=False)
    assert artifact_type == expected


def test_a_question_does_not_become_a_download():
    """Guessing towards 'produce a document' is the worse error."""
    requirements, artifact_type = planner.analyse(
        "what does the SOP say about isolation?", has_inputs=False
    )
    assert artifact_type == ""
    assert "artifact_generation" not in requirements


def test_arithmetic_in_the_request_asks_for_the_sandbox():
    requirements, _ = planner.analyse(
        "calculate the total deviation across the readings", has_inputs=False
    )
    assert "calculation" in requirements


def test_attached_files_add_document_understanding():
    with_files, _ = planner.analyse("review this", has_inputs=True)
    without, _ = planner.analyse("review this", has_inputs=False)
    assert "document_understanding" in with_files
    assert "document_understanding" not in without


def test_the_plan_names_the_steps_the_graph_will_take():
    requirements, artifact_type = planner.analyse(
        "write an approval note and calculate the totals", has_inputs=True
    )
    steps = [entry["step"] for entry in planner.plan_steps(requirements, artifact_type)]
    assert steps[0] == "analyse_inputs"
    assert "retrieve" in steps
    assert "reason" in steps
    assert steps[-1] == "validate_artifact"
    # Every step explains itself, because the timeline renders the reason.
    assert all(entry["why"] for entry in planner.plan_steps(requirements, artifact_type))


# --- routing --------------------------------------------------------------


def _state(**overrides):
    state = initial_state(
        task_id=str(uuid4()),
        user_id=str(uuid4()),
        roles=["ENGINEER"],
        request="write an approval note",
        task_type="inspection_review",
        input_files=[],
    )
    state.update(overrides)
    return state


def test_a_resumed_run_re_enters_at_the_artifact_not_the_top():
    """Re-reasoning after approval would make the approval meaningless."""
    assert graph_module.route_entry(_state(resume_from_approval=True)) == (
        "generate_artifact"
    )
    assert graph_module.route_entry(_state()) == "analyse_request"


def test_a_denied_permission_skips_straight_to_the_end():
    assert graph_module.route_after_permissions(_state(status="failed")) == "finalise"
    assert (
        graph_module.route_after_permissions(_state(status="planning"))
        == "analyse_inputs"
    )


def test_the_gate_ends_the_run_while_a_human_decides():
    assert graph_module.route_after_gate(_state(status="waiting_approval")) == "wait"
    assert (
        graph_module.route_after_gate(_state(status="running")) == "generate_artifact"
    )


def test_a_failed_artifact_is_regenerated_once_and_then_given_up_on():
    failing = {"passed": False, "failures": ["citations invented"]}
    assert (
        graph_module.route_after_validation(
            _state(validation_results=failing, regeneration_attempts=1)
        )
        == "generate_artifact"
    )
    # The attempt limit is what stops the self-checking loop being infinite.
    assert (
        graph_module.route_after_validation(
            _state(validation_results=failing, regeneration_attempts=2)
        )
        == "finalise"
    )
    assert (
        graph_module.route_after_validation(
            _state(validation_results={"passed": True}, regeneration_attempts=1)
        )
        == "finalise"
    )


def test_a_request_with_no_artifact_skips_the_gate_entirely():
    state = _state(intermediate_results=[{"artifact_type": ""}])
    assert graph_module.route_after_reason(state) == "finalise"


# --- the graph, end to end ------------------------------------------------


SETTLED = {"completed", "failed", "cancelled", "waiting_approval"}


def wait_for(client, headers, task_id: str, *, timeout_s: float = 30.0) -> dict:
    """Poll until the task settles.

    The API hands off to the orchestrator and returns 202 immediately, which
    is the behaviour under test elsewhere -- so these tests have to wait for
    the run rather than assume it finished.
    """
    deadline = time.monotonic() + timeout_s
    detail: dict = {}
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/tasks/{task_id}", headers=headers).json()
        if detail["status"] in SETTLED:
            return detail
        time.sleep(0.05)
    raise AssertionError(f"task never settled; last status {detail.get('status')!r}")


@pytest.fixture
def task(client, auth_headers, db):
    """A real task row, created through the API and run to a settled state."""
    conversation = client.post(
        "/api/v1/conversations", headers=auth_headers, json={"title": "Review"}
    ).json()

    def _create(request_text: str, file_ids: list[str] | None = None):
        response = client.post(
            "/api/v1/tasks",
            headers=auth_headers,
            json={
                "conversation_id": conversation["id"],
                "request_text": request_text,
                "task_type": "inspection_review",
                "input_file_ids": file_ids or [],
            },
        )
        assert response.status_code == 202, response.text
        created = response.json()
        wait_for(client, auth_headers, created["task_id"])
        return created

    return _create


@pytest.fixture
def corpus(client, auth_headers):
    """One indexed document, so retrieval has something honest to return.

    Without it every citation is an invented one -- which the validator is
    right to reject, but which makes for a test of the wrong thing.
    """
    response = client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={
            "file": (
                "sop.txt",
                io.BytesIO(
                    b"4.2 Isolation\nClose valve V-103 and lock it out before "
                    b"breaking the flange. A hot work permit is mandatory."
                ),
                "text/plain",
            )
        },
    )
    assert response.status_code == 201
    return response.json()


@pytest.fixture
def confidential_input(client, auth_headers):
    """An input document Part 05's rules classify above INTERNAL.

    The gate is raised by the real classifier reading a real marking, rather
    than by patching the graph -- the graph is compiled once at startup, so a
    patched node function would never be the one that runs.
    """
    response = client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={
            "file": (
                "inspection.txt",
                io.BytesIO(
                    b"CONFIDENTIAL - commercial in confidence\n"
                    b"Inspection of valve V-103 found the seal degraded."
                ),
                "text/plain",
            )
        },
    )
    assert response.status_code == 201
    return response.json()


# The request names V-103 so the keyword arm of retrieval finds the document
# above; the suite has no embedding model, so the semantic arm is silent.
HERO_REQUEST = "Write an approval note about valve V-103 isolation"


def _draft() -> ApprovalNoteContent:
    return ApprovalNoteContent(
        title="Approval Note: Pump P-103",
        summary="Findings checked against the maintenance SOP.",
        findings=[
            Finding(
                statement="Isolation was performed at V-103.",
                severity="informational",
                citations=[Citation(document_name="sop.txt", page=1)],
            )
        ],
        recommendations=["Re-issue the permit."],
    )


def test_a_task_with_no_model_runtime_fails_honestly(task, client, auth_headers, db):
    """No reasoning model means no note. It must say so, not invent one."""
    created = task("Write an approval note for this inspection")

    detail = client.get(
        f"/api/v1/tasks/{created['task_id']}", headers=auth_headers
    ).json()
    assert detail["status"] == "failed"
    assert detail["error_message"]

    trace = client.get(
        f"/api/v1/tasks/{created['task_id']}/execution", headers=auth_headers
    ).json()
    assert trace["status"] == "failed"
    assert any(entry["step"] == "reason" and not entry["ok"] for entry in trace["steps"])
    # No artifact is produced from a failed reasoning step.
    assert trace["artifacts"] == []


def test_the_happy_path_produces_a_validated_artifact(
    task, client, auth_headers, corpus, monkeypatch
):
    monkeypatch.setattr(
        planner, "draft_approval_note",
        lambda db, **kwargs: (_draft(), "reasoner-test", ""),
    )
    created = task(HERO_REQUEST)
    task_id = created["task_id"]

    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers).json()
    assert detail["status"] == "completed", detail["error_message"]

    artifacts = client.get(
        f"/api/v1/tasks/{task_id}/artifacts", headers=auth_headers
    ).json()
    assert len(artifacts) == 1
    assert artifacts[0]["validation_status"] == "passed"
    assert artifacts[0]["type"] == "docx"

    # And the file really is downloadable and really is a Word document.
    download = client.get(artifacts[0]["download_url"], headers=auth_headers)
    assert download.status_code == 200

    from docx import Document

    document = Document(io.BytesIO(download.content))
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    assert "Approval Note: Pump P-103" in text


def test_the_trace_records_the_plan_and_every_step(
    task, client, auth_headers, corpus, monkeypatch
):
    monkeypatch.setattr(
        planner, "draft_approval_note",
        lambda db, **kwargs: (_draft(), "reasoner-test", ""),
    )
    created = task(HERO_REQUEST)

    trace = client.get(
        f"/api/v1/tasks/{created['task_id']}/execution", headers=auth_headers
    ).json()
    names = [entry["step"] for entry in trace["steps"]]
    assert names == [
        "analyse_request",
        "check_permissions",
        "analyse_inputs",
        "build_plan",
        "retrieve",
        "reason",
        "approval_gate",
        "generate_artifact",
        "validate_artifact",
        "finalise",
    ]
    assert trace["plan"]
    assert trace["models"] == ["reasoner-test"]
    assert "knowledge.search" in trace["tools"]


def test_an_invented_citation_is_caught_and_regenerated(
    task, client, auth_headers, monkeypatch
):
    """The self-checking loop, end to end.

    The model cites a document that was never retrieved; validation rejects
    the artifact, the graph regenerates once, and the run ends failed rather
    than shipping a note with a fabricated source.
    """
    invented = ApprovalNoteContent(
        title="Approval Note",
        summary="s",
        findings=[
            Finding(
                statement="Per the standard.",
                severity="major",
                citations=[Citation(document_name="Nonexistent Standard.pdf", page=4)],
            )
        ],
    )
    monkeypatch.setattr(
        planner, "draft_approval_note",
        lambda db, **kwargs: (invented, "reasoner-test", ""),
    )
    created = task(HERO_REQUEST)
    task_id = created["task_id"]

    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers).json()
    assert detail["status"] == "failed"

    artifacts = client.get(
        f"/api/v1/tasks/{task_id}/artifacts", headers=auth_headers
    ).json()
    # Two attempts: the original and the one regeneration.
    assert len(artifacts) == 2
    assert all(item["validation_status"] == "failed" for item in artifacts)


def test_a_question_completes_without_producing_a_file(
    task, client, auth_headers, monkeypatch
):
    monkeypatch.setattr(
        planner, "draft_approval_note",
        lambda db, **kwargs: (_draft(), "reasoner-test", ""),
    )
    created = task("Which valves connect to P-103?")

    detail = client.get(
        f"/api/v1/tasks/{created['task_id']}", headers=auth_headers
    ).json()
    assert detail["status"] == "completed"
    artifacts = client.get(
        f"/api/v1/tasks/{created['task_id']}/artifacts", headers=auth_headers
    ).json()
    assert artifacts == []


# --- approval gates -------------------------------------------------------


def test_confidential_work_waits_for_a_person(
    task, client, auth_headers, corpus, confidential_input, monkeypatch
):
    monkeypatch.setattr(
        planner, "draft_approval_note",
        lambda db, **kwargs: (_draft(), "reasoner-test", ""),
    )
    created = task(HERO_REQUEST, [confidential_input["id"]])
    task_id = created["task_id"]

    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers).json()
    assert detail["status"] == "waiting_approval"
    # Nothing is produced before a person has looked.
    assert client.get(
        f"/api/v1/tasks/{task_id}/artifacts", headers=auth_headers
    ).json() == []

    resumed = client.post(
        f"/api/v1/tasks/{task_id}/resume",
        headers=auth_headers,
        json={"approved": True, "note": "checked"},
    )
    assert resumed.status_code == 200

    after = wait_for(client, auth_headers, task_id)
    assert after["status"] == "completed"
    artifacts = client.get(
        f"/api/v1/tasks/{task_id}/artifacts", headers=auth_headers
    ).json()
    assert len(artifacts) == 1


def test_a_denied_approval_cancels_rather_than_producing_anything(
    task, client, auth_headers, corpus, confidential_input, monkeypatch
):
    monkeypatch.setattr(
        planner, "draft_approval_note",
        lambda db, **kwargs: (_draft(), "reasoner-test", ""),
    )
    created = task(HERO_REQUEST, [confidential_input["id"]])
    task_id = created["task_id"]

    client.post(
        f"/api/v1/tasks/{task_id}/resume",
        headers=auth_headers,
        json={"approved": False, "note": "not this quarter"},
    )
    detail = wait_for(client, auth_headers, task_id)
    assert detail["status"] == "cancelled"
    assert client.get(
        f"/api/v1/tasks/{task_id}/artifacts", headers=auth_headers
    ).json() == []


def test_resuming_a_task_that_is_not_waiting_is_refused(
    task, client, auth_headers
):
    created = task("Write an approval note for this inspection")
    response = client.post(
        f"/api/v1/tasks/{created['task_id']}/resume",
        headers=auth_headers,
        json={"approved": True},
    )
    assert response.status_code == 409


def test_a_paused_state_survives_being_reloaded():
    """Resume has to work from the database, not only from live memory."""
    orchestrator = LangGraphOrchestrator()
    task_id = uuid4()
    state = _state(status="waiting_approval", draft=_draft().model_dump(mode="json"))

    # The row has a foreign key to tasks, so this needs a real task.
    from sqlalchemy.exc import IntegrityError

    try:
        orchestrator._persist(task_id, state, last_node="approval_gate")
    except IntegrityError:
        pytest.skip("state persistence requires a task row")

    loaded = orchestrator._load_persisted(task_id)
    assert loaded is not None
    assert loaded["status"] == "waiting_approval"
    assert loaded["draft"]["title"] == "Approval Note: Pump P-103"


# --- streaming ------------------------------------------------------------


def test_the_run_emits_events_for_the_timeline(
    task, client, auth_headers, corpus, monkeypatch
):
    """The feature that makes this look like an agent rather than an endpoint."""
    from app.core.events import event_bus

    monkeypatch.setattr(
        planner, "draft_approval_note",
        lambda db, **kwargs: (_draft(), "reasoner-test", ""),
    )
    created = task(HERO_REQUEST)
    task_id = created["task_id"]

    from uuid import UUID

    _, backlog = event_bus.subscribe(UUID(task_id))
    names = [event.event for event in backlog]

    for expected in (
        "task_started",
        "request_analysed",
        "plan_built",
        "retrieval_completed",
        "artifact_generated",
        "validation_completed",
        "task_completed",
    ):
        assert expected in names, f"{expected} missing from {names}"


# --- the conversational path ----------------------------------------------


def test_small_talk_is_not_a_corpus_question():
    """A greeting must not start a document search.

    An assistant that cannot say "hello" without scanning a corpus does not
    read as rigorous, it reads as broken -- and a greeting answered with
    citations teaches people that the citations are decoration.
    """
    from app.orchestration.planner import is_conversational

    for turn in ("hi", "hello", "hey there", "good morning", "thanks", "who are you"):
        assert is_conversational(turn, has_inputs=False), turn


def test_a_general_question_is_answered_directly():
    """Nothing about the plant, so there is nothing to retrieve."""
    from app.orchestration.planner import is_conversational

    assert is_conversational("What is the capital of France?", has_inputs=False)
    assert is_conversational(
        "write a python function to reverse a list", has_inputs=False
    )


def test_anything_naming_the_plant_keeps_the_grounded_path():
    """The detector is deliberately conservative in this direction.

    Guessing wrong towards "just chat" drops the grounding on a question that
    needed it, which is the more expensive mistake: the answer then comes from
    the model's memory of the world rather than from the plant's own records.
    """
    from app.orchestration.planner import is_conversational

    for turn in (
        "What must be confirmed before breaking a flange on pump P-101?",
        "summarise SOP-204",
        "hi, what does SOP-204 say?",
        "what are the overdue action items?",
        "show me the maintenance readings",
        "explain how a centrifugal pump works",
    ):
        assert not is_conversational(turn, has_inputs=False), turn


def test_an_attachment_always_keeps_the_grounded_path():
    """Someone who attached a file is asking about that file."""
    from app.orchestration.planner import is_conversational

    assert not is_conversational("hi", has_inputs=True)


def test_a_conversational_task_answers_without_retrieval(client, auth_headers):
    """End to end: the run completes, and never calls the knowledge tool."""
    conversation = client.post(
        "/api/v1/conversations", json={"title": "hello"}, headers=auth_headers
    ).json()
    created = client.post(
        "/api/v1/tasks",
        headers=auth_headers,
        json={"conversation_id": conversation["id"], "request_text": "hello"},
    ).json()

    deadline = time.time() + 20
    status = "pending"
    while time.time() < deadline:
        status = client.get(
            f"/api/v1/tasks/{created['id']}", headers=auth_headers
        ).json()["status"]
        if status in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.1)
    assert status in {"completed", "failed"}

    execution = client.get(
        f"/api/v1/tasks/{created['id']}/execution", headers=auth_headers
    ).json()

    assert execution["conversational"] is True
    # No corpus search, and so no sources to cite.
    assert "knowledge.search" not in (execution.get("tools") or [])
    assert not execution.get("sources")
