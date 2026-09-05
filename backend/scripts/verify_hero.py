"""The hero workflow, end to end, against real models.

    inspection report + maintenance SOP
      -> ingest and index (Part 03)
      -> retrieve supporting passages
      -> a reasoning model compares findings against the SOP (Part 02)
      -> docx.generate builds the approval note (Part 04)
      -> the note is validated against the evidence it cites
      -> events stream the whole way (Part 01)

    python scripts/verify_hero.py

This is the demo path. It needs a reasoning model pulled and enough free VRAM
to load it; everything else degrades, but a note cannot be written without a
model, and this script says so plainly rather than producing an empty one.
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp(prefix="verify-hero-"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(_tmp / 'hero.db').as_posix()}")
os.environ["STORAGE_ROOT"] = (_tmp / "storage").as_posix()
os.environ["SEED_DEMO_USER"] = "false"
os.environ["REFRESH_MODEL_REGISTRY_ON_STARTUP"] = "true"
os.environ["DEBUG"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.db.database import SessionLocal, init_db  # noqa: E402
from app.db.repositories.users import UserRepository  # noqa: E402
from app.main import app  # noqa: E402

SOP = b"""MAINTENANCE STANDARD OPERATING PROCEDURE 204
CENTRIFUGAL PUMP SEAL REPLACEMENT

4.1 Permits
A hot work permit must be signed by the shift supervisor before any welding
or cutting is carried out within the unit battery limits.

4.2 Isolation
Close suction valve V-103 and discharge valve V-104 and apply a lock-out tag
to each. Confirm zero pressure at transmitter PT-2201 before breaking any
flange joint.

4.3 Relief path
The relief path through PSV-2201 must remain clear at all times during the
work. Under no circumstances may PSV-2201 be isolated.

4.4 Restoration
Restore power to motor M-14 only after the isolation register has been signed
off and all locks removed.
"""

INSPECTION = b"""INSPECTION REPORT IR-8891
PUMP P-103 - CRUDE DISTILLATION UNIT

Date of inspection: 14 March
Inspector: J. Rao

Observations:
1. Suction valve V-103 was closed and lock-out tag applied. Verified.
2. Discharge valve V-104 was closed. No lock-out tag was fitted.
3. Pressure at PT-2201 read 0.4 barg at the time the flange was broken.
4. PSV-2201 was found isolated by a closed block valve during the work.
5. Welding was carried out on the discharge spool. The hot work permit was
   signed after the work was completed, not before.
