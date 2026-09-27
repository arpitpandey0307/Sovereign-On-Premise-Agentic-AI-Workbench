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


# --- migrations -----------------------------------------------------------


def test_migrations_describe_the_current_models(monkeypatch):
    """Every table the code maps must be reachable by ``alembic upgrade head``.

    Part 03's tables were created only by ``create_all`` for a while, which
    works on a dev SQLite file and fails the moment a real deployment runs
    migrations instead. This catches that gap for the next part too.
    """
    import tempfile
    from pathlib import Path

    from alembic.autogenerate import compare_metadata
    from alembic.config import Config
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    from alembic import command
    from app.core.config import settings
    from app.db.database import Base

    with tempfile.TemporaryDirectory(prefix="alembic-check-") as tmp:
        url = f"sqlite:///{(Path(tmp) / 'check.db').as_posix()}"
        # alembic/env.py takes the URL from settings and overrides whatever the
        # config carries, so the setting is what has to be redirected -- not
        # the Config object.
        monkeypatch.setattr(settings, "database_url", url)

        config = Config("alembic.ini")
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")

        engine = create_engine(url)
        try:
            with engine.connect() as connection:
                context = MigrationContext.configure(
                    connection,
                    opts={"target_metadata": Base.metadata, "compare_type": False},
                )
                diff = compare_metadata(context, Base.metadata)
        finally:
            engine.dispose()

    assert diff == [], f"models and migrations have drifted: {diff}"


def test_there_is_exactly_one_migration_head():
    """Two heads mean two people added a migration and neither merged."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    heads = ScriptDirectory.from_config(Config("alembic.ini")).get_heads()
    assert len(heads) == 1, f"expected one head, found {heads}"


def test_the_built_frontend_is_served_at_the_root(client):
    """One origin in production: the API serves the app it is the backend for.

    Skipped rather than passed when the app has not been built, because a check
    that quietly stops checking is worse than one that says it did not run.
    """
    import pytest

    from app.core.config import settings

    if not (settings.frontend_dist / "index.html").is_file():
        pytest.skip("frontend/dist is absent -- run npm run build to exercise this")

    root = client.get("/")
    assert root.status_code == 200
    assert root.headers["content-type"].startswith("text/html")

    # A client-side route must survive a reload: the router is in the browser,
    # so the server answers with the app rather than a 404.
    deep = client.get("/workbench")
    assert deep.status_code == 200
    assert deep.headers["content-type"].startswith("text/html")


def test_serving_the_frontend_never_shadows_the_api(client):
    """A mistyped endpoint must not answer with a page of HTML."""
    for path in ("/api/v1/does-not-exist", "/internal/does-not-exist"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json()["error"]["code"] == "not_found"

    # A route that is deliberately switched off must keep saying not found
    # rather than being answered by the app. The API docs are the case that
    # matters: they are off in production.
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404, path

    assert client.get("/health").json() == {"status": "ok"}
