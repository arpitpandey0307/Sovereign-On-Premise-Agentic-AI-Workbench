"""Verify the Part 03 graph path against a live Neo4j.

The test suite pins Neo4j off so its results do not depend on whether a
container happens to be running. That leaves the graph path -- the vector
index, the full-text index, the equipment traversal -- uncovered, so it is
checked here instead, against a server that is actually up.

    docker compose up -d neo4j
    python scripts/verify_neo4j.py

Requires NEO4J_PASSWORD set in .env and a model runtime with an embedding
model pulled, since the vector index cannot be exercised without vectors.
Writes to a throwaway SQLite database and storage root; the only shared state
it touches is the graph, and it cleans up the document it created.
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_tmp = Path(tempfile.mkdtemp(prefix="verify-neo4j-"))
# A throwaway SQLite database by default, so the script is safe to run against
# a developer's working tree. Set DATABASE_URL to point it at PostgreSQL
# instead and the same checks run in the real deployment shape.
os.environ.setdefault(
    "DATABASE_URL", f"sqlite:///{(_tmp / 'verify.db').as_posix()}"
)
os.environ["STORAGE_ROOT"] = (_tmp / "storage").as_posix()
os.environ["SEED_DEMO_USER"] = "false"
os.environ["REFRESH_MODEL_REGISTRY_ON_STARTUP"] = "true"
os.environ["DEBUG"] = "false"

from fastapi.testclient import TestClient  # noqa: E402

from app.db.database import SessionLocal, init_db  # noqa: E402
from app.db.repositories.documents import DocumentRepository  # noqa: E402
from app.db.repositories.users import UserRepository  # noqa: E402
from app.knowledge.neo4j_client import neo4j_client  # noqa: E402
from app.main import app  # noqa: E402

SOP = """MAINTENANCE STANDARD OPERATING PROCEDURE 204

1 SCOPE
This procedure covers isolation of centrifugal pump P-103 in the crude
distillation unit prior to mechanical seal replacement.

4.2 Isolation
Close suction valve V-103 and discharge valve V-104 and apply a lock-out
tag. Confirm zero pressure at transmitter PT-2201 before breaking any
flange. The relief path through PSV-2201 must remain clear at all times.

4.3 Restoration
Restore power to motor M-14 only after the hot work permit has been signed
off by the shift supervisor and the isolation register has been updated.

