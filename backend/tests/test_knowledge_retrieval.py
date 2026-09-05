"""Part 03: hybrid retrieval, fusion, clearance filtering and the evidence API."""

from __future__ import annotations

import io
from uuid import UUID, uuid4

import pytest

from app.db.models import Document, DocumentChunk, DocumentEntity
from app.knowledge import retrieval
from app.knowledge.embeddings import cosine
from app.knowledge.reranker import Candidate, query_tags, query_terms, rerank
from app.knowledge.service import knowledge_service

ALL_LEVELS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_CONFIDENTIAL"]


@pytest.fixture
def corpus(db, make_user):
    """A small, deterministic corpus written straight to the store.

    Written directly rather than through ingestion so the retrieval tests
    exercise search alone, and so a chunk's classification can be set to
    something the ingesting user could not otherwise produce.
    """
    user, _ = make_user()
    document = Document(
        id=uuid4(),
        file_id=uuid4(),
        owner_id=user.id,
        filename="Maintenance SOP.pdf",
        mime_type="application/pdf",
        checksum="0" * 64,
        storage_path="unused",
        classification="INTERNAL",
        kind="pdf_text",
        status="active",
    )
    secret = Document(
        id=uuid4(),
        file_id=uuid4(),
        owner_id=user.id,
        filename="Board Review.pdf",
        mime_type="application/pdf",
        checksum="1" * 64,
        storage_path="unused",
        classification="HIGHLY_CONFIDENTIAL",
        kind="pdf_text",
        status="active",
    )
    superseded = Document(
        id=uuid4(),
        file_id=uuid4(),
        owner_id=user.id,
        filename="Old SOP.pdf",
        mime_type="application/pdf",
        checksum="2" * 64,
        storage_path="unused",
        classification="INTERNAL",
        kind="pdf_text",
        status="superseded",
    )
    db.add_all([document, secret, superseded])
    db.flush()

    db.add_all(
        [
            DocumentChunk(
                document_id=document.id,
                ordinal=0,
                page=7,
                section="4.2 Isolation",
                text="Close valve V-103 and lock it out before breaking the flange.",
                classification="INTERNAL",
                char_count=60,
            ),
            DocumentChunk(
                document_id=document.id,
                ordinal=1,
                page=8,
                section="4.3 Restoration",
                text="Valve V-104 serves the standby train and is isolated separately.",
                classification="INTERNAL",
                char_count=63,
            ),
            DocumentChunk(
                document_id=document.id,
                ordinal=2,
                page=9,
                section="5.1 Permits",
                text="A hot work permit is required before any welding takes place.",
                classification="INTERNAL",
                char_count=60,
            ),
            DocumentChunk(
                document_id=secret.id,
                ordinal=0,
                page=1,
                section=None,
                text="Valve V-103 replacement is deferred pending board approval.",
                classification="HIGHLY_CONFIDENTIAL",
                char_count=58,
            ),
            DocumentChunk(
                document_id=superseded.id,
                ordinal=0,
                page=1,
                section=None,
                text="Valve V-103 may be opened without a permit.",
                classification="INTERNAL",
                char_count=42,
            ),
        ]
    )
    db.add_all(
        [
            DocumentEntity(
                document_id=document.id, tag="V-103", entity_type="valve", page=7
            ),
            DocumentEntity(
                document_id=document.id, tag="P-103", entity_type="pump", page=7
            ),
        ]
    )
    db.commit()
    return {
        "user": user,
        "document": document,
        "secret": secret,
        "superseded": superseded,
        "ids": [document.id, secret.id, superseded.id],
    }


def _search(db, corpus, query, classifications, limit=5):
    """Search restricted to this fixture's documents.

    The suite shares one database across the session, so uploads made by other
    test modules are otherwise visible here and would make these assertions
    depend on test ordering.
    """
    return retrieval.search(
        db,
        query,
        classifications=classifications,
        limit=limit,
        document_ids=corpus["ids"],
    )


# --- fusion and reranking -------------------------------------------------


def test_fusion_rewards_a_chunk_both_arms_found():
    fused = retrieval._reciprocal_rank_fusion([["a", "b", "c"], ["c", "d", "a"]])
    ordered = list(fused)
    # "a" is 1st and 3rd; "c" is 3rd and 1st -- both beat anything seen once.
    assert set(ordered[:2]) == {"a", "c"}
    assert fused["a"] > fused["b"]


def test_fusion_of_nothing_is_nothing():
    assert retrieval._reciprocal_rank_fusion([[], []]) == {}


def test_query_parsing_separates_identifiers_from_terms():
    assert query_tags("what feeds V-103 and P-12?") == {"V-103", "P-12"}
    terms = query_terms("what feeds V-103 and P-12?")
    assert "feeds" in terms
    assert "what" not in terms  # stopword


