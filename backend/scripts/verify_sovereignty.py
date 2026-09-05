"""Verify the sovereignty claim, rather than displaying it.

The problem statement asks for proof "through logs or a visible network
monitor, that no external calls are made at any point". This runs the demo
workflow with the egress monitor active and reports what the monitor actually
observed -- and, crucially, proves the monitor *would* have seen an external
call by deliberately making one and checking it was caught.

That second half is the part that matters. A monitor reporting zero is only
evidence if it can be shown to be watching; otherwise it is indistinguishable
from a monitor that is switched off, which is what a label reading
"100% private" amounts to.

    python scripts/verify_sovereignty.py
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp(prefix="verify-sovereignty-"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(_tmp / 'sov.db').as_posix()}")
os.environ["STORAGE_ROOT"] = (_tmp / "storage").as_posix()
os.environ["SEED_DEMO_USER"] = "false"
os.environ["REFRESH_MODEL_REGISTRY_ON_STARTUP"] = "true"
os.environ["MONITOR_NETWORK_EGRESS"] = "true"
os.environ["DEBUG"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.audit.ledger import audit_ledger  # noqa: E402
from app.db.database import SessionLocal, init_db  # noqa: E402
from app.db.repositories.users import UserRepository  # noqa: E402
from app.main import app  # noqa: E402
from app.security.network import egress_monitor  # noqa: E402

SOP = (
    b"MAINTENANCE SOP-204\n\n"
    b"4.2 Isolation\nClose suction valve V-103 and apply a lock-out tag. "
    b"Confirm zero pressure at PT-2201 before breaking any flange.\n\n"
    b"4.1 Permits\nA hot work permit must be signed before any welding."
)
INSPECTION = (
    b"INSPECTION REPORT IR-8891\nPUMP P-103\n\n"
    b"1. Valve V-103 closed, no lock-out tag fitted.\n"
    b"2. Welding carried out before the permit was signed.\n"
)

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}"
          f"{(' -- ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    init_db()

    print("=== 0. the monitor is actually running ===")
    from app.security import port as security_port

    security_port.install()
    snapshot = egress_monitor.snapshot()
    check("the audit hook is installed", snapshot.monitoring,
          "a monitor that is off proves nothing")
    if not snapshot.monitoring:
        return 1

    with SessionLocal() as db:
        repo = UserRepository(db)
        repo.seed_roles()
        for email, roles in (
            ("sov@mrpl.local", ["ENGINEER"]),
            ("sov-admin@mrpl.local", ["SECURITY_ADMIN"]),
        ):
            if repo.get_by_email(email) is None:
                repo.create(email=email, name="Sov", password="sov-password-1",
                            roles=roles)

    with TestClient(app) as client:
        headers = _login(client, "sov@mrpl.local")
        admin = _login(client, "sov-admin@mrpl.local")

        print("\n=== 1. run real work with the monitor watching ===")
        for name, body in (("SOP-204.txt", SOP), ("IR-8891.txt", INSPECTION)):
            response = client.post(
                "/api/v1/files/upload", headers=headers,
                files={"file": (name, io.BytesIO(body), "text/plain")},
            )
            check(f"{name} ingested", response.status_code == 201)
            uploaded = response.json()["id"]

        conversation = client.post(
            "/api/v1/conversations", headers=headers, json={"title": "sovereignty"}
        ).json()
        created = client.post(
            "/api/v1/tasks", headers=headers,
            json={
                "conversation_id": conversation["id"],
                "request_text": (
                    "Review IR-8891 against SOP-204 and write an approval note "
                    "about valve V-103."
                ),
                "task_type": "inspection_review",
                "input_file_ids": [uploaded],
            },
        )
        check("task accepted", created.status_code == 202)
        task_id = created.json()["task_id"]
        detail = _wait(client, headers, task_id)
        print(f"    workflow finished as: {detail['status']}")

        print("\n=== 2. what the monitor observed ===")
        body = client.get("/api/v1/security/sovereignty", headers=admin).json()
        for key in (
            "external_requests",
            "external_connections",
            "external_dns_queries",
            "local_connections",
            "local_dns_queries",
            "network_egress",
        ):
            print(f"    {key:24} {body[key]}")

        check("no external connections were made",
              body["external_connections"] == 0, str(body["external_connections"]))
        check("no external DNS lookups were made",
              body["external_dns_queries"] == 0, str(body["external_dns_queries"]))
        check("egress reported as blocked", body["network_egress"] == "BLOCKED")
        check(
            "local traffic was seen, so the monitor was not merely idle",
            body["local_connections"] > 0,
            f"{body['local_connections']} local connection(s)",
        )

        print("\n=== 3. the task receipt ===")
        receipt = client.get(
            f"/api/v1/tasks/{task_id}/receipt", headers=headers
        ).json()
        for key in ("events_recorded", "models_used", "tools_used",
                    "documents_consulted", "external_calls", "sovereignty"):
            print(f"    {key:24} {receipt[key]}")
        check("the receipt reports zero external calls",
              receipt["external_calls"] == 0)
        check("the receipt reports sovereignty intact",
              receipt["sovereignty"] == "INTACT")
        check("the receipt is assembled from real events",
              receipt["events_recorded"] > 0, str(receipt["events_recorded"]))

        print("\n=== 4. the monitor would have caught a breach ===")
        print("    deliberately attempting one outbound connection...")
        before = egress_monitor.snapshot().external_connections
        _attempt_external()
        after = egress_monitor.snapshot()

        check(
            "the attempt was detected",
            after.external_connections > before,
            f"{before} -> {after.external_connections}",
        )
        check("it was recorded with its destination",
              bool(after.recent_external),
              str(after.recent_external[-1] if after.recent_external else None))

        recorded = client.get(
            "/api/v1/security/network-events", headers=admin
        ).json()
        check("it reached the ledger", recorded["count"] > 0,
              f"{recorded['count']} event(s)")
        if recorded["external_events"]:
            event = recorded["external_events"][0]
            print(f"    recorded: {event['kind']} {event['host']}:{event['port']}")

        check(
            "and the dashboard now reports the breach rather than hiding it",
            client.get("/api/v1/security/sovereignty", headers=admin).json()[
                "network_egress"
            ]
            == "BREACHED",
        )

        print("\n=== 5. the audit ledger ===")
        events, total = audit_ledger.recent(limit=200)
        kinds = sorted({event.event_type for event in events})
        print(f"    {total} event(s) recorded; types: {', '.join(kinds)}")
        check("the workflow was audited", total > 0)
        check("tool calls were recorded", "TOOL_CALLED" in kinds)
        check("the ledger has no update or delete path",
              not any(
                  hasattr(audit_ledger, name)
                  for name in ("update", "delete", "purge", "clear")
              ))

    print("\n" + "=" * 62)
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print(
        "Sovereignty verified: zero external calls during real work, on a "
        "monitor\nproven to detect one."
    )
    return 0


# The deprecated 6to4 relay anycast range (RFC 7526). Chosen deliberately:
# Python's ipaddress calls it global, so the monitor must treat it as
# external, while the range is effectively unrouted so no live service is
# contacted. The obvious choices do not work -- the RFC 5737 documentation
# ranges (198.51.100.0/24 and friends) are is_private=True in Python, so a
# correct monitor classifies them as local, which is what the first version
# of this check got wrong.
UNROUTED_EXTERNAL = "192.88.99.1"


def _attempt_external() -> None:
    """Make one outbound connection so the monitor has something to catch."""
    import socket

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.4)
    try:
        sock.connect((UNROUTED_EXTERNAL, 80))
    except OSError:
        pass  # the attempt is what the monitor sees; success is irrelevant
    finally:
        sock.close()


def _login(client, email: str) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": "sov-password-1"}
    )
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _wait(client, headers, task_id: str, *, timeout_s: float = 900.0) -> dict:
    terminal = {"completed", "failed", "cancelled", "waiting_approval"}
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/tasks/{task_id}", headers=headers).json()
        if detail["status"] in terminal:
            return detail
        time.sleep(0.5)
    raise AssertionError("the task never settled")


if __name__ == "__main__":
    raise SystemExit(main())
