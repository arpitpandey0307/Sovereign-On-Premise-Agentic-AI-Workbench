"""The Parts 01-03 gaps closed before Part 04: vision, reranking, vLLM, files.

The suite runs with an empty model registry, so every model-backed path here
resolves to its fallback by default. That is the behaviour that matters most:
these features must degrade cleanly on a machine with no runtime, and the
tests that need a model to be present supply a fake one.
"""

from __future__ import annotations

import io

import pytest

from app.documents import vision
from app.documents.ingestion import VISION_MARKER, _combined
from app.documents.parser import ExtractedPage
from app.knowledge.reranker import Candidate, rerank, rerank_with_model
from app.models.catalog import catalogue_for

# --- the vision pass ------------------------------------------------------


def _page(number: int, *, text: str = "", flagged: bool = True, image=b"png"):
    return ExtractedPage(
        page_number=number,
        text=text,
        ocr_status="native",
        needs_vision=flagged,
        image=image,
    )


def test_only_flagged_pages_with_pixels_are_selected():
    pages = [
        _page(1, flagged=False),
        _page(2, image=None),
        _page(3),
    ]
    assert [page.page_number for page in vision.selected_pages(pages)] == [3]


def test_the_budget_caps_how_many_pages_reach_a_model():
    pages = [_page(number) for number in range(1, 11)]
    assert len(vision.selected_pages(pages, limit=3)) == 3
    # A budget of zero disables the pass outright rather than erroring.
    assert vision.selected_pages(pages, limit=0) == []


def test_the_least_textual_pages_are_described_first():
    """A drawing gains more from being looked at than a page of prose does."""
    pages = [
        _page(1, text="x" * 900),
        _page(2, text=""),
        _page(3, text="x" * 40),
    ]
    chosen = vision.selected_pages(pages, limit=2)
    assert {page.page_number for page in chosen} == {2, 3}
    # Still returned in document order, so the choice is reproducible.
    assert [page.page_number for page in chosen] == [2, 3]


def test_describe_without_a_model_is_unavailable_not_an_error(db):
    result = vision.describe(db, b"fake-png-bytes")
    assert result.status == "unavailable"
    assert result.text == ""
    assert result.detail


def test_describe_refuses_an_empty_image(db):
    result = vision.describe(db, b"")
    assert result.status == "failed"


def test_a_description_is_marked_and_never_merged_into_the_page_text():
    """A model's description must not be quotable as the page's own words."""
    described = vision.VisionResult(
        text="P&ID showing pump P-103 feeding valve V-103.",
        model_id="vision-gemma3-4b-q4",
        status="described",
    )
    combined = _combined("Sheet 3 of 8", described)

    assert VISION_MARKER in combined
    assert combined.startswith("Sheet 3 of 8")
    assert "P-103" in combined
    # An unsuccessful pass adds nothing at all.
    assert _combined("Sheet 3 of 8", vision.VisionResult()) == "Sheet 3 of 8"


def test_ingestion_records_that_vision_was_unavailable(client, auth_headers, db):
    """A flagged page with no vision model still ingests, and says why."""
    from uuid import UUID

    from app.db.repositories.documents import DocumentRepository

    png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00"
        b"\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    upload = client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={"file": ("drawing.png", io.BytesIO(png), "image/png")},
    )
    assert upload.status_code == 201

    document = DocumentRepository(db).get_by_file(UUID(upload.json()["id"]))
    # An image is always flagged for vision, and an image with no readable
    # text yields no chunks -- but the failure is recorded, not raised.
    assert document is None or "vision pass skipped" in document.ingest_error


# --- reranking ------------------------------------------------------------


def test_reranking_falls_back_to_lexical_with_no_model(db):
    candidates = [
        Candidate("wrong", "Valve V-104 serves the standby train.", 0.016),
        Candidate("right", "Close valve V-103 and lock it out.", 0.015),
    ]
    ordered, method, reason = rerank_with_model(
        db, "how do I isolate V-103?", candidates
    )
    assert method == "lexical"
    assert ordered[0][0] == "right"
    # The fallback says why, so a tier that is silently broken cannot hide
    # behind one that still answers.
    assert reason


def test_a_single_candidate_is_not_worth_a_model_call(db):
    ordered, method, _ = rerank_with_model(
        db, "V-103", [Candidate("a", "V-103", 0.1)]
    )
    assert method == "lexical"
    assert [chunk_id for chunk_id, _ in ordered] == ["a"]


