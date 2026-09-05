"""Part 03: extraction, chunking, tag detection and the ingestion pipeline."""

from __future__ import annotations

import io
from uuid import UUID

import pytest

from app.db.repositories.documents import DocumentRepository
from app.documents import entities, ocr, parser
from app.documents.chunker import TARGET_CHARS, chunk_pages, detect_heading

SOP_TEXT = """MAINTENANCE STANDARD OPERATING PROCEDURE

1 SCOPE
This procedure covers isolation of pump P-103 prior to seal replacement.

4.2 Isolation
Close valve V-103 and lock it out. Confirm zero pressure at PT-2201 before
breaking any flange. The relief path through PSV-2201 must remain clear.

4.3 Restoration
Restore power to motor M-14 only after the permit is signed off.
"""


# --- type detection -------------------------------------------------------


@pytest.mark.parametrize(
    ("mime", "filename", "expected"),
    [
        ("application/pdf", "sop.pdf", "pdf_text"),
        ("image/png", "pid.png", "image"),
        ("text/plain", "notes.txt", "text"),
        (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "readings.xlsx",
            "spreadsheet",
        ),
        ("application/octet-stream", "drawing.pdf", "pdf_text"),
        ("application/octet-stream", "mystery.bin", "unknown"),
    ],
)
def test_detect_kind(mime, filename, expected):
    assert parser.detect_kind(mime, filename) == expected


def test_unknown_type_extracts_nothing_rather_than_guessing(tmp_path):
    target = tmp_path / "mystery.bin"
    target.write_bytes(b"\x00\x01\x02")
    result = parser.extract(target, "application/octet-stream", "mystery.bin")
    assert result.kind == "unknown"
    assert result.pages == []


def test_plain_text_is_paginated_on_line_boundaries(tmp_path):
    target = tmp_path / "log.txt"
    target.write_text("\n".join(f"line {index}" for index in range(1200)))

    result = parser.extract(target, "text/plain", "log.txt")
    assert len(result.pages) > 1
    assert [page.page_number for page in result.pages] == list(
        range(1, len(result.pages) + 1)
    )
    # Pagination must not lose or duplicate content.
    assert result.pages[0].text.startswith("line 0")
    assert result.pages[-1].text.endswith("line 1199")


def test_native_pdf_text_is_extracted_per_page(tmp_path):
    fitz = pytest.importorskip("fitz")

    document = fitz.open()
    for index in range(3):
        page = document.new_page()
        # Enough text that the page is not mistaken for a scan: the extractor
        # treats a nearly-empty text layer as a document that needs OCR.
        for line in range(12):
            page.insert_text(
                (72, 96 + line * 14),
                f"Page {index + 1} line {line}: isolation of pump P-10{index} "
                "requires the permit to be signed.",
            )
    target = tmp_path / "sop.pdf"
    document.save(target)
    document.close()

    result = parser.extract(target, "application/pdf", "sop.pdf")
    assert result.kind == "pdf_text"
    assert len(result.pages) == 3
    assert "P-101" in result.pages[1].text
    # A page with a text layer is never sent to OCR.
    assert all(page.ocr_status == "native" for page in result.pages)


