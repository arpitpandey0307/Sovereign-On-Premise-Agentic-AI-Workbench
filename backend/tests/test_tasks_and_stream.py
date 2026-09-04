from __future__ import annotations

import time
from uuid import uuid4


def _conversation(client, headers):
    return client.post(
        "/api/v1/conversations", json={"title": "Task run"}, headers=headers
    ).json()


def _create_task(client, headers, **overrides):
    payload = {
        "conversation_id": _conversation(client, headers)["id"],
        "request_text": "Draft an approval note from the inspection report.",
        "task_type": "inspection_review",
    }
    payload.update(overrides)
    return client.post("/api/v1/tasks", json=payload, headers=headers)


def test_create_task_returns_immediately_as_pending(client, auth_headers):
    response = _create_task(client, auth_headers)
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "pending"
    assert body["task_type"] == "inspection_review"


def test_task_reaches_a_terminal_status(client, auth_headers):
    task_id = _create_task(client, auth_headers).json()["id"]

    deadline = time.time() + 5
    status = "pending"
    while time.time() < deadline:
        status = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers).json()[
            "status"
        ]
        if status in {"completed", "failed", "cancelled"}:
            break
        time.sleep(0.1)

    assert status == "completed"


def test_unknown_input_file_is_rejected(client, auth_headers):
    response = _create_task(client, auth_headers, input_file_ids=[str(uuid4())])
    assert response.status_code == 404
    assert "missing_file_ids" in response.json()["error"]["details"]


def test_resume_is_refused_unless_waiting_for_approval(client, auth_headers):
    task_id = _create_task(client, auth_headers).json()["id"]
    response = client.post(
        f"/api/v1/tasks/{task_id}/resume", json={"approved": True}, headers=auth_headers
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"


def test_event_stream_delivers_events_and_terminates(client, auth_headers):
    task_id = _create_task(client, auth_headers).json()["id"]

    with client.stream(
        "GET", f"/api/v1/tasks/{task_id}/events", headers=auth_headers
    ) as stream:
        assert stream.status_code == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        events = [
            line.removeprefix("event: ")
            for line in stream.iter_lines()
            if line.startswith("event: ")
        ]

    # The stream must replay what it missed and close on the terminal event
    # rather than hanging the browser connection open.
    assert "task_created" in events
    assert events[-1] == "task_completed"


def test_trace_reads_from_the_audit_ledger(client, auth_headers):
    task_id = _create_task(client, auth_headers).json()["id"]
    trace = client.get(f"/api/v1/tasks/{task_id}/trace", headers=auth_headers)
    assert trace.status_code == 200
    assert any(entry["event_type"] == "TASK_STARTED" for entry in trace.json())


def test_another_users_task_is_not_visible(client, auth_headers, make_user):
    task_id = _create_task(client, auth_headers).json()["id"]

    other, password = make_user()
    token = client.post(
        "/api/v1/auth/login", json={"email": other.email, "password": password}
    ).json()["access_token"]

    response = client.get(
        f"/api/v1/tasks/{task_id}", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 404


def test_public_health_is_a_bare_liveness_probe(client):
    """Anything richer belongs behind auth on /api/v1/system/status."""
    assert client.get("/health").json() == {"status": "ok"}
