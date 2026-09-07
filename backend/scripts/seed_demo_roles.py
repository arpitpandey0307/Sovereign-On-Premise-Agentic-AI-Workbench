"""Create one demo account per role, so the boundaries can actually be seen.

The default seed makes a single account holding both ADMIN and ENGINEER, which
resolves to the highest rank -- so every screen is visible and none of the
role boundaries can be demonstrated. This adds one account per role.

    python scripts/seed_demo_roles.py

Idempotent: an account that already exists is left alone, including its
password. Demo accounts only -- never run this against a real deployment, which
is why every account it makes is obviously named and shares one weak password.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.database import SessionLocal, init_db  # noqa: E402
from app.db.repositories.users import UserRepository  # noqa: E402

PASSWORD = "workbench"

ACCOUNTS: list[tuple[str, str, list[str]]] = [
    ("engineer@mrpl.local", "Ravi Engineer", ["ENGINEER"]),
    ("analyst@mrpl.local", "Priya Analyst", ["ANALYST"]),
    ("manager@mrpl.local", "Suresh Manager", ["MANAGER"]),
    ("security@mrpl.local", "Anita Security", ["SECURITY_ADMIN"]),
]


def main() -> int:
    init_db()
    with SessionLocal() as db:
        users = UserRepository(db)
        users.seed_roles()

        for email, name, roles in ACCOUNTS:
            if users.get_by_email(email) is not None:
                print(f"  = {email:26} already exists")
                continue
            users.create(email=email, name=name, password=PASSWORD, roles=roles)
            print(f"  + {email:26} {', '.join(roles)}")

    print(f"\nPassword for all of the above: {PASSWORD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
