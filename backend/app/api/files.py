"""File upload, retrieval and deletion.

The physical bytes go through ``StoragePort``; this module owns only the
``files`` record. A successful upload hands the file id to Part 03's
ingestion interface as a background task -- the response must not block on
OCR of a scanned P&ID.
"""

from __future__ import annotations

from typing import Annotated, BinaryIO
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, File, UploadFile, status

from app.core.config import settings
from app.core.dependencies import DbSession, record_audit, require
from app.core.errors import (
    NotFoundError,
    PayloadTooLargeError,
    UnsupportedMediaTypeError,
)
from app.core.storage import storage
from app.db.models import User
from app.db.repositories.files import FileRepository
from app.integrations import registry
from app.schemas.api import FileResponse

router = APIRouter(prefix="/files", tags=["files"])

ReadUser = Annotated[User, Depends(require("file", "read"))]
UploadUser = Annotated[User, Depends(require("file", "upload"))]
DeleteUser = Annotated[User, Depends(require("file", "delete"))]

# The document types this workbench is built for: scanned reports, P&IDs,
# spreadsheets and the plain-text formats around them.
ALLOWED_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/tiff",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-excel",
    "text/csv",
    "text/plain",
    "application/json",
}


class _LimitedReader:
    """Reject an oversized upload while streaming instead of after buffering."""

    def __init__(self, stream: BinaryIO, limit: int) -> None:
        self._stream = stream
        self._limit = limit
        self._read = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self._stream.read(size)
        self._read += len(chunk)
        if self._read > self._limit:
            raise PayloadTooLargeError(
                f"File exceeds the {settings.max_upload_size_mb} MB upload limit."
            )
        return chunk


def _ingest(file_id: UUID) -> None:
    """Background hand-off to Part 03, isolated so a failure is recorded."""
    from app.db.database import SessionLocal

    with SessionLocal() as db:
        repo = FileRepository(db)
        try:
            registry.get_documents().ingest(file_id)
            repo.set_ingestion_status(file_id, "ingested")
        except Exception as exc:  # ingestion must not take the upload down
            repo.set_ingestion_status(file_id, "failed")
            record_audit(
                event_type="INGESTION_FAILED",
                action="file:ingest",
                metadata={"file_id": str(file_id), "error": str(exc)},
            )


@router.post("/upload", response_model=FileResponse, status_code=status.HTTP_201_CREATED)
def upload_file(
    user: UploadUser,
    db: DbSession,
    background: BackgroundTasks,
    file: Annotated[UploadFile, File()],
) -> FileResponse:
    mime_type = file.content_type or "application/octet-stream"
    if mime_type not in ALLOWED_MIME_TYPES:
        raise UnsupportedMediaTypeError(
            f"{mime_type} is not an accepted document type.",
            details={"accepted": sorted(ALLOWED_MIME_TYPES)},
        )

    reader = _LimitedReader(file.file, settings.max_upload_size_bytes)
    try:
        storage_path, size_bytes, sha256 = storage.save(
            reader, owner_id=user.id, filename=file.filename or "upload"
        )
    except PayloadTooLargeError:
        # The partial file is removed by the storage adapter itself.
        record_audit(
            event_type="UPLOAD_REJECTED",
            action="file:upload",
            user_id=user.id,
            metadata={"reason": "payload_too_large", "filename": file.filename},
        )
        raise
    finally:
        file.file.close()

    if size_bytes == 0:
        storage.delete(storage_path)
        raise UnsupportedMediaTypeError("The uploaded file is empty.")

    record = FileRepository(db).create(
        owner_id=user.id,
        filename=file.filename or "upload",
        mime_type=mime_type,
        size_bytes=size_bytes,
        storage_path=storage_path,
        sha256=sha256,
    )

    record_audit(
        event_type="FILE_UPLOADED",
        action="file:upload",
        user_id=user.id,
        metadata={
            "file_id": str(record.id),
            "filename": record.filename,
            "size_bytes": size_bytes,
            "sha256": sha256,
        },
    )

    background.add_task(_ingest, record.id)
    return FileResponse.model_validate(record)


@router.get("/{file_id}", response_model=FileResponse)
def get_file(file_id: UUID, user: ReadUser, db: DbSession) -> FileResponse:
    record = FileRepository(db).get(file_id)
    if record is None or record.owner_id != user.id:
        raise NotFoundError("File not found.")
    record_audit(
        event_type="DOCUMENT_ACCESSED",
        action="file:read",
        user_id=user.id,
        metadata={"file_id": str(file_id)},
    )
    return FileResponse.model_validate(record)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_file(file_id: UUID, user: DeleteUser, db: DbSession) -> None:
    repo = FileRepository(db)
    record = repo.get(file_id)
    if record is None or record.owner_id != user.id:
        raise NotFoundError("File not found.")

    storage.delete(record.storage_path)
    repo.delete(record)
    record_audit(
        event_type="FILE_DELETED",
        action="file:delete",
        user_id=user.id,
        metadata={"file_id": str(file_id)},
    )
