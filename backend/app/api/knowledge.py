"""Document and knowledge endpoints.

Part 03 computes all of this; Part 01 owns the HTTP surface, so the routes
live alongside the others. These power the document viewer, the browsable
knowledge base, and the evidence panel underneath an answer.

Every route here is clearance-aware. Listing and reading are scoped to the
caller's own documents; search is filtered to the classifications Part 05 says
the caller's roles may read, and that filter is applied in the query rather
than to the results.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.core.dependencies import DbSession, record_audit, require
from app.core.errors import NotFoundError
from app.db.models import User
from app.db.repositories.documents import DocumentRepository
from app.db.repositories.files import FileRepository
from app.documents.ingestion import ingest_file
from app.integrations import registry
from app.knowledge.service import knowledge_service
from app.schemas.api import (
    DocumentDetailResponse,
    DocumentEntityResponse,
    DocumentPageResponse,
    DocumentResponse,
    Page,
    SearchRequest,
    SearchResponse,
)

router = APIRouter(tags=["knowledge"])

ReadUser = Annotated[User, Depends(require("document", "read"))]
# The knowledge base as a browsable surface -- free-text search across the whole
# corpus, and walking the equipment graph. Restricted to oversight roles, with
# everyone else asking for a time-boxed grant.
#
# This is deliberately *not* the same gate the agent passes through. A Workbench
# question still retrieves and still cites, because that path is scoped to one
# question, filtered by the asker's clearance, and leaves an answer somebody can
# check. What is restricted here is the other thing: querying the corpus at
# large, repeatedly, and reading what comes back -- which is how a corpus walks
# out of a building.
KnowledgeUser = Annotated[User, Depends(require("knowledge", "search"))]
IngestUser = Annotated[User, Depends(require("document", "ingest"))]
SystemUser = Annotated[User, Depends(require("system", "read"))]


def _readable(db, document_id: UUID, user: User):
    """Load a document the caller may read, or report it as absent.

    Readable means owned *or* within the caller's clearance. Ownership alone
    was too narrow: retrieval hands an engineer a citation from a document
    somebody else uploaded, and following that citation then reported the
    document as missing -- the interface contradicting itself about the same
    file on two adjacent screens.

    Absent rather than forbidden on purpose: telling a caller that a document
    they may not see nevertheless exists is itself a disclosure.
    """
    document = DocumentRepository(db).get(document_id)
    if document is None:
        raise NotFoundError("Document not found.")

    if document.owner_id == user.id:
        return document

    permitted = registry.get_policy().readable_classifications(user.role_names)
    if document.classification not in permitted:
        raise NotFoundError("Document not found.")
    return document


@router.get("/api/v1/documents", response_model=Page[DocumentResponse])
def list_documents(
    user: ReadUser,
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
    scope: Annotated[Literal["mine", "corpus"], Query()] = "mine",
) -> Page[DocumentResponse]:
    """Documents this user can see.

    ``mine`` is what they uploaded -- the "My Documents" screen, where deleting
    and re-ingesting are theirs to do. ``corpus`` is the shared plant corpus
    filtered to their clearance, which is what the knowledge base browses and
    what retrieval already searches. Defaulting to ``mine`` keeps the narrower
    answer the default.
    """
    repo = DocumentRepository(db)
    if scope == "corpus":
        permitted = registry.get_policy().readable_classifications(user.role_names)
        documents, total = repo.list_readable(permitted, limit=limit, offset=offset)
    else:
        documents, total = repo.list_for_owner(user.id, limit=limit, offset=offset)
    return Page(
        items=[DocumentResponse.model_validate(document) for document in documents],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/api/v1/documents/{document_id}", response_model=DocumentDetailResponse)
def get_document(
    document_id: UUID, user: ReadUser, db: DbSession
) -> DocumentDetailResponse:
    document = _readable(db, document_id, user)
    repo = DocumentRepository(db)

    record_audit(
        event_type="DOCUMENT_ACCESSED",
        action="document:read",
        component="documents",
        user_id=user.id,
        metadata={
            "document_id": str(document_id),
            "classification": document.classification,
        },
    )

    return DocumentDetailResponse(
        **DocumentResponse.model_validate(document).model_dump(),
        # Page text is deliberately empty here: a 300-page SOP would otherwise
        # be sent in full just to render a file card. The viewer fetches the
        # one page it is showing.
        pages=[
            DocumentPageResponse(
                page_number=page.page_number,
                text="",
                ocr_status=page.ocr_status,
                ocr_confidence=page.ocr_confidence,
                needs_vision=page.needs_vision,
            )
            for page in repo.pages(document_id)
        ],
        entities=[
            DocumentEntityResponse.model_validate(entity)
            for entity in repo.entities(document_id)
        ],
    )


@router.get(
    "/api/v1/documents/{document_id}/pages/{page_number}",
    response_model=DocumentPageResponse,
)
def get_document_page(
    document_id: UUID, page_number: int, user: ReadUser, db: DbSession
) -> DocumentPageResponse:
    """One page of text, for the viewer a citation links into."""
    _readable(db, document_id, user)
    page = DocumentRepository(db).page(document_id, page_number)
    if page is None:
        raise NotFoundError("Page not found.")
    return DocumentPageResponse.model_validate(page)


@router.post("/api/v1/documents/reingest/{file_id}", response_model=dict)
def reingest(file_id: UUID, user: IngestUser, db: DbSession) -> dict:
    """Re-run the pipeline for an upload.

    Worth having on its own: the first ingestion may have run while Tesseract
    or the model runtime was down, and this is how the operator recovers
    without re-uploading a confidential file.
    """
    record = FileRepository(db).get(file_id)
    if record is None or record.owner_id != user.id:
        raise NotFoundError("File not found.")

    report = ingest_file(db, file_id)
    return report.as_dict()


@router.post("/api/v1/knowledge/search", response_model=SearchResponse)
def search_knowledge(
    payload: SearchRequest, user: KnowledgeUser, db: DbSession
) -> SearchResponse:
    """Hybrid retrieval. Returns evidence the caller is cleared to read."""
    result = knowledge_service.search_with_diagnostics(
        payload.query,
        roles=user.role_names,
        limit=payload.limit,
        document_ids=payload.document_ids or None,
    )

    record_audit(
        event_type="KNOWLEDGE_RETRIEVED",
        action="document:search",
        component="knowledge",
        user_id=user.id,
        metadata={
            # The query is recorded, the retrieved text is not: the audit
            # ledger must not become a second copy of the corpus.
            "query": payload.query[:500],
            "results": len(result.evidence),
            "documents": sorted(
                {str(item.document_id) for item in result.evidence}
            ),
            **result.diagnostics.as_dict(),
        },
    )

    return SearchResponse(
        query=payload.query,
        evidence=[item.model_dump() for item in result.evidence],
        diagnostics=result.diagnostics.as_dict(),
    )


@router.get("/api/v1/knowledge/equipment/{tag}")
def equipment(
    tag: str,
    user: KnowledgeUser,
    depth: Annotated[int, Query(ge=1, le=3)] = 1,
) -> dict:
    """What else relates to this equipment tag.

    The question generic local-AI tools cannot answer: it walks the equipment
    graph rather than ranking text by similarity.
    """
    result = knowledge_service.equipment_neighbours(
        tag, roles=user.role_names, depth=depth
    )
    record_audit(
        event_type="KNOWLEDGE_RETRIEVED",
        action="document:search",
        component="knowledge",
        user_id=user.id,
        metadata={"equipment_tag": tag.upper(), "source": result["source"]},
    )
    return result


@router.get("/internal/knowledge/status", include_in_schema=False)
def knowledge_status(user: SystemUser) -> dict:
    """Index reachability, OCR availability and corpus size, for operators."""
    return knowledge_service.status()
