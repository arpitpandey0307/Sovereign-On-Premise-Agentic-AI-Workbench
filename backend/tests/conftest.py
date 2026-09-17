"""Test fixtures.

Each test module gets a throwaway SQLite file and a fresh storage root, so
runs never share state and never touch the developer's working database.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from uuid import uuid4

import pytest

_tmp = Path(tempfile.mkdtemp(prefix="workbench-tests-"))

# Settings are read at import time, so the environment must be set before any
# application module is imported.
os.environ["DATABASE_URL"] = f"sqlite:///{(_tmp / 'test.db').as_posix()}"
os.environ["STORAGE_ROOT"] = (_tmp / "storage").as_posix()
os.environ["JWT_SECRET_KEY"] = "test-secret-" + "x" * 40
os.environ["SEED_DEMO_USER"] = "false"
os.environ["REFRESH_MODEL_REGISTRY_ON_STARTUP"] = "false"
# Pointed at a port nothing serves, for the same reason NEO4J_PASSWORD is
# pinned empty below. Disabling the startup refresh is not enough on its own:
# an admin test calls /internal/models/refresh, which reconciles against
# whatever the local daemon has pulled, and the registry is shared by the
# whole session. On a machine holding the catalogue models the reranker then
# made a real generation call and returned "model_scored" where the test
# expects "lexical" -- passing or failing on how the live model happened to
# answer. Tests that need a model supply a fake one.
os.environ["OLLAMA_BASE_URL"] = "http://127.0.0.1:11435"
# Pinned rather than inherited: a developer enabling docs locally must not
# change what the suite exercises.
os.environ["ENABLE_API_DOCS"] = "false"
# Pinned empty so the graph client refuses to connect. Otherwise the suite
# passes or fails depending on whether a Neo4j container happens to be running
# on the developer's machine, which it did once. These tests cover the
# relational fallback path; the graph path is verified against a live server
# by scripts/verify_neo4j.py.
os.environ["NEO4J_PASSWORD"] = ""
# The egress monitor installs a CPython audit hook, which cannot be
# removed once added and fires on every socket operation for the rest of
# the process. Off here; its behaviour is tested directly instead.
os.environ["MONITOR_NETWORK_EGRESS"] = "false"

from fastapi.testclient import TestClient

from app.db.database import Base, SessionLocal, engine
from app.db.repositories.users import UserRepository
from app.main import app
from app.security import port as security_port

# The real policy engine, exactly as main.py's lifespan installs it. The port
# registry is process-wide, and without this the placeholder that denies
# everything is still in place for any test that never opens a TestClient --
# so the routing tests passed only when an API test happened to run first and
# swap it in. Installing here makes every module match production wiring
# whether it is run alone or with the rest of the suite. Network monitoring
# stays off for the reason given above.
security_port.install(monitor_network=False)


@pytest.fixture
def anyio_backend():
    """Async tests run on asyncio only; trio is not a dependency here."""
    return "asyncio"


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def db():
    with SessionLocal() as session:
        yield session


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def make_user(db):
    def _make(roles: list[str] | None = None, password: str = "correct-horse"):
        # Unique per call so tests sharing the session database never collide.
        handle = uuid4().hex[:8]
        repo = UserRepository(db)
        repo.seed_roles()
        user = repo.create(
            email=f"engineer-{handle}@mrpl.local",
            name=f"Engineer {handle}",
            password=password,
            roles=roles or ["ENGINEER"],
        )
        return user, password

    return _make


@pytest.fixture
def auth_headers(client, make_user):
    user, password = make_user()
    response = client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": password}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest.fixture
def admin_headers(client, make_user):
    """A caller who holds the oversight permissions.

    The knowledge base -- corpus-wide search and the equipment graph -- is
    restricted to ADMIN and SECURITY_ADMIN, so the tests that exercise it as a
    surface sign in as an administrator. A worker reaching it through an
    approved access request is covered separately.
    """
    user, password = make_user(roles=["ADMIN"])
    response = client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": password}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}
