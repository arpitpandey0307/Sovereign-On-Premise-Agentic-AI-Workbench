"""Security properties of the exposed surface.

Each test pins one thing that was found open during an audit, so a later
change cannot quietly reopen it.
"""

from __future__ import annotations

import pytest

from app.core.config import settings
from app.core.ratelimit import LoginThrottle, login_throttle


@pytest.fixture(autouse=True)
def _clear_throttle():
    login_throttle._failures.clear()
    login_throttle._locked_until.clear()
    yield
    login_throttle._failures.clear()
    login_throttle._locked_until.clear()


def _token(client, user, password):
    return client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": password}
    ).json()["access_token"]


# --- authorisation --------------------------------------------------------


def test_engineer_cannot_reach_admin_only_endpoints(client, make_user):
    """An operational endpoint must not be reachable by an ordinary user."""
    engineer, password = make_user(roles=["ENGINEER"])
    headers = {"Authorization": f"Bearer {_token(client, engineer, password)}"}

    response = client.post("/internal/models/refresh", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "permission_denied"


def test_admin_can_reach_admin_endpoints(client, make_user):
    admin, password = make_user(roles=["ADMIN"])
    headers = {"Authorization": f"Bearer {_token(client, admin, password)}"}

    assert client.post("/internal/models/refresh", headers=headers).status_code == 200


def test_engineer_cannot_read_system_status(client, make_user):
    engineer, password = make_user(roles=["ENGINEER"])
    headers = {"Authorization": f"Bearer {_token(client, engineer, password)}"}

    assert client.get("/api/v1/system/status", headers=headers).status_code == 403


def test_an_unmapped_permission_fails_closed():
    """A permission nobody defined must be denied, not waved through."""
    from uuid import uuid4

    from app.integrations.stubs import PermissivePolicy

    allowed, reason = PermissivePolicy().check_permission(
        user_id=uuid4(),
        roles=["ADMIN"],
        resource="nuclear_launch",
        action="authorise",
    )
    assert not allowed
    assert "No policy defines" in reason


def test_a_user_with_no_roles_is_denied(client, make_user, db):
    user, password = make_user(roles=["ENGINEER"])
    user.roles.clear()
    db.commit()

    headers = {"Authorization": f"Bearer {_token(client, user, password)}"}
    assert client.get("/api/v1/conversations", headers=headers).status_code == 403


# --- information disclosure -----------------------------------------------


def test_public_health_reveals_nothing_about_the_system(client):
    body = client.get("/health").json()

    assert body == {"status": "ok"}
    # No GPU name, no part topology, no model state to an anonymous caller.
    serialised = str(body).lower()
    for leak in ("gpu", "nvidia", "vram", "stub", "ollama", "model"):
        assert leak not in serialised


def test_system_status_requires_auth(client):
    assert client.get("/api/v1/system/status").status_code == 401


def test_api_schema_is_not_published_by_default(client):
    """The schema names every route; publishing it hands over the map."""
    from app.core.config import Settings

    # The shipped default is off, whatever a developer sets locally.
    assert Settings(_env_file=None).enable_api_docs is False

    # And with it off, the routes genuinely are not served.
    assert settings.enable_api_docs is False
    for path in ("/openapi.json", "/docs", "/redoc"):
        assert client.get(path).status_code == 404, path


def test_validation_errors_do_not_echo_the_submitted_value(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": "not-an-email", "password": "hunter2-secret-value"},
    )
    assert response.status_code == 422

    body = response.json()
    serialised = str(body)
    assert "hunter2-secret-value" not in serialised
    assert "not-an-email" not in serialised
    # It still says which field failed, so the client can act on it.
    assert body["error"]["details"]["errors"][0]["loc"] == ["body", "email"]


def test_unhandled_errors_do_not_leak_internals(client):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.core.errors import register_exception_handlers

    probe = FastAPI()
    register_exception_handlers(probe)

    @probe.get("/boom")
    def _boom():
        raise RuntimeError("/srv/secret/path.py line 42")

    with TestClient(probe, raise_server_exceptions=False) as pc:
        body = pc.get("/boom").json()
    assert "secret" not in str(body)


# --- authentication -------------------------------------------------------


def test_login_is_throttled_after_repeated_failures(client, make_user):
    user, _ = make_user()

    for _ in range(5):
        client.post(
            "/api/v1/auth/login", json={"email": user.email, "password": "wrong"}
        )

    blocked = client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": "wrong"}
    )
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "too_many_attempts"
    assert blocked.json()["error"]["details"]["retry_after_seconds"] > 0


