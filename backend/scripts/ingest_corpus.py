"""Upload a folder of documents through the real API and wait for ingestion.

Deliberately goes through `POST /api/v1/files/upload` rather than writing to
the database: uploading is the path an operator uses, so this exercises the
size limit, the media-type allow-list, the classifier and the background
ingestion exactly as they will behave on the day.

    python scripts/ingest_corpus.py "../dataset corpus/_generated"
    python scripts/ingest_corpus.py FILE [FILE ...]

Files the backend would refuse are reported and skipped rather than retried,
and nothing is uploaded twice: a filename already in the corpus is left alone,
so the script can be re-run after adding to the folder.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = "http://127.0.0.1:8000"

# What the backend accepts. Checked here so an unsupported file is named as
# such instead of arriving as a 415 with no context.
ACCEPTED = {
    ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff",
    ".docx", ".xlsx", ".pptx", ".csv", ".txt", ".json",
}


def call(method: str, path: str, token: str | None = None, body: dict | None = None):
    request = urllib.request.Request(BASE + path, method=method)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, data, timeout=120) as response:
        raw = response.read().decode()
        return json.loads(raw) if raw else None


def upload(path: Path, token: str) -> tuple[bool, str]:
    """One multipart upload, built by hand to avoid a requests dependency."""
    boundary = f"----sovereign{uuid.uuid4().hex}"
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    # mimetypes does not know these on every Windows install.
    if path.suffix.lower() == ".csv":
        mime = "text/csv"
    elif path.suffix.lower() == ".txt":
        mime = "text/plain"

    body = b"".join([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{path.name}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        path.read_bytes(),
        f"\r\n--{boundary}--\r\n".encode(),
    ])

    request = urllib.request.Request(f"{BASE}/api/v1/files/upload", method="POST")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(request, body, timeout=600) as response:
            return True, json.loads(response.read().decode())["id"]
    except urllib.error.HTTPError as error:
        detail = error.read().decode()
        try:
            detail = json.loads(detail)["error"]["message"]
        except Exception:
            detail = detail[:120]
        return False, f"{error.code}: {detail}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", help="files, or folders to walk")
    parser.add_argument("--email", default="admin@mrpl.local")
    parser.add_argument("--password", default="workbench")
    parser.add_argument(
        "--wait",
        type=int,
        default=900,
        help="seconds to wait for ingestion to settle",
    )
    args = parser.parse_args()

    files: list[Path] = []
    for raw in args.paths:
        path = Path(raw)
        if path.is_dir():
            files.extend(sorted(p for p in path.iterdir() if p.is_file()))
        elif path.is_file():
            files.append(path)
        else:
            print(f"  ! {raw} does not exist")

    token = call(
        "POST",
        "/api/v1/auth/login",
        body={"email": args.email, "password": args.password},
    )["access_token"]

    existing = {
        document["filename"]
        for document in call("GET", "/api/v1/documents?limit=100", token)["items"]
    }

    uploaded = 0
    for path in files:
        if path.suffix.lower() not in ACCEPTED:
            print(f"  - {path.name:52} skipped (not an accepted type)")
            continue
        if path.name in existing:
            print(f"  = {path.name:52} already in the corpus")
            continue

        size_mb = path.stat().st_size / 1_048_576
        ok, result = upload(path, token)
        if ok:
            uploaded += 1
            print(f"  + {path.name:52} {size_mb:6.1f} MB")
        else:
            print(f"  ! {path.name:52} {result}")

    if uploaded == 0:
        print("\nNothing new to ingest.")
        return 0

    # Ingestion runs in the background after the response. Wait for it rather
    # than reporting a corpus that is still filling in.
    print(f"\nWaiting for ingestion of {uploaded} file(s)…")
    deadline = time.time() + args.wait
    while time.time() < deadline:
        documents = call("GET", "/api/v1/documents?limit=100", token)["items"]
        pending = [d for d in documents if d["chunk_count"] == 0 and not d["ingest_error"]]
        if not pending:
            break
        print(f"    {len(pending)} still processing…", flush=True)
        time.sleep(10)

    documents = call("GET", "/api/v1/documents?limit=100", token)["items"]
    print(f"\n{'FILENAME':46} {'CLASSIFICATION':22} {'PAGES':>5} {'CHUNKS':>7}  GRAPH")
    for document in sorted(documents, key=lambda d: d["filename"]):
        print(
            f"{document['filename'][:45]:46} {document['classification']:22} "
            f"{document['page_count']:>5} {document['chunk_count']:>7}  "
            f"{'yes' if document['indexed_in_graph'] else 'no'}"
            + (f"   ERROR: {document['ingest_error'][:60]}" if document["ingest_error"] else "")
        )

    status = call("GET", "/internal/knowledge/status", token)
    print(f"\nCorpus: {json.dumps(status['corpus'])}")
    print(f"Retrieval: {status['retrieval_mode']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