def test_spreadsheet_rows_become_page_text(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Readings"
    sheet.append(["Tag", "Value"])
    sheet.append(["PT-2201", 4.2])
    target = tmp_path / "readings.xlsx"
    workbook.save(target)

    result = parser.extract(target, "", "readings.xlsx")
    assert result.kind == "spreadsheet"
    assert "PT-2201" in result.pages[0].text
    assert "Readings" in result.pages[0].text


# --- chunking -------------------------------------------------------------


def test_headings_are_recognised_and_shouting_is_not():
    assert detect_heading("4.2 Isolation") == "4.2 Isolation"
    assert detect_heading("SECTION 7: Permits").startswith("Section 7")
    assert detect_heading("MAINTENANCE PROCEDURE") == "Maintenance Procedure"
    # A capitalised sentence is not a title.
    assert detect_heading("CLOSE THE VALVE BEFORE PROCEEDING.") is None
    assert detect_heading("this is body text") is None


def test_chunks_never_span_a_page():
    pages = [(1, SOP_TEXT), (2, SOP_TEXT), (3, SOP_TEXT)]
    chunks = chunk_pages(pages)

    assert chunks
    assert {chunk.page for chunk in chunks} == {1, 2, 3}
    # Ordinals are a contiguous document-wide sequence, which is what the
    # graph node ids and the viewer's ordering both depend on.
    assert [chunk.ordinal for chunk in chunks] == list(range(len(chunks)))


def test_chunks_carry_the_section_they_fell_under():
    chunks = chunk_pages([(7, SOP_TEXT)])
    isolation = [chunk for chunk in chunks if "lock it out" in chunk.text]
    assert isolation, "the isolation paragraph should survive chunking"
    assert isolation[0].section == "4.2 Isolation"
    assert isolation[0].page == 7


def test_a_section_started_on_one_page_governs_the_next():
    chunks = chunk_pages([(1, "4.2 Isolation\nClose the valve."), (2, "Then vent it.")])
    assert chunks[-1].page == 2
    assert chunks[-1].section == "4.2 Isolation"


def test_oversized_paragraphs_are_split_with_overlap():
    sentences = " ".join(
        f"Reading {index} was within tolerance." for index in range(400)
    )
    chunks = chunk_pages([(1, sentences)])

    assert len(chunks) > 1
    # A hard cap rather than a soft target: an oversized chunk would not fit
    # the 4k-8k context windows Part 02 targets.
    assert all(len(chunk.text) <= TARGET_CHARS * 2 for chunk in chunks)


def test_empty_pages_produce_no_chunks():
    assert chunk_pages([(1, ""), (2, "   \n  ")]) == []


# --- entity extraction ----------------------------------------------------


def test_equipment_tags_are_extracted_and_typed():
    found = dict(entities.extract_tags([(1, SOP_TEXT)]))
    tags = {tag.tag: tag.entity_type for tag in found}

    assert tags["P-103"] == "pump"
    assert tags["V-103"] == "valve"
    assert tags["PSV-2201"] == "relief_valve"
    assert tags["PT-2201"] == "pressure_transmitter"
    assert tags["M-14"] == "motor"


def test_document_references_are_not_treated_as_equipment():
    found = dict(entities.extract_tags([(1, "Refer to SOP-204 and API-610.")]))
    tags = {tag.tag: tag.entity_type for tag in found}
    assert tags["SOP-204"] == "document_ref"
    assert tags["API-610"] == "document_ref"


def test_dates_and_common_abbreviations_are_not_tags():
    found = dict(entities.extract_tags([(1, "COVID-19 rules applied in T-2024.")]))
    assert {tag.tag for tag in found} == set()


def test_co_occurrence_links_equipment_on_the_same_page():
    found = entities.extract_tags([(1, SOP_TEXT)])
    pairs = {(left, right) for left, right, _ in entities.co_occurring(found)}
    assert ("P-103", "V-103") in pairs or ("V-103", "P-103") in pairs
    # Document references are not plant items and never become graph nodes.
    assert all("SOP-204" not in pair for pair in pairs)


def test_index_pages_do_not_explode_into_edges():
    legend = " ".join(f"V-{number}" for number in range(100, 140))
    found = entities.extract_tags([(1, legend)])
    assert entities.co_occurring(found) == []


# --- OCR ------------------------------------------------------------------


def test_ocr_availability_is_reported_not_assumed():
    ready, detail = ocr.availability()
    assert isinstance(ready, bool)
    assert detail


def test_ocr_of_unreadable_bytes_degrades_rather_than_raising():
    result = ocr.recognise(b"not an image")
    assert result.status in {"failed", "unavailable"}
    assert result.text == ""


# --- the pipeline, end to end --------------------------------------------


def _upload(client, headers, name: str, body: str, mime: str = "text/plain"):
    response = client.post(
        "/api/v1/files/upload",
        headers=headers,
        files={"file": (name, io.BytesIO(body.encode()), mime)},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_upload_ingests_the_document(client, auth_headers, db):
    uploaded = _upload(client, auth_headers, "sop.txt", SOP_TEXT)

    document = DocumentRepository(db).get_by_file(UUID(uploaded["id"]))
    assert document is not None
    assert document.kind == "text"
    assert document.page_count >= 1
    assert document.chunk_count >= 1

    listed = client.get("/api/v1/documents", headers=auth_headers)
    assert listed.status_code == 200
    assert any(item["id"] == str(document.id) for item in listed.json()["items"])


def test_ingestion_records_tags_and_pages(client, auth_headers, db):
    uploaded = _upload(client, auth_headers, "isolation.txt", SOP_TEXT)
    document = DocumentRepository(db).get_by_file(UUID(uploaded["id"]))

    detail = client.get(
        f"/api/v1/documents/{document.id}", headers=auth_headers
    )
    assert detail.status_code == 200
    body = detail.json()
    assert {entity["tag"] for entity in body["entities"]} >= {"P-103", "V-103"}
    # The list view carries page metadata but not page text.
    assert body["pages"] and all(page["text"] == "" for page in body["pages"])

    page = client.get(
        f"/api/v1/documents/{document.id}/pages/1", headers=auth_headers
    )
    assert page.status_code == 200
    assert "P-103" in page.json()["text"]
    assert page.json()["ocr_status"] == "native"


def test_ingestion_without_a_model_runtime_is_degraded_not_failed(
    client, auth_headers, db
):
    """The suite runs with an empty model registry, so embedding cannot work.

    The document must still ingest: on an air-gapped machine a failed upload
    is a dead end for the operator.
    """
    uploaded = _upload(client, auth_headers, "degraded.txt", SOP_TEXT)
    document = DocumentRepository(db).get_by_file(UUID(uploaded["id"]))

    assert document.chunk_count >= 1
    assert document.indexed_in_graph is False
    assert "embeddings unavailable" in document.ingest_error
    chunks = DocumentRepository(db).chunks(document.id)
    assert all(chunk.embedding is None for chunk in chunks)


def test_reingestion_replaces_rather_than_duplicates(client, auth_headers, db):
    uploaded = _upload(client, auth_headers, "revise.txt", SOP_TEXT)
    repo = DocumentRepository(db)
    first = repo.get_by_file(UUID(uploaded["id"]))
    original_id, original_chunks = first.id, first.chunk_count

    response = client.post(
        f"/api/v1/documents/reingest/{uploaded['id']}", headers=auth_headers
    )
    assert response.status_code == 200

    db.expire_all()
    again = repo.get_by_file(UUID(uploaded["id"]))
    # Same document id so citations already issued keep resolving; version
    # bumped; chunks replaced rather than appended.
    assert again.id == original_id
    assert again.version == 2
    assert again.chunk_count == original_chunks
    assert len(repo.chunks(original_id)) == original_chunks


def test_empty_document_is_rejected_without_creating_a_record(
    client, auth_headers, db
):
    response = client.post(
        "/api/v1/files/upload",
        headers=auth_headers,
        files={"file": ("blank.txt", io.BytesIO(b"   \n  "), "text/plain")},
    )
    assert response.status_code == 201, response.text
    file_id = response.json()["id"]

    # Ingestion fails on empty content; the upload survives and is marked.
    db.expire_all()
    assert DocumentRepository(db).get_by_file(UUID(file_id)) is None
