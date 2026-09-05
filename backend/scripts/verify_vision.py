"""Verify the vision pass against a live vision model.

The test suite runs with an empty model registry, so every model-backed path
resolves to its fallback there. That is the right default for a suite, but it
leaves the thing the vision pass exists for -- a model actually reading a
drawing -- unproven. This script proves it, on a synthetic P&ID whose correct
answer is known in advance.

    ollama pull gemma3:4b
    python scripts/verify_vision.py

Writes to a throwaway SQLite database and storage root unless DATABASE_URL is
set. The drawing is generated here rather than committed so the check does not
depend on a binary fixture.
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp(prefix="verify-vision-"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(_tmp / 'vision.db').as_posix()}")
os.environ["STORAGE_ROOT"] = (_tmp / "storage").as_posix()
os.environ["SEED_DEMO_USER"] = "false"
os.environ["REFRESH_MODEL_REGISTRY_ON_STARTUP"] = "true"
os.environ["DEBUG"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.db.database import SessionLocal, init_db  # noqa: E402
from app.db.repositories.documents import DocumentRepository  # noqa: E402
from app.db.repositories.users import UserRepository  # noqa: E402
from app.main import app  # noqa: E402
from app.models.registry import ModelRegistry  # noqa: E402
from app.models.service import model_service  # noqa: E402

# What the generated drawing actually contains. The check is that the model
# reads these off the image, not that it produces any particular prose.
EXPECTED_TAGS = ["P-103", "V-103", "V-104", "T-101", "PSV-2201"]

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}"
          f"{(' -- ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def build_drawing() -> bytes:
    """A crude P&ID: three vessels, a pump, a relief valve, and flow lines."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1000, 620), "white")
    draw = ImageDraw.Draw(image)

    boxes = {
        "T-101": (60, 200, 220, 340),
        "P-103": (360, 240, 470, 320),
        "V-103": (600, 250, 680, 310),
        "V-104": (600, 400, 680, 460),
        "PSV-2201": (790, 120, 930, 190),
    }
    for label, (x0, y0, x1, y1) in boxes.items():
        draw.rectangle((x0, y0, x1, y1), outline="black", width=3)
        draw.text((x0 + 8, y0 - 18), label, fill="black")

    # Flow lines: T-101 -> P-103 -> V-103, and a branch to V-104.
    draw.line((220, 270, 360, 270), fill="black", width=3)
    draw.line((470, 280, 600, 280), fill="black", width=3)
    draw.line((540, 280, 540, 430), fill="black", width=3)
    draw.line((540, 430, 600, 430), fill="black", width=3)
    draw.line((680, 280, 860, 280), fill="black", width=3)
    draw.line((860, 280, 860, 190), fill="black", width=3)

    draw.text((60, 40), "PIPING AND INSTRUMENTATION DIAGRAM", fill="black")
    draw.text((60, 60), "CRUDE DISTILLATION UNIT - SHEET 1 OF 1", fill="black")
    draw.text((60, 560), "DRAWING No. PID-4471   REV 2", fill="black")

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def main() -> int:
    print("=== 0. a vision model is registered and ready ===")
    init_db()
    with SessionLocal() as db:
        # The app seeds and reconciles the catalogue during startup, which
        # only runs once the TestClient below is entered. This check comes
        # first, so it has to do the reconciliation itself rather than read an
        # empty registry and report a missing model that is actually pulled.
        asyncio.run(model_service.refresh_registry(db))

        vision_models = ModelRegistry(db).of_type("vision")
        for record in vision_models:
            print(f"    {record.model_identifier}: {record.status} "
                  f"({record.status_detail})")
        ready = [record for record in vision_models if record.status == "ready"]
    check("a vision model is ready", bool(ready))
    if not ready:
        print("\nNothing further can be checked. Run: ollama pull gemma3:4b")
        return 1

    with SessionLocal() as db:
        repo = UserRepository(db)
        repo.seed_roles()
        if repo.get_by_email("vision@mrpl.local") is None:
            repo.create(email="vision@mrpl.local", name="Vision",
                        password="vision-password", roles=["ENGINEER"])

    ingested: list = []
    drawing = build_drawing()
    print(f"\n=== 1. ingesting a synthetic P&ID ({len(drawing)} bytes) ===")
    print("    a vision pass on an 8 GB card takes a little while...")

    with TestClient(app) as client:
        token = client.post(
            "/api/v1/auth/login",
            json={"email": "vision@mrpl.local", "password": "vision-password"},
        ).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        upload = client.post(
            "/api/v1/files/upload",
            headers=headers,
            files={"file": ("PID-4471.png", io.BytesIO(drawing), "image/png")},
        )
        check("upload accepted", upload.status_code == 201, str(upload.status_code))
        file_id = UUID(upload.json()["id"])

        with SessionLocal() as db:
            repo = DocumentRepository(db)
            document = repo.get_by_file(file_id)
            check("the drawing ingested", document is not None,
                  "ingestion produced no document")
            if document is None:
                return 1

            pages = repo.pages(document.id)
            page = pages[0]
            print("\n=== 2. the page was looked at, not just OCR'd ===")
            check("the page was flagged for vision", page.needs_vision)
            check("a vision model described it", page.vision_status == "described",
                  f"{page.vision_status}")
            check("the description names the model", bool(page.vision_model),
                  page.vision_model)

            if page.vision_status != "described":
                print(f"\n    ingest_error: {document.ingest_error}")
                return 1

            print("\n--- what the model saw " + "-" * 40)
            for line in page.vision_summary.splitlines():
                print(f"    {line}")
            print("-" * 62)

            print("\n=== 3. the description is kept apart from the page text ===")
            check("vision_summary is populated", bool(page.vision_summary.strip()))
            check(
                "it was not merged into the page's own text",
                page.vision_summary not in page.text,
                "a description must not be quotable as the page's words",
            )

            print("\n=== 4. tags were read off the drawing ===")
            found = {entity.tag for entity in repo.entities(document.id)}
            print(f"    tags extracted: {sorted(found)}")
            hits = [tag for tag in EXPECTED_TAGS if tag in found]
            check(
                f"at least half the drawn tags were recovered "
                f"({len(hits)}/{len(EXPECTED_TAGS)})",
                len(hits) * 2 >= len(EXPECTED_TAGS),
                f"found {sorted(hits)}",
            )

            print("\n=== 5. the drawing became retrievable ===")
            check("chunks were produced from the description",
                  document.chunk_count > 0, f"{document.chunk_count} chunk(s)")
            ingested.append(document.id)

        body = client.post(
            "/api/v1/knowledge/search",
            headers=headers,
            json={"query": "what does pump P-103 feed?", "limit": 3},
        ).json()
        print(f"    rerank: {body['diagnostics']['rerank_method']}, "
              f"vector: {body['diagnostics']['vector_backend']}")
        check("the drawing is retrievable at all", bool(body["evidence"]),
              "a P&ID that OCR alone cannot read is now searchable")
        for item in body["evidence"][:2]:
            snippet = item["text"].replace("\n", " ")[:100]
            print(f"    [p.{item['page']}] {item['score']} :: {snippet}")

    _cleanup_graph(ingested)

    print("\n" + "=" * 62)
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("Every check passed. The vision pass works end to end.")
    return 0


def _cleanup_graph(document_ids: list) -> None:
    """Remove what this run put in the shared graph.

    The relational store is a throwaway file, but Neo4j is shared with every
    other verification script and with the developer's own corpus. A script
    that leaves its documents behind makes the next run's results depend on
    how many times it has been run before.
    """
    from app.knowledge.neo4j_client import neo4j_client

    for document_id in document_ids:
        if document_id is not None:
            neo4j_client.delete_document(document_id)


if __name__ == "__main__":
    raise SystemExit(main())
