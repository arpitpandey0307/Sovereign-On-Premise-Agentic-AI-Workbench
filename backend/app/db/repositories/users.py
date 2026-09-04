"""Data access for users and roles."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.db.models import ROLE_NAMES, Role, User


class UserRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, user_id: UUID) -> User | None:
        return self.db.get(User, user_id)

    def get_by_email(self, email: str) -> User | None:
        return self.db.scalar(select(User).where(User.email == email.lower()))

    def create(
        self, *, email: str, name: str, password: str, roles: list[str]
    ) -> User:
        user = User(
            email=email.lower(),
            name=name,
            hashed_password=hash_password(password),
            roles=[self.ensure_role(role) for role in roles],
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def ensure_role(self, name: str) -> Role:
        role = self.db.scalar(select(Role).where(Role.name == name))
        if role is None:
            role = Role(name=name)
            self.db.add(role)
            self.db.flush()
        return role

    def seed_roles(self) -> None:
        for name in ROLE_NAMES:
            self.ensure_role(name)
        self.db.commit()