def test_the_model_rerank_can_be_switched_off(db, monkeypatch):
    from app.knowledge import reranker

    called = False

    def _should_not_run(*args, **kwargs):
        nonlocal called
        called = True
        return None, "lexical", ""

    monkeypatch.setattr(reranker.settings, "enable_model_rerank", False)
    monkeypatch.setattr(reranker, "_model_scores", _should_not_run)

    _, method, reason = rerank_with_model(
        db, "V-103", [Candidate("a", "V-103", 0.1), Candidate("b", "V-104", 0.2)]
    )
    assert method == "lexical"
    assert not called
    assert "disabled by configuration" in reason


def test_a_model_score_reorders_but_cannot_bury_an_exact_tag(db, monkeypatch):
    """The model's opinion is blended in, not substituted for the lexical one.

    A reranking model that has not been told which identifier matters can
    still prefer a fluent passage about the wrong vessel.
    """
    from app.knowledge import reranker

    candidates = [
        Candidate("wrong", "Valve V-104 serves the standby train.", 0.016),
        Candidate("right", "Close valve V-103 and lock it out.", 0.015),
    ]
    monkeypatch.setattr(
        reranker,
        "_model_scores",
        lambda *args, **kwargs: ({"wrong": 0.9, "right": 0.1}, "model_scored", ""),
    )

    ordered, method, _ = rerank_with_model(db, "how do I isolate V-103?", candidates)
    assert method == "model_scored"
    assert ordered[0][0] == "right"


def test_a_model_score_does_reorder_when_no_tag_is_at_stake(db, monkeypatch):
    from app.knowledge import reranker

    candidates = [
        Candidate("first", "Permits are filed with the shift supervisor.", 0.020),
        Candidate("second", "A hot work permit is required before welding.", 0.019),
    ]
    monkeypatch.setattr(
        reranker,
        "_model_scores",
        lambda *args, **kwargs: ({"second": 1.0, "first": 0.0}, "model_scored", ""),
    )

    ordered, _, _ = rerank_with_model(db, "when do I need a permit?", candidates)
    assert ordered[0][0] == "second"


def test_lexical_rerank_still_works_standalone():
    ordered = rerank(
        "isolate V-103",
        [
            Candidate("a", "Valve V-104 standby.", 0.02),
            Candidate("b", "Isolate valve V-103 first.", 0.01),
        ],
    )
    assert ordered[0][0] == "b"


def test_search_diagnostics_name_the_reranker_that_ran(client, auth_headers):
    client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={
            "file": (
                "rr.txt",
                io.BytesIO(b"4.2 Isolation\nClose valve V-103 and lock it out."),
                "text/plain",
            )
        },
    )
    body = client.post(
        "/api/v1/knowledge/search",
        headers=auth_headers,
        json={"query": "isolate V-103", "limit": 3},
    ).json()
    # Honest about which tier ran rather than implying a model was involved.
    assert body["diagnostics"]["rerank_method"] == "lexical"


# --- the catalogue --------------------------------------------------------


def test_a_reranking_model_exists_in_the_gpu_catalogues():
    for vram in (8.0, 6.0):
        types = {entry["type"] for entry in catalogue_for(vram)}
        assert "reranking" in types, f"{vram} GB catalogue has no reranker"


def test_the_cpu_catalogue_does_not_spend_its_budget_on_reranking():
    assert "reranking" not in {entry["type"] for entry in catalogue_for(0.0)}


def test_the_reranker_is_a_vllm_model_because_ollama_has_no_rerank_endpoint():
    entry = next(
        item for item in catalogue_for(8.0) if item["type"] == "reranking"
    )
    assert entry["provider"] == "vllm"
    assert "reranking" in entry["capabilities"]


def test_an_unavailable_model_names_the_right_runtime_in_its_remedy(db):
    """Telling an operator to `ollama pull` a vLLM-only model wastes their time."""
    from app.models.registry import ModelRegistry

    registry = ModelRegistry(db)
    registry.seed()
    registry.reconcile(set())

    for record in registry.all():
        assert record.status == "unavailable"
        if record.provider == "ollama":
            assert "ollama pull" in record.status_detail
        else:
            assert "ollama pull" not in record.status_detail
            assert record.provider in record.status_detail


# --- the vLLM adapter -----------------------------------------------------


@pytest.mark.anyio
async def test_vllm_embeddings_are_reordered_by_index(monkeypatch):
    """The OpenAI schema does not promise ordered data.

    A reordered batch would attach every embedding to the wrong chunk, which
    is the kind of fault that produces plausible citations to the wrong page.
    """
    import httpx

    from app.models.vllm import VLLMProvider

    payload = {
        "data": [
            {"index": 2, "embedding": [0.3]},
            {"index": 0, "embedding": [0.1]},
            {"index": 1, "embedding": [0.2]},
        ]
    }

    async def _post(self, url, **kwargs):
        return httpx.Response(200, json=payload, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)
    vectors = await VLLMProvider().embed("m", ["a", "b", "c"])
    assert vectors == [[0.1], [0.2], [0.3]]


