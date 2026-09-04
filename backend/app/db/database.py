"""Engine, session factory and declarative base.

The URL is configuration, not a hard-coded choice: SQLite keeps the API
runnable with no external services on a dev laptop, while Docker Compose
points the same models at PostgreSQL.
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings

_is_sqlite = settings.database_url.startswith("sqlite")

engine = create_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=not _is_sqlite,
    connect_args={"check_same_thread": False} if _is_sqlite else {},
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a request-scoped session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables for the MVP. Alembic takes over once schemas settle."""
    from app.db import models  # noqa: F401  (registers mappers)

    Base.metadata.create_all(bind=engine)
