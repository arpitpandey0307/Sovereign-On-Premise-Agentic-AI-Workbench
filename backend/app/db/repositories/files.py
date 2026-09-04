"""Data access for raw upload records."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import FileRecord


class FileRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create(
        self,
        *,
        owner_id: UUID,
        filename: str,
        mime_type: str,
        size_bytes: int,
        storage_path: str,
        sha256: str,
    ) -> FileRecord:
        record = FileRecord(
            owner_id=owner_id,
            filename=filename,
            mime_type=mime_type,
            size_bytes=size_bytes,
            storage_path=storage_path,
            sha256=sha256,
        )
        self.db.add(record)
        self.db.commit()
        self.db.refresh(record)
        return record

    def get(self, file_id: UUID) -> FileRecord | None:
        return self.db.get(FileRecord, file_id)

    def list_for_owner(self, owner_id: UUID) -> list[FileRecord]:
        stmt = (
            select(FileRecord)
            .where(FileRecord.owner_id == owner_id)
            .order_by(FileRecord.uploaded_at.desc())
        )
        return list(self.db.scalars(stmt))

    def get_many(self, file_ids: list[UUID]) -> list[FileRecord]:
        if not file_ids:
            return []
        stmt = select(FileRecord).where(FileRecord.id.in_(file_ids))
        return list(self.db.scalars(stmt))

    def set_ingestion_status(self, file_id: UUID, status: str) -> None:
        record = self.get(file_id)
        if record is None:
            return
        record.ingestion_status = status
        self.db.commit()

    def delete(self, record: FileRecord) -> None:
        self.db.delete(record)
        self.db.commit()