def test_rerank_breaks_the_v103_v104_tie():
    """The failure this reranker exists to fix.

    V-103 and V-104 embed almost identically, so fusion alone can rank the
    wrong vessel first. An exact identifier match has to win.
    """
    candidates = [
        Candidate("wrong", "Valve V-104 serves the standby train.", 0.016),
        Candidate("right", "Close valve V-103 and lock it out.", 0.015),
    ]
    ordered = rerank("how do I isolate V-103?", candidates)
    assert ordered[0][0] == "right"


def test_rerank_is_stable_when_no_identifier_is_named():
    candidates = [
        Candidate("first", "A hot work permit is required.", 0.02),
        Candidate("second", "Close the valve.", 0.01),
    ]
    ordered = rerank("permit", candidates)
    assert ordered[0][0] == "first"


def test_cosine_handles_degenerate_vectors():
    assert cosine([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)
    assert cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)
    assert cosine([], [1.0]) == 0.0
    assert cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


# --- retrieval ------------------------------------------------------------


def test_exact_identifier_search_finds_the_right_valve(db, corpus):
    result = _search(db, corpus, "how do I isolate V-103?", ["INTERNAL"], limit=3)
    assert result.evidence
    top = result.evidence[0]
    assert "V-103" in top.text
    assert top.page == 7
    assert top.section == "4.2 Isolation"
    assert top.document_name == "Maintenance SOP.pdf"


def test_evidence_carries_everything_a_citation_needs(db, corpus):
    top = _search(db, corpus, "isolate V-103", ["INTERNAL"], limit=1).evidence[0]
    # The Evidence contract from schemas/shared.py, in full.
    assert top.document_id == corpus["document"].id
    assert top.page > 0
    assert top.text
    assert top.score > 0


def test_retrieval_never_returns_above_the_callers_clearance(db, corpus):
    result = _search(
        db, corpus, "V-103 board approval", ["PUBLIC", "INTERNAL"], limit=10
    )
    assert result.evidence
    assert all(item.document_id != corpus["secret"].id for item in result.evidence)

    cleared = _search(db, corpus, "V-103 board approval", ALL_LEVELS, limit=10)
    assert any(item.document_id == corpus["secret"].id for item in cleared.evidence)


def test_superseded_documents_are_not_cited(db, corpus):
    result = _search(db, corpus, "V-103 permit", ALL_LEVELS, limit=10)
    assert result.evidence
    assert all(item.document_name != "Old SOP.pdf" for item in result.evidence)


def test_no_clearance_means_no_results(db, corpus):
    result = _search(db, corpus, "V-103", [], limit=5)
    assert result.evidence == []


def test_search_can_be_scoped_to_one_document(db, corpus):
    result = retrieval.search(
        db,
        "V-103",
        classifications=ALL_LEVELS,
        limit=10,
        document_ids=[corpus["secret"].id],
    )
    assert result.evidence
    assert {item.document_id for item in result.evidence} == {corpus["secret"].id}


def test_diagnostics_explain_the_degraded_path(db, corpus):
    result = _search(db, corpus, "V-103", ["INTERNAL"], limit=3)
    diagnostics = result.diagnostics.as_dict()
    # No model runtime in the suite, so the semantic arm is honestly absent
    # and the keyword arm carries the search.
    assert diagnostics["vector_backend"] == "unavailable"
    assert diagnostics["keyword_backend"] == "local_scan"
    assert diagnostics["chunks_considered"] >= 3
    assert any("semantic search skipped" in note for note in diagnostics["notes"])


def test_empty_query_returns_nothing(db, corpus):
    assert _search(db, corpus, "   ", ALL_LEVELS).evidence == []


# --- clearance resolution -------------------------------------------------


def test_clearance_is_resolved_from_roles_not_supplied_by_the_caller():
    assert knowledge_service.readable_classifications(["ENGINEER"]) == [
        "PUBLIC",
        "INTERNAL",
        "CONFIDENTIAL",
    ]
    assert "HIGHLY_CONFIDENTIAL" in knowledge_service.readable_classifications(
        ["MANAGER"]
    )


def test_unknown_or_absent_roles_read_nothing():
    assert knowledge_service.readable_classifications([]) == []
    assert knowledge_service.readable_classifications(["INTERN"]) == []


# --- the HTTP surface -----------------------------------------------------