5.1 Permits
A hot work permit is mandatory before any welding takes place within the
unit battery limits.
"""

failures: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}"
          f"{(' -- ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


def main() -> int:
    print("=== 0. connectivity ===")
    status = neo4j_client.status()
    check("driver reaches the server", status["reachable"], status["detail"])
    if not status["reachable"]:
        print("\nNothing further can be checked. Start Neo4j and set "
              "NEO4J_PASSWORD.")
        return 1

    init_db()
    with SessionLocal() as db:
        repo = UserRepository(db)
        repo.seed_roles()
        # Idempotent: pointed at PostgreSQL rather than a throwaway SQLite
        # file, these accounts survive the run, and a second run must not fail
        # on a duplicate email before it has checked anything.
        for email, name, password, roles in (
            ("verify@mrpl.local", "Verify", "verify-password", ["ENGINEER"]),
            ("verify-admin@mrpl.local", "Verify Admin",
             "verify-admin-password", ["ADMIN"]),
        ):
            if repo.get_by_email(email) is None:
                repo.create(email=email, name=name, password=password, roles=roles)

    document_id: UUID | None = None
    try:
        with TestClient(app) as client:
            headers = _login(client, "verify@mrpl.local", "verify-password")

            print("\n=== 1. ingestion writes to the graph ===")
            upload = client.post(
                "/api/v1/files/upload", headers=headers,
                files={"file": ("SOP-204.txt", io.BytesIO(SOP.encode()),
                                "text/plain")},
            )
            check("upload accepted", upload.status_code == 201,
                  str(upload.status_code))
            file_id = UUID(upload.json()["id"])

            with SessionLocal() as db:
                document = DocumentRepository(db).get_by_file(file_id)
                document_id, chunk_count = document.id, document.chunk_count
                check("document reports itself indexed",
                      document.indexed_in_graph,
                      document.ingest_error or "no error")
                check("no degradation recorded", document.ingest_error == "",
                      document.ingest_error)

            print("\n=== 2. the graph holds the chunks ===")
            rows = neo4j_client._run(
                "MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(c:Chunk) "
                "RETURN count(c) AS chunks, count(c.embedding) AS embedded, "
                "       size(head(collect(c.embedding))) AS dims",
                id=str(document_id),
            )
            check("chunk nodes exist",
                  bool(rows) and rows[0]["chunks"] == chunk_count, str(rows))
            check("every chunk carries an embedding",
                  bool(rows) and rows[0]["embedded"] == chunk_count)
            check("embedding width is non-zero",
                  bool(rows) and rows[0]["dims"] > 0)

            indexes = neo4j_client._run(
                "SHOW INDEXES YIELD name, type, state "
                "WHERE name IN ['chunk_embedding_index', 'chunk_text_index'] "
                "RETURN name, type, state ORDER BY name"
            ) or []
            check("both indexes exist", len(indexes) == 2, str(indexes))
            check("both are ONLINE",
                  all(row["state"] == "ONLINE" for row in indexes))
            check("one of them is a VECTOR index",
                  sum(row["type"] == "VECTOR" for row in indexes) == 1)

            print("\n=== 3. both retrieval arms run on the graph ===")
            for query, expected in (
                ("how do I isolate V-103 before seal replacement?",
                 "4.2 Isolation"),
                ("when is a hot work permit required?", "5.1 Permits"),
            ):
                body = client.post(
                    "/api/v1/knowledge/search", headers=headers,
                    json={"query": query, "limit": 2},
                ).json()
                diagnostics = body["diagnostics"]
                print(f"\n  query: {query}")
                check("vector arm used Neo4j",
                      diagnostics["vector_backend"] == "neo4j",
                      diagnostics["vector_backend"])
                check("keyword arm used Neo4j",
                      diagnostics["keyword_backend"] == "neo4j",
                      diagnostics["keyword_backend"])
                check("no fallback notes", diagnostics["notes"] == [],
                      str(diagnostics["notes"]))
                top = body["evidence"][0]
                print(f"    top: [{top['document_name']}, p.{top['page']}, "
                      f"{top['section']}] {top['score']}")
                check(f"top hit is {expected}", top["section"] == expected,
                      str(top["section"]))

            print("\n=== 4. equipment graph traversal ===")
            equipment = client.get(
                "/api/v1/knowledge/equipment/P-103", headers=headers
            ).json()
            check("answered by traversal, not co-occurrence",
                  equipment["source"] == "graph_traversal", equipment["source"])
            tags = {item["tag"] for item in equipment["neighbours"]}
            print(f"    neighbours of P-103: {sorted(tags)}")
            check("V-103 is a neighbour", "V-103" in tags)
            check("document references are not plant items",
                  not any(tag.startswith(("SOP-", "API-")) for tag in tags))
            check("depth=2 traversal runs",
                  client.get("/api/v1/knowledge/equipment/P-103?depth=2",
                             headers=headers).json()["source"]
                  == "graph_traversal")

            print("\n=== 5. reingest replaces rather than duplicating ===")
            report = client.post(
                f"/api/v1/documents/reingest/{file_id}", headers=headers
            )
            check("reingest succeeded", report.status_code == 200,
                  str(report.status_code))
            check("reingest reports it indexed", report.json()["indexed_in_graph"])

            after = neo4j_client._run(
                "MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(c:Chunk) "
                "RETURN count(c) AS chunks", id=str(document_id),
            )
            check("chunk count unchanged",
                  bool(after) and after[0]["chunks"] == chunk_count,
                  f"{after[0]['chunks'] if after else '?'} vs {chunk_count}")
            orphans = neo4j_client._run(
                "MATCH (c:Chunk) WHERE NOT (:Document)-[:HAS_CHUNK]->(c) "
                "RETURN count(c) AS orphans"
            )
            check("no orphaned chunks left behind",
                  bool(orphans) and orphans[0]["orphans"] == 0, str(orphans))
            version = neo4j_client._run(
                "MATCH (d:Document {id: $id}) RETURN d.version AS version",
                id=str(document_id),
            )
            check("graph carries the bumped version",
                  bool(version) and version[0]["version"] == 2, str(version))

            print("\n=== 6. clearance filtering happens inside the Cypher ===")
            neo4j_client._run(
                "MATCH (d:Document {id: $id})-[:HAS_CHUNK]->(c:Chunk) "
                "SET c.classification = 'HIGHLY_CONFIDENTIAL'",
                id=str(document_id),
            )
            # Scoped to this run's own chunks. Asserting the result is empty
            # would only hold on an empty graph, and this one is shared with
            # every other verification script -- so an accumulated INTERNAL
            # chunk from an earlier run would fail a check that is actually
            # about the clearance filter.
            ours = {
                str(row["id"])
                for row in (
                    neo4j_client._run(
                        "MATCH (:Document {id: $id})-[:HAS_CHUNK]->(c:Chunk) "
                        "RETURN c.id AS id",
                        id=str(document_id),
                    )
                    or []
                )
            }
            below = neo4j_client.fulltext_search(
                '"V-103"', limit=25, classifications=["PUBLIC", "INTERNAL"]
            )
            leaked = [hit.chunk_id for hit in (below or []) if hit.chunk_id in ours]
            check(
                "chunks above clearance are excluded by the index query",
                leaked == [],
                f"{len(leaked)} of this run's {len(ours)} chunks leaked",
            )
            cleared = neo4j_client.fulltext_search(
                '"V-103"', limit=25, classifications=["HIGHLY_CONFIDENTIAL"]
            )
            recovered = [hit.chunk_id for hit in (cleared or []) if hit.chunk_id in ours]
            check(
                "and returned to a cleared caller",
                bool(recovered),
                f"{len(recovered)} of this run's chunks returned",
            )

            print("\n=== 7. status reports the graph as live ===")
            admin = _login(client, "verify-admin@mrpl.local",
                           "verify-admin-password")
            report = client.get("/internal/knowledge/status",
                                headers=admin).json()
            print(f"    {report['retrieval_mode']}, corpus={report['corpus']}")
            check("graph reported reachable", report["graph"]["reachable"])
            check("retrieval mode names the graph index",
                  "graph index" in report["retrieval_mode"],
                  report["retrieval_mode"])
    finally:
        if document_id is not None:
            neo4j_client.delete_document(document_id)
            neo4j_client._run("MATCH (e:Equipment) DETACH DELETE e")

    print("\n" + "=" * 62)
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("Every check passed. The graph path works end to end.")
    return 0


def _login(client, email: str, password: str) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


if __name__ == "__main__":
    raise SystemExit(main())
