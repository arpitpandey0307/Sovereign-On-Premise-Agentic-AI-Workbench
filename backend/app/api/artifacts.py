"""Artifact metadata and authenticated download proxy.

Part 04 generates artifacts and owns the bytes. Part 01 checks that the
caller owns the originating task, records the download in the audit ledger,
and streams the file. It never inspects or produces artifact content.
"""

from __future__ import annotations

import mimetypes
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse as FileDownloadResponse

from app.core.config import settings
from app.core.dependencies import DbSession, record_audit, require
from app.core.errors import NotFoundError
from app.core.storage import storage
from app.db.models import User
from app.db.repositories.tasks import TaskRepository
from app.integrations import registry
from app.schemas.api import ArtifactResponse

router = APIRouter(prefix="/artifacts", tags=["artifacts"])

DownloadUser = Annotated[User, Depends(require("artifact", "download"))]


def _authorised_artifact(artifact_id: UUID, user: User, db: DbSession):
    artifact = registry.get_artifacts().get(artifact_id)
    if artifact is None:
        raise NotFoundError("Artifact not found.")

    # Authorisation follows the originating task, which Part 01 does own.
    task = TaskRepository(db).get(artifact.task_id)
    if task is None or task.user_id != user.id:
        raise NotFoundError("Artifact not found.")
    return artifact


@router.get("/{artifact_id}", response_model=ArtifactResponse)
def get_artifact(
    artifact_id: UUID, user: DownloadUser, db: DbSession
) -> ArtifactResponse:
    artifact = _authorised_artifact(artifact_id, user, db)
    return ArtifactResponse(
        artifact_id=artifact.artifact_id,
        task_id=artifact.task_id,
        type=artifact.type,
        validation_status=artifact.validation_status,
        download_url=f"{settings.api_v1_prefix}/artifacts/{artifact.artifact_id}/download",
    )


@router.get("/{artifact_id}/download")
def download_artifact(
    artifact_id: UUID, user: DownloadUser, db: DbSession
) -> FileDownloadResponse:
    artifact = _authorised_artifact(artifact_id, user, db)

    path = storage.resolve(artifact.storage_path)
    if not path.is_file():
        raise NotFoundError("Artifact file is missing from storage.")

    record_audit(
        event_type="ARTIFACT_DOWNLOADED",
        action="artifact:download",
        user_id=user.id,
        task_id=artifact.task_id,
        metadata={"artifact_id": str(artifact_id), "type": artifact.type},
    )

    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileDownloadResponse(
        path=path, media_type=media_type, filename=path.name
    )
