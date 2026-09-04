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

from fastapi.testclient import TestClient

from app.db.database import Base, SessionLocal, engine
from app.db.repositories.users import UserRepository
from app.main import app


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