def test_search_endpoint_returns_evidence_and_diagnostics(client, auth_headers):
    client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={
            "file": (
                "sop.txt",
                io.BytesIO(b"4.2 Isolation\nClose valve V-103 and lock it out."),
                "text/plain",
            )
        },
    )

    response = client.post(
        "/api/v1/knowledge/search",
        headers=auth_headers,
        json={"query": "how do I isolate V-103?", "limit": 3},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["query"] == "how do I isolate V-103?"
    assert body["evidence"]
    top = body["evidence"][0]
    assert set(top) == {
        "document_id",
        "document_name",
        "page",
        "section",
        "text",
        "score",
    }
    assert "V-103" in top["text"]
    assert body["diagnostics"]["classifications_allowed"]


def test_search_requires_authentication(client):
    response = client.post("/api/v1/knowledge/search", json={"query": "V-103"})
    assert response.status_code == 401


def test_documents_are_not_visible_to_another_user(client, auth_headers, make_user):
    upload = client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={"file": ("mine.txt", io.BytesIO(b"Valve V-103 notes."), "text/plain")},
    )
    assert upload.status_code == 201

    other, password = make_user()
    token = client.post(
        "/api/v1/auth/login", json={"email": other.email, "password": password}
    ).json()["access_token"]
    other_headers = {"Authorization": f"Bearer {token}"}

    listed = client.get("/api/v1/documents", headers=other_headers)
    assert listed.status_code == 200
    assert listed.json()["items"] == []


def test_reading_another_users_document_reports_not_found(
    client, auth_headers, make_user, db
):
    from app.db.repositories.documents import DocumentRepository

    upload = client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={"file": ("mine.txt", io.BytesIO(b"Valve V-103 notes."), "text/plain")},
    )
    document = DocumentRepository(db).get_by_file(UUID(upload.json()["id"]))

    other, password = make_user()
    token = client.post(
        "/api/v1/auth/login", json={"email": other.email, "password": password}
    ).json()["access_token"]

    response = client.get(
        f"/api/v1/documents/{document.id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    # Not 403: confirming the document exists would itself be a disclosure.
    assert response.status_code == 404


def test_equipment_endpoint_answers_from_the_relational_fallback(
    client, auth_headers, db, corpus
):
    response = client.get(
        "/api/v1/knowledge/equipment/v-103", headers=auth_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["tag"] == "V-103"
    # Neo4j is not running in the suite, so the answer is labelled with how it
    # was actually obtained rather than pretending to be a graph traversal.
    assert body["source"] == "page_co_occurrence"


def test_knowledge_status_is_admin_only(client, auth_headers, make_user):
    denied = client.get("/internal/knowledge/status", headers=auth_headers)
    assert denied.status_code == 403

    admin, password = make_user(roles=["ADMIN"])
    token = client.post(
        "/api/v1/auth/login", json={"email": admin.email, "password": password}
    ).json()["access_token"]

    response = client.get(
        "/internal/knowledge/status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["graph"]["reachable"] is False
    assert "corpus" in body


def test_knowledge_status_is_not_published_in_the_schema(client):
    assert client.get("/openapi.json").status_code == 404


# --- the graph client -----------------------------------------------------


def test_cypher_parameters_named_query_do_not_collide_with_the_driver():
    """A Cypher parameter called "query" must not bind to the driver's own arg.

    It did. ``Session.run`` is ``run(query, parameters=None, **kw)``, so
    forwarding parameters as ``**kwargs`` made every full-text search raise
    TypeError, which the absent-tolerant wrapper reported as the graph being
    unreachable. The keyword arm silently used the local scan instead, and
    nothing looked broken because the fallback still answered.
    """
    from app.knowledge.neo4j_client import Neo4jClient

    captured: dict = {}

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def run(self, query, parameters=None, **kwargs):
            captured["cypher"] = query
            captured["parameters"] = parameters
            captured["kwargs"] = kwargs
            return []

    class FakeDriver:
        def session(self, **kwargs):
            return FakeSession()

    client = Neo4jClient()
    client._driver = FakeDriver()

    assert client._run("RETURN $query", query="V-103", limit=5) == []
    assert captured["cypher"] == "RETURN $query"
    assert captured["parameters"] == {"query": "V-103", "limit": 5}
    assert captured["kwargs"] == {}


def test_a_reachable_graph_whose_query_fails_is_not_reported_as_unreachable(
    db, corpus, monkeypatch
):
    """The two are different problems and must read differently.

    An unreachable graph is an environment the operator fixes. A reachable
    graph whose query fails is a bug -- and if both produce the same note, the
    bug stays hidden behind a working fallback.
    """
    from app.knowledge import retrieval as retrieval_module

    monkeypatch.setattr(
        retrieval_module.neo4j_client,
        "status",
        lambda: {"reachable": True, "detail": "SyntaxError: bad Cypher"},
    )
    monkeypatch.setattr(
        retrieval_module.neo4j_client,
        "fulltext_search",
        lambda *args, **kwargs: None,
    )

    result = _search(db, corpus, "V-103", ["INTERNAL"], limit=3)
    notes = " ".join(result.diagnostics.notes)
    assert "reachable but its query failed" in notes
    # The search still answers -- the fallback is doing its job.
    assert result.evidence
