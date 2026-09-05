"""Verify the MinIO storage backend against a real server.

The compose MinIO sits on an internal network and is deliberately unreachable
from the host -- that is the guarantee, and it means this script cannot use
it. Point it at a reachable MinIO instead:

    docker run -d --name minio-verify -p 127.0.0.1:9010:9000 \\
      -e MINIO_ROOT_USER=verify -e MINIO_ROOT_PASSWORD=verify-secret \\
      minio/minio:RELEASE.2025-04-22T22-12-26Z server /data

    MINIO_ENDPOINT=127.0.0.1:9010 MINIO_ACCESS_KEY=verify \\
      MINIO_SECRET_KEY=verify-secret python scripts/verify_storage.py

    docker rm -f minio-verify

What it checks is the adapter, not the network policy: that bytes survive a
round trip, that a document can still be opened by path once it lives in
object storage, and that the whole ingestion pipeline works with uploads going
to MinIO rather than the filesystem.
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp(prefix="verify-storage-"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{(_tmp / 'st.db').as_posix()}")
os.environ["STORAGE_ROOT"] = (_tmp / "storage").as_posix()
os.environ["STORAGE_BACKEND"] = "minio"
os.environ["SEED_DEMO_USER"] = "false"
os.environ["REFRESH_MODEL_REGISTRY_ON_STARTUP"] = "false"
os.environ["MONITOR_NETWORK_EGRESS"] = "false"
os.environ["DEBUG"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.core.storage import MinioStorage, storage  # noqa: E402
from app.db.database import SessionLocal, init_db  # noqa: E402
from app.db.repositories.documents import DocumentRepository  # noqa: E402
from app.db.repositories.users import UserRepository  # noqa: E402
from app.main import app  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}"
          f"{(' -- ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    print("=== 0. the backend selected is MinIO ===")
    print(f"    endpoint: {os.environ.get('MINIO_ENDPOINT', '(default)')}")
    check(
        "MinIO was selected rather than falling back",
        storage.name == "minio",
        f"active backend is {storage.name!r}; is the server reachable?",
    )
    if storage.name != "minio":
        print("\nStart one, then re-run. See this file's docstring.")
        return 1

    print(f"    bucket: {storage.bucket}")

    print("\n=== 1. bytes survive a round trip ===")
    payload = b"MAINTENANCE SOP-204\nClose valve V-103 and lock it out.\n"
    owner = uuid4()
    key, size, digest = storage.save(
        io.BytesIO(payload), owner_id=owner, filename="sop.txt"
    )
    check("size recorded", size == len(payload), f"{size} vs {len(payload)}")
    check(
        "checksum matches",
        digest == hashlib.sha256(payload).hexdigest(),
        digest[:16],
    )
    check("the object exists", storage.exists(key))
    check("read returns the same bytes", storage.read(key) == payload)
    check("the key is namespaced by owner", key.startswith(f"{owner}/"), key)

    print("\n=== 2. it can still be opened by path ===")
    materialised = storage.local_path(key)
    check(
        "the object materialises to a real file",
        materialised.is_file() and materialised.read_bytes() == payload,
        str(materialised),
    )
    check(
        "a second call reuses the cached file",
        storage.local_path(key) == materialised,
    )

    print("\n=== 3. deletion removes it ===")
    storage.delete(key)
    check("gone from the object store", not storage.exists(key))

    print("\n=== 4. a non-local endpoint is still refused ===")
    try:
        MinioStorage("s3.amazonaws.com:443")
    except ValueError as exc:
        check("remote endpoints rejected", "non-local" in str(exc), str(exc)[:70])
    else:
        check("remote endpoints rejected", False, "a remote endpoint was accepted")

    print("\n=== 5. the whole pipeline runs on object storage ===")
    init_db()
    with SessionLocal() as db:
        repo = UserRepository(db)
        repo.seed_roles()
        if repo.get_by_email("storage@mrpl.local") is None:
            repo.create(email="storage@mrpl.local", name="Storage",
                        password="storage-password", roles=["ENGINEER"])

    with TestClient(app) as client:
        token = client.post(
            "/api/v1/auth/login",
            json={"email": "storage@mrpl.local", "password": "storage-password"},
        ).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        upload = client.post(
            "/api/v1/files/upload",
            headers=headers,
            files={"file": ("SOP-204.txt", io.BytesIO(payload), "text/plain")},
        )
        check("upload accepted", upload.status_code == 201, str(upload.status_code))
        file_id = UUID(upload.json()["id"])

        with SessionLocal() as db:
            document = DocumentRepository(db).get_by_file(file_id)
        check(
            "ingestion read the document back out of object storage",
            document is not None and document.chunk_count > 0,
            f"{document.chunk_count if document else 0} chunk(s)",
        )
        if document:
            check("it was indexed", document.page_count > 0)

        page = client.get(
            f"/api/v1/documents/{document.id}/pages/1", headers=headers
        )
        check(
            "the extracted text is retrievable",
            page.status_code == 200 and "V-103" in page.json()["text"],
        )

        status = client.get("/api/v1/documents", headers=headers)
        check("the document is listed", status.json()["total"] >= 1)

    print("\n" + "=" * 62)
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("MinIO works end to end: uploads, ingestion and retrieval.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