def test_throttle_lockout_blocks_even_the_correct_password(client, make_user):
    """Otherwise an attacker learns the password by seeing the reply change."""
    user, password = make_user()

    for _ in range(5):
        client.post(
            "/api/v1/auth/login", json={"email": user.email, "password": "wrong"}
        )

    response = client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": password}
    )
    assert response.status_code == 429


def test_a_successful_login_clears_the_failure_count():
    throttle = LoginThrottle()
    for _ in range(4):
        throttle.record_failure("email:a@b.local")
    throttle.record_success("email:a@b.local")

    for _ in range(4):
        throttle.record_failure("email:a@b.local")
    allowed, _ = throttle.check("email:a@b.local")
    assert allowed, "the counter should have restarted after the success"


def test_unknown_and_known_accounts_are_indistinguishable(client, make_user):
    user, _ = make_user()

    known = client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": "wrong"}
    )
    unknown = client.post(
        "/api/v1/auth/login",
        json={"email": "ghost@mrpl.local", "password": "wrong"},
    )
    assert known.status_code == unknown.status_code
    assert known.json() == unknown.json()


# --- sovereignty ----------------------------------------------------------


def test_model_providers_refuse_a_remote_endpoint():
    from app.models.ollama import OllamaProvider
    from app.models.vllm import VLLMProvider

    for provider_cls in (OllamaProvider, VLLMProvider):
        with pytest.raises(ValueError, match="non-local"):
            provider_cls("https://api.openai.com")


def test_weak_jwt_secret_is_refused_outside_debug():
    from app.core.config import Settings

    with pytest.raises(ValueError, match="at least 32 bytes"):
        Settings(
            jwt_secret_key="change-me-in-production",
            debug=False,
            _env_file=None,
        )


# --- Part 03: documents and knowledge -------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/documents"),
        ("GET", "/api/v1/documents/00000000-0000-0000-0000-000000000001"),
        ("GET", "/api/v1/documents/00000000-0000-0000-0000-000000000001/pages/1"),
        ("POST", "/api/v1/documents/reingest/00000000-0000-0000-0000-000000000001"),
        ("POST", "/api/v1/knowledge/search"),
        ("GET", "/api/v1/knowledge/equipment/V-103"),
        ("GET", "/internal/knowledge/status"),
    ],
)
def test_no_knowledge_route_is_anonymous(client, method, path):
    """The corpus is confidential industrial work. None of it is public."""
    response = client.request(method, path, json={"query": "V-103"})
    assert response.status_code == 401


def test_retrieval_is_capped_at_the_callers_clearance(client, make_user, db):
    """An ENGINEER must not retrieve text above their clearance.

    Planted directly rather than ingested, because the point is the retrieval
    filter and not what a given user is able to upload.
    """
    from uuid import uuid4

    from app.db.models import Document, DocumentChunk

    engineer, password = make_user(roles=["ENGINEER"])
    manager, manager_password = make_user(roles=["MANAGER"])

    document = Document(
        id=uuid4(),
        file_id=uuid4(),
        owner_id=engineer.id,
        filename="Board Review.pdf",
        mime_type="application/pdf",
        checksum="9" * 64,
        storage_path="unused",
        classification="HIGHLY_CONFIDENTIAL",
        kind="pdf_text",
        status="active",
    )
    db.add(document)
    db.flush()
    db.add(
        DocumentChunk(
            document_id=document.id,
            ordinal=0,
            page=1,
            text="Valve V-999 replacement deferred pending board approval.",
            classification="HIGHLY_CONFIDENTIAL",
            char_count=56,
        )
    )
    db.commit()

    engineer_headers = {
        "Authorization": f"Bearer {_token(client, engineer, password)}"
    }
    blocked = client.post(
        "/api/v1/knowledge/search",
        headers=engineer_headers,
        json={"query": "V-999 board approval", "limit": 10},
    ).json()
    assert all(
        item["document_id"] != str(document.id) for item in blocked["evidence"]
    )
    assert (
        "HIGHLY_CONFIDENTIAL"
        not in blocked["diagnostics"]["classifications_allowed"]
    )

    # The same query as a MANAGER returns it, which proves the filter is a
    # clearance check rather than the search simply finding nothing.
    manager_headers = {
        "Authorization": f"Bearer {_token(client, manager, manager_password)}"
    }
    allowed = client.post(
        "/api/v1/knowledge/search",
        headers=manager_headers,
        json={"query": "V-999 board approval", "limit": 10},
    ).json()
    assert any(
        item["document_id"] == str(document.id) for item in allowed["evidence"]
    )


