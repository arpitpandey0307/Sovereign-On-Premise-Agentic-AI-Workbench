"""Covers the shared-contract field names and the error envelope.

These are the seams the frontend and the other four parts code against, so a
silent rename here is more damaging than a broken endpoint.
"""

from __future__ import annotations

import io
from pathlib import Path

from app.core.config import settings


def _task(client, headers):
    conversation = client.post(
        "/api/v1/conversations", json={"title": "Contract check"}, headers=headers
    ).json()
    return client.post(
        "/api/v1/tasks",
        json={
            "conversation_id": conversation["id"],
            "request_text": "Check the response contract.",
        },
        headers=headers,
    ).json()


def test_task_response_uses_the_contract_field_name(client, auth_headers):
    body = _task(client, auth_headers)

    # schemas/shared.py and the Part 01 spec both name this ``task_id``.
    assert "task_id" in body
    # ``id`` stays available so either spelling works client-side.
    assert body["id"] == body["task_id"]


def test_task_detail_and_list_keep_both_names(client, auth_headers):
    task_id = _task(client, auth_headers)["task_id"]

    detail = client.get(f"/api/v1/tasks/{task_id}", headers=auth_headers).json()
    assert detail["task_id"] == detail["id"] == task_id
    assert "steps" in detail

    listing = client.get("/api/v1/tasks", headers=auth_headers).json()
    assert all(item["task_id"] == item["id"] for item in listing["items"])


def test_unknown_route_uses_the_error_envelope(client):
    response = client.get("/api/v1/does-not-exist")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_wrong_method_uses_the_error_envelope(client):
    response = client.delete("/api/v1/auth/login")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "method_not_allowed"


def test_unhandled_error_is_wrapped_and_does_not_leak_internals():
    """An unexpected exception must still answer in the standard shape.

    Built on a throwaway app so the failing route never touches the real one.
    ``raise_server_exceptions=False`` makes the test client behave like a real
    server, which returns the response instead of re-raising.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.core.errors import register_exception_handlers

    probe = FastAPI()
    register_exception_handlers(probe)

    @probe.get("/boom")
    def _boom():
        raise RuntimeError("secret internal detail")

    with TestClient(probe, raise_server_exceptions=False) as probe_client:
        response = probe_client.get("/boom")

    assert response.status_code == 500
    body = response.json()["error"]
    assert body["code"] == "internal_error"
    assert "secret internal detail" not in body["message"]


def test_rejected_oversized_upload_leaves_no_file_behind(
    client, auth_headers, monkeypatch
):
    root = Path(settings.storage_root)
    before = {p for p in root.rglob("*") if p.is_file()}

    monkeypatch.setattr(settings, "max_upload_size_mb", 0.0001)
    response = client.post(
        "/api/v1/files/upload",
        files={"file": ("big.txt", io.BytesIO(b"x" * 50_000), "text/plain")},
        headers=auth_headers,
    )
    assert response.status_code == 413

    after = {p for p in root.rglob("*") if p.is_file()}
    assert after == before, "a partial upload was left on disk"


def test_operator_status_reports_runtime_and_buffer_count(client, make_user):
    """The detail moved behind auth; an operator can still read it."""
    admin, password = make_user(roles=["ADMIN"])
    token = client.post(
        "/api/v1/auth/login", json={"email": admin.email, "password": password}
    ).json()["access_token"]

    body = client.get(
        "/api/v1/system/status", headers={"Authorization": f"Bearer {token}"}
    ).json()
    assert isinstance(body["model_runtime"]["reachable"], bool)
    assert isinstance(body["event_buffers_retained"], int)
    assert body["parts"]["02_model_layer"] in {"stub", "live"}


def test_models_endpoint_requires_auth_and_answers_without_a_runtime(
    client, auth_headers
):
    # The registry exposes model detail, so it is authenticated. Ollama may or
    # may not be up; the endpoint must answer either way.
    assert client.get("/api/v1/models").status_code == 401

    body = client.get("/api/v1/models", headers=auth_headers).json()
    assert isinstance(body["models"], list)