@pytest.mark.anyio
async def test_vllm_rerank_returns_a_score_per_document_in_order(monkeypatch):
    import httpx

    from app.models.vllm import VLLMProvider

    payload = {
        "results": [
            {"index": 1, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.2},
        ]
    }

    async def _post(self, url, **kwargs):
        return httpx.Response(200, json=payload, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)
    scores = await VLLMProvider().rerank("m", "q", ["first", "second"])
    assert scores == [0.2, 0.9]


@pytest.mark.anyio
async def test_vllm_embedding_failure_is_a_provider_error(monkeypatch):
    import httpx

    from app.models.base import ProviderError
    from app.models.vllm import VLLMProvider

    async def _post(self, url, **kwargs):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx.AsyncClient, "post", _post)
    with pytest.raises(ProviderError):
        await VLLMProvider().embed("m", ["a"])


# --- the files list -------------------------------------------------------


def test_files_can_be_listed(client, auth_headers):
    for name in ("one.txt", "two.txt"):
        assert (
            client.post(
                "/api/v1/files/upload",
                headers=auth_headers,
                files={"file": (name, io.BytesIO(b"Valve V-103 note."), "text/plain")},
            ).status_code
            == 201
        )

    response = client.get("/api/v1/files", headers=auth_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["total"] >= 2
    assert {"one.txt", "two.txt"} <= {item["filename"] for item in body["items"]}


def test_the_files_list_is_scoped_to_the_caller(client, auth_headers, make_user):
    client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={"file": ("mine.txt", io.BytesIO(b"private"), "text/plain")},
    )
    other, password = make_user()
    token = client.post(
        "/api/v1/auth/login", json={"email": other.email, "password": password}
    ).json()["access_token"]

    body = client.get(
        "/api/v1/files", headers={"Authorization": f"Bearer {token}"}
    ).json()
    assert body["items"] == []
    assert body["total"] == 0


def test_the_files_list_requires_authentication(client):
    assert client.get("/api/v1/files").status_code == 401


def test_the_files_list_pages(client, auth_headers):
    for index in range(3):
        client.post(
            "/api/v1/files/upload",
            headers=auth_headers,
            files={"file": (f"p{index}.txt", io.BytesIO(b"note"), "text/plain")},
        )
    page = client.get("/api/v1/files?limit=2&offset=0", headers=auth_headers).json()
    assert len(page["items"]) == 2
    assert page["limit"] == 2 and page["offset"] == 0


def test_search_diagnostics_explain_a_rerank_fallback(db, corpus_free_search):
    """A tier that cannot run must say so, not just report the tier that did.

    The graph client hid a real bug for exactly this reason: a fallback that
    answers without explaining itself makes a broken tier look like a working
    one.
    """
    # A query matching both chunks, so there is genuinely something to
    # rerank -- a single candidate skips the tier outright and rightly
    # explains nothing.
    result = corpus_free_search("valve")
    assert result.diagnostics.rerank_method == "lexical"
    assert any(
        "rerank fell back to lexical" in note for note in result.diagnostics.notes
    )


@pytest.fixture
def corpus_free_search(db, make_user):
    """A one-document corpus and a search closure over it."""
    from uuid import uuid4

    from app.db.models import Document, DocumentChunk
    from app.knowledge import retrieval

    user, _ = make_user()
    document = Document(
        id=uuid4(),
        file_id=uuid4(),
        owner_id=user.id,
        filename="SOP.pdf",
        mime_type="application/pdf",
        checksum="3" * 64,
        storage_path="unused",
        classification="INTERNAL",
        kind="pdf_text",
        status="active",
    )
    db.add(document)
    db.flush()
    db.add_all(
        [
            DocumentChunk(
                document_id=document.id,
                ordinal=0,
                page=1,
                text="Close valve V-103 and lock it out.",
                classification="INTERNAL",
                char_count=34,
            ),
            DocumentChunk(
                document_id=document.id,
                ordinal=1,
                page=2,
                text="Valve V-104 serves the standby train.",
                classification="INTERNAL",
                char_count=37,
            ),
        ]
    )
    db.commit()

    def _search(query: str):
        return retrieval.search(
            db,
            query,
            classifications=["INTERNAL"],
            limit=3,
            document_ids=[document.id],
        )

    return _search
