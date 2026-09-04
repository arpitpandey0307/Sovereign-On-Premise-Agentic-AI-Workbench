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
