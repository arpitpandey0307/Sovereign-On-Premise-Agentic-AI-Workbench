"""Workspace file tools.

Two tools, both scoped to the task's own workspace. Reading an *uploaded*
document is done by file id rather than by path, and only for files the task
was actually created with -- so a model cannot reach another user's upload by
guessing a filename, and cannot reach one of its own owner's uploads that was
not part of this task.
"""

from __future__ import annotations

import logging
import time
from typing import ClassVar
from uuid import UUID

from app.db.database import SessionLocal
from app.db.repositories.documents import DocumentRepository
from app.db.repositories.files import FileRepository
from app.tools import workspace
from app.tools.base import ToolContext, ToolResult

logger = logging.getLogger("workbench.tools.file")

# Read-back is capped well below the workspace limit: this text usually ends
# up in a model's context window, and a megabyte of it would not fit.
MAX_TEXT_CHARS = 40_000

# Uploading hands ingestion to a background task so the upload response does
# not block on OCR and a vision pass. A user who attaches a file and sends the
# turn immediately therefore arrives here while that work is still running --
# routinely, because attaching and sending is one gesture in the UI.
#
# Failing on arrival made the attachment silently invisible: the run continued
# with no text, and the model answered as though nothing had been attached.
# Waiting is the honest behaviour. The ceiling is generous because a scanned
# drawing needs OCR and a vision model, and the alternative to waiting is
# answering the wrong question.
INGESTION_WAIT_SECONDS = 45.0
INGESTION_POLL_SECONDS = 0.25


class FileReadTool:
    name = "file.read"
    description = (
        "Read a file. Either a workspace file written earlier in this task "
        "(by name), or one of the task's own input documents (by file_id). "
        "An input document is returned as its extracted text, not raw bytes."
    )
    risk_level = "low"
    requires_approval = False
    input_schema: ClassVar[dict] = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Workspace filename."},
            "file_id": {"type": "string", "description": "An input file's id."},
        },
        "required": [],
    }

    def execute(self, args: dict, context: ToolContext) -> ToolResult:
        name = args.get("name")
        file_id = args.get("file_id")

        if bool(name) == bool(file_id):
            return ToolResult.failed("Provide exactly one of 'name' or 'file_id'.")

        if name:
            try:
                payload = workspace.read(context.task_id, name)
            except workspace.WorkspaceError as exc:
                return ToolResult.failed(str(exc))
            text = payload.decode("utf-8", errors="replace")
            return ToolResult(
                ok=True,
                data={"name": name, "text": _cap(text), "bytes": len(payload)},
                detail=f"read {name}",
            )

        return self._read_input(file_id, context)

    def _read_input(self, file_id: str, context: ToolContext) -> ToolResult:
        try:
            wanted = UUID(str(file_id))
        except ValueError:
            return ToolResult.failed("'file_id' is not a valid id.")

        # The task's own inputs, and nothing else. Ownership was already
        # checked when the task was created; this stops a later step widening
        # the set it may read.
        if wanted not in context.input_file_ids:
            return ToolResult.failed(
                "That file is not one of this task's inputs."
            )

        status = _await_ingestion(wanted)

        with SessionLocal() as db:
            record = FileRepository(db).get(wanted)
            if record is None:
                return ToolResult.failed("Input file not found.")

            document = DocumentRepository(db).get_by_file(wanted)
            if document is None:
                # Say which of the three it is. "Not ingested" covers a file
                # that failed, one still working and one that was never
                # queued, and the operator's next step differs for each.
                if status == "failed":
                    detail = "could not be ingested, so it has no readable text"
                elif status == "pending":
                    detail = (
                        f"was still being processed after "
                        f"{INGESTION_WAIT_SECONDS:.0f}s, so its text is not "
                        "available yet"
                    )
                else:
                    detail = "has no extracted text to read"
                return ToolResult.failed(f"{record.filename} {detail}.")

            pages = DocumentRepository(db).pages(document.id)
            body = "\n\n".join(
                f"--- page {page.page_number} ---\n{page.text}"
                + (
                    f"\n[vision description]\n{page.vision_summary}"
                    if page.vision_summary
                    else ""
                )
                for page in pages
            )
            return ToolResult(
                ok=True,
                data={
                    "file_id": str(wanted),
                    "filename": record.filename,
                    "classification": document.classification,
                    "pages": len(pages),
                    "text": _cap(body),
                },
                detail=f"read {record.filename} ({len(pages)} page(s))",
            )


class FileWriteTool:
    name = "file.write"
    description = (
        "Write a text file into this task's workspace so a later step, or the "
        "code sandbox, can use it."
    )
    risk_level = "low"
    requires_approval = False
    input_schema: ClassVar[dict] = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["name", "content"],
    }

    def execute(self, args: dict, context: ToolContext) -> ToolResult:
        try:
            path = workspace.write(
                context.task_id, args["name"], args["content"].encode("utf-8")
            )
        except workspace.WorkspaceError as exc:
            return ToolResult.failed(str(exc))

        return ToolResult(
            ok=True,
            data={"name": args["name"], "bytes": path.stat().st_size},
            detail=f"wrote {args['name']}",
        )


class FileListTool:
    name = "file.list"
    description = "List the files currently in this task's workspace."
    risk_level = "low"
    requires_approval = False
    input_schema: ClassVar[dict] = {"type": "object", "properties": {}, "required": []}

    def execute(self, args: dict, context: ToolContext) -> ToolResult:
        files = workspace.listing(context.task_id)
        return ToolResult(
            ok=True, data={"files": files}, detail=f"{len(files)} file(s)"
        )


def _await_ingestion(file_id: UUID) -> str:
    """Block until the file's ingestion settles, or the ceiling is reached.

    Returns the last status seen, so the caller can say *why* there is no text
    rather than only that there is none. A fresh session per poll on purpose:
    ingestion commits from another thread, and a session that read the row
    once would keep handing back the same cached "pending" forever.
    """
    deadline = time.monotonic() + INGESTION_WAIT_SECONDS
    status = "pending"
    waited = False

    while True:
        with SessionLocal() as db:
            record = FileRepository(db).get(file_id)
            if record is None:
                return "missing"
            status = record.ingestion_status or "pending"

        if status != "pending" or time.monotonic() >= deadline:
            break

        waited = True
        time.sleep(INGESTION_POLL_SECONDS)

    if waited:
        logger.info("waited for ingestion of %s, settled as %s", file_id, status)
    return status


def _cap(text: str) -> str:
    if len(text) <= MAX_TEXT_CHARS:
        return text
    return text[:MAX_TEXT_CHARS] + f"\n[truncated at {MAX_TEXT_CHARS} characters]"
