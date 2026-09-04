"""Object storage behind a narrow interface.

The MVP writes to the local filesystem; MinIO slots in later by implementing
the same three methods. Callers only ever hold the opaque ``storage_path``
string returned by ``save``.
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from typing import BinaryIO, Protocol
from uuid import UUID, uuid4

from app.core.config import settings


class StoragePort(Protocol):
    def save(
        self, stream: BinaryIO, *, owner_id: UUID, filename: str
    ) -> tuple[str, int, str]:
        """Persist a stream. Returns ``(storage_path, size_bytes, sha256)``."""
        ...

    def resolve(self, storage_path: str) -> Path: ...

    def delete(self, storage_path: str) -> None: ...


class LocalFilesystemStorage:
    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or settings.storage_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def save(
        self, stream: BinaryIO, *, owner_id: UUID, filename: str
    ) -> tuple[str, int, str]:
        # Uploads are namespaced per owner and given a fresh id, so a hostile
        # filename can never escape the storage root or clobber a sibling.
        relative = Path(str(owner_id)) / f"{uuid4()}{Path(filename).suffix.lower()}"
        destination = self.root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)

        digest = hashlib.sha256()
        size = 0
        try:
            with destination.open("wb") as handle:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
                    handle.write(chunk)
        except BaseException:
            # A rejected or aborted upload must not leave bytes behind --
            # otherwise repeated failures fill the disk.
            destination.unlink(missing_ok=True)
            raise

        return relative.as_posix(), size, digest.hexdigest()

    def resolve(self, storage_path: str) -> Path:
        candidate = (self.root / storage_path).resolve()
        if not candidate.is_relative_to(self.root):
            raise ValueError("Resolved path escapes the storage root.")
        return candidate

    def delete(self, storage_path: str) -> None:
        target = self.resolve(storage_path)
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        elif target.exists():
            target.unlink()


storage: StoragePort = LocalFilesystemStorage()