def test_the_classifier_never_defaults_a_document_to_public(client, make_user):
    """An unmarked document is unreviewed, not publishable."""
    from app.integrations.stubs import PermissivePolicy

    level, reason = PermissivePolicy().classify_document(
        filename="notes.txt", text="Routine shift handover notes."
    )
    assert level == "INTERNAL"
    assert reason

    marked, _ = PermissivePolicy().classify_document(
        filename="board.pdf", text="HIGHLY CONFIDENTIAL - board circulation only"
    )
    assert marked == "HIGHLY_CONFIDENTIAL"


# --- Part 04: orchestration, tools and the sandbox ------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/v1/tasks/00000000-0000-0000-0000-000000000001/execution"),
        ("GET", "/api/v1/tasks/00000000-0000-0000-0000-000000000001/artifacts"),
        ("GET", "/api/v1/tools"),
        ("GET", "/internal/sandbox/status"),
    ],
)
def test_no_orchestration_route_is_anonymous(client, method, path):
    assert client.request(method, path).status_code == 401


def test_the_sandbox_status_is_admin_only(client, make_user):
    """It describes the confinement, which is a map for anyone probing it."""
    engineer, password = make_user(roles=["ENGINEER"])
    headers = {"Authorization": f"Bearer {_token(client, engineer, password)}"}
    assert client.get("/internal/sandbox/status", headers=headers).status_code == 403

    admin, admin_password = make_user(roles=["ADMIN"])
    admin_headers = {
        "Authorization": f"Bearer {_token(client, admin, admin_password)}"
    }
    response = client.get("/internal/sandbox/status", headers=admin_headers)
    assert response.status_code == 200
    assert response.json()["confinement"]["network"] == "none"


def test_there_is_no_endpoint_that_runs_a_tool(client):
    """Tool execution must only ever be reachable through the orchestrator.

    A route that invoked a tool directly would be a second call path that
    skips the policy check, the audit record and the trace event -- all three
    of which live in the gateway.
    """
    from app.main import app

    invoking = [
        route.path
        for route in app.routes
        if getattr(route, "methods", None)
        and "POST" in route.methods
        and "/tools" in route.path
    ]
    assert invoking == []


def test_another_users_task_execution_is_not_readable(client, auth_headers, make_user):
    conversation = client.post(
        "/api/v1/conversations", headers=auth_headers, json={"title": "t"}
    ).json()
    created = client.post(
        "/api/v1/tasks",
        headers=auth_headers,
        json={
            "conversation_id": conversation["id"],
            "request_text": "Write an approval note",
            "task_type": "general",
        },
    ).json()

    other, password = make_user()
    other_headers = {"Authorization": f"Bearer {_token(client, other, password)}"}
    for suffix in ("execution", "artifacts"):
        response = client.get(
            f"/api/v1/tasks/{created['task_id']}/{suffix}", headers=other_headers
        )
        assert response.status_code == 404


def test_a_task_cannot_read_an_input_it_was_not_given(client, auth_headers):
    """The tool context is the authority, not the caller's ownership.

    A user may own many files; a task may only touch the ones it was created
    with, or a single prompt injection could widen its reach to the whole
    corpus.
    """
    from uuid import uuid4

    from app.tools import register_default_tools
    from app.tools.base import ToolContext
    from app.tools.gateway import gateway

    register_default_tools()
    owned_elsewhere = uuid4()
    context = ToolContext(
        task_id=uuid4(),
        user_id=uuid4(),
        roles=["ENGINEER"],
        input_file_ids=[],
    )
    result = gateway.call("file.read", {"file_id": str(owned_elsewhere)}, context)
    assert not result.ok
    assert "not one of this task's inputs" in result.error
