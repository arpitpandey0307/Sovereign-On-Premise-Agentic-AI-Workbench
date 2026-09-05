"""Workspace file tools.

Two tools, both scoped to the task's own workspace. Reading an *uploaded*
document is done by file id rather than by path, and only for files the task
was actually created with -- so a model cannot reach another user's upload by
guessing a filename, and cannot reach one of its own owner's uploads that was
not part of this task.
"""

from __future__ import annotations

from typing import ClassVar
from uuid import UUID

from app.db.database import SessionLocal
from app.db.repositories.documents import DocumentRepository
from app.db.repositories.files import FileRepository
from app.tools import workspace
from app.tools.base import ToolContext, ToolResult

# Read-back is capped well below the workspace limit: this text usually ends
# up in a model's context window, and a megabyte of it would not fit.
MAX_TEXT_CHARS = 40_000


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

        with SessionLocal() as db:
            record = FileRepository(db).get(wanted)
            if record is None:
                return ToolResult.failed("Input file not found.")

            document = DocumentRepository(db).get_by_file(wanted)
            if document is None:
                return ToolResult.failed(
                    f"{record.filename} has not been ingested yet, so it has "
                    "no extracted text to read."
                )

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


def _cap(text: str) -> str:
    if len(text) <= MAX_TEXT_CHARS:
        return text
    return text[:MAX_TEXT_CHARS] + f"\n[truncated at {MAX_TEXT_CHARS} characters]"