6. Motor M-14 was re-energised before the isolation register was signed.
"""

REQUEST = (
    "Review inspection report IR-8891 against maintenance SOP-204 and write "
    "an approval note. Identify every deviation from the procedure, cite the "
    "SOP clause for each, and recommend what must happen before restart."
)

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}"
          f"{(' -- ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    print("=== 0. a reasoning model is available ===")
    init_db()

    import asyncio

    from app.models.registry import ModelRegistry
    from app.models.service import model_service
    from app.routing.hardware import hardware

    with SessionLocal() as db:
        asyncio.run(model_service.refresh_registry(db))
        reasoners = [
            record
            for record in ModelRegistry(db).of_type("reasoning")
            if record.status == "ready"
        ]
        for record in ModelRegistry(db).of_type("reasoning"):
            print(f"    {record.model_identifier}: {record.status}")

    gpu = hardware.state(refresh=True)
    print(f"    GPU free {gpu.free_vram_gb:.1f} GB, usable {gpu.usable_vram_gb:.1f} GB")
    check("a reasoning model is pulled", bool(reasoners))
    if not reasoners:
        print("\nRun: ollama pull qwen3:8b")
        return 1
    if reasoners[0].effective_vram_gb > gpu.usable_vram_gb:
        print(
            f"\n    NOTE: {reasoners[0].model_identifier} needs "
            f"{reasoners[0].effective_vram_gb} GB but only "
            f"{gpu.usable_vram_gb:.1f} GB is usable. Free VRAM with "
            "`ollama stop <model>` or the router will decline it."
        )

    with SessionLocal() as db:
        repo = UserRepository(db)
        repo.seed_roles()
        if repo.get_by_email("hero@mrpl.local") is None:
            repo.create(email="hero@mrpl.local", name="Hero",
                        password="hero-password", roles=["ENGINEER"])

    with TestClient(app) as client:
        token = client.post(
            "/api/v1/auth/login",
            json={"email": "hero@mrpl.local", "password": "hero-password"},
        ).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        print("\n=== 1. ingest the SOP and the inspection report ===")
        uploads = {}
        for name, body in (("SOP-204.txt", SOP), ("IR-8891.txt", INSPECTION)):
            response = client.post(
                "/api/v1/files/upload",
                headers=headers,
                files={"file": (name, io.BytesIO(body), "text/plain")},
            )
            check(f"{name} uploaded", response.status_code == 201,
                  str(response.status_code))
            uploads[name] = response.json()["id"]

        documents = client.get("/api/v1/documents", headers=headers).json()
        check("both documents indexed", documents["total"] >= 2,
              f"{documents['total']} indexed")

        print("\n=== 2. run the workflow ===")
        created = client.post(
            "/api/v1/tasks",
            headers=headers,
            json={
                "conversation_id": client.post(
                    "/api/v1/conversations", headers=headers,
                    json={"title": "IR-8891 review"},
                ).json()["id"],
                "request_text": REQUEST,
                "task_type": "inspection_review",
                "input_file_ids": [uploads["IR-8891.txt"]],
            },
        )
        check("task accepted", created.status_code == 202, str(created.status_code))
        task_id = created.json()["task_id"]

        print("    reasoning on an 8 GB card takes a while...")
        detail = _wait(client, headers, task_id)
        print(f"    finished as: {detail['status']}")
        if detail["status"] == "failed":
            print(f"    error: {detail['error_message']}")

        print("\n=== 3. the execution trace ===")
        trace = client.get(
            f"/api/v1/tasks/{task_id}/execution", headers=headers
        ).json()
        for entry in trace.get("steps", []):
            mark = "ok " if entry.get("ok", True) else "FAIL"
            extra = {
                key: value
                for key, value in entry.items()
                if key not in {"step", "ok", "at"}
            }
            print(f"    [{mark}] {entry['step']}  {extra if extra else ''}")

        check("the workflow completed", detail["status"] == "completed",
              detail.get("error_message") or "")
        check("a model was selected through Part 02", bool(trace.get("models")),
              str(trace.get("models")))
        check("evidence was retrieved and cited", bool(trace.get("sources")),
              f"{len(trace.get('sources') or [])} passage(s)")

        if detail["status"] != "completed":
            return 1

        print("\n=== 4. the deliverable ===")
        artifacts = client.get(
            f"/api/v1/tasks/{task_id}/artifacts", headers=headers
        ).json()
        check("one artifact was produced", len(artifacts) == 1, str(len(artifacts)))
        check("it passed validation",
              artifacts and artifacts[0]["validation_status"] == "passed")

        download = client.get(artifacts[0]["download_url"], headers=headers)
        check("it downloads", download.status_code == 200, str(download.status_code))

        from docx import Document

        document = Document(io.BytesIO(download.content))
        text = "\n".join(paragraph.text for paragraph in document.paragraphs)
        print("\n--- the approval note " + "-" * 40)
        for line in text.splitlines():
            if line.strip():
                print(f"    {line}")
        print("-" * 62)

        check("the note cites SOP-204", "SOP-204" in text, "")
        check("the note is not empty", len(text) > 200, f"{len(text)} chars")

        saved = _tmp / "approval_note.docx"
        saved.write_bytes(download.content)
        print(f"\n    saved to {saved}")

    print("\n" + "=" * 62)
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("The hero workflow works end to end.")
    return 0


def _wait(client, headers, task_id: str, *, timeout_s: float = 900.0) -> dict:
    terminal = {"completed", "failed", "cancelled", "waiting_approval"}
    deadline = time.monotonic() + timeout_s
    seen = ""
    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/tasks/{task_id}", headers=headers).json()
        if detail["status"] != seen:
            seen = detail["status"]
            print(f"    status: {seen}")
        if detail["status"] in terminal:
            return detail
        time.sleep(0.5)
    raise AssertionError("the task never settled")


if __name__ == "__main__":
    raise SystemExit(main())
