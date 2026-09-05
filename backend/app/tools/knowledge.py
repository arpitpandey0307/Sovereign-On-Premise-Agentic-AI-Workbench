"""Retrieval and OCR, exposed to the agent as tools.

Part 04 never queries Neo4j and never opens a PDF. It calls these, which call
Part 03's interfaces. That boundary is what lets the knowledge store change
without the orchestrator noticing, and it is also where the clearance filter
sits: ``knowledge.search`` resolves what the *caller's roles* may read, so an
agent cannot retrieve above the clearance of the person who started the task.
"""

from __future__ import annotations

from typing import ClassVar
from uuid import UUID

from app.integrations import registry
from app.tools.base import ToolContext, ToolResult

# Evidence goes into a reasoning model's context window alongside the request
# and the SOP. More than this and the useful part gets pushed out.
MAX_RESULTS = 8
SNIPPET_CHARS = 1200


class KnowledgeSearchTool:
    name = "knowledge.search"
    description = (
        "Search the ingested document corpus and return cited evidence: "
        "document name, page, section and text. Use this to ground any claim "
        "about what a procedure or report says. Prefer exact identifiers "
        "(SOP-204, V-103) in the query when you have them."
    )
    risk_level = "low"
    requires_approval = False
    input_schema: ClassVar[dict] = {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer"},
            "document_ids": {
                "type": "array",
                "description": "Restrict the search to these documents.",
            },
        },
        "required": ["query"],
    }

    def execute(self, args: dict, context: ToolContext) -> ToolResult:
        query = str(args["query"]).strip()
        if not query:
            return ToolResult.failed("A search query is required.")

        limit = max(1, min(int(args.get("limit", 5)), MAX_RESULTS))

        document_ids: list[UUID] | None = None
        raw_ids = args.get("document_ids") or []
        if raw_ids:
            try:
                document_ids = [UUID(str(value)) for value in raw_ids]
            except ValueError:
                return ToolResult.failed("'document_ids' contains an invalid id.")

        evidence = registry.get_knowledge().search(
            query,
            roles=context.roles,
            limit=limit,
            document_ids=document_ids,
        )

        return ToolResult(
            ok=True,
            data={
                "query": query,
                "results": [
                    {
                        "document_id": str(item.document_id),
                        "document_name": item.document_name,
                        "page": item.page,
                        "section": item.section,
                        "text": item.text[:SNIPPET_CHARS],
                        "score": item.score,
                    }
                    for item in evidence
                ],
            },
            detail=f"{len(evidence)} result(s) for {query[:60]!r}",
        )


class OcrExtractTool:
    name = "ocr.extract"
    description = (
        "Return the extracted text of one of this task's input documents, "
        "page by page, including any vision-model description of a drawing."
    )
    risk_level = "low"
    requires_approval = False
    input_schema: ClassVar[dict] = {
        "type": "object",
        "properties": {
            "file_id": {"type": "string"},
            "page": {"type": "integer", "description": "Omit for every page."},
        },
        "required": ["file_id"],
    }

    def execute(self, args: dict, context: ToolContext) -> ToolResult:
        from app.db.database import SessionLocal
        from app.db.repositories.documents import DocumentRepository

        try:
            wanted = UUID(str(args["file_id"]))
        except ValueError:
            return ToolResult.failed("'file_id' is not a valid id.")

        if wanted not in context.input_file_ids:
            return ToolResult.failed("That file is not one of this task's inputs.")

        with SessionLocal() as db:
            repo = DocumentRepository(db)
            document = repo.get_by_file(wanted)
            if document is None:
                return ToolResult.failed(
                    "That file has not been ingested, so it has no text yet."
                )

            page_number = args.get("page")
            pages = (
                [repo.page(document.id, int(page_number))]
                if page_number is not None
                else repo.pages(document.id)
            )
            pages = [page for page in pages if page is not None]
            if not pages:
                return ToolResult.failed("No such page in that document.")

            return ToolResult(
                ok=True,
                data={
                    "filename": document.filename,
                    "classification": document.classification,
                    "pages": [
                        {
                            "page": page.page_number,
                            "text": page.text,
                            # Kept separate so a caller can tell a quotation
                            # from a model's description of a drawing.
                            "vision_summary": page.vision_summary,
                            "ocr_status": page.ocr_status,
                            "ocr_confidence": page.ocr_confidence,
                        }
                        for page in pages
                    ],
                },
                detail=f"{document.filename}: {len(pages)} page(s)",
            )
