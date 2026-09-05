"""Object storage behind a narrow interface.

Two backends implement the same port: the local filesystem, which is what the
MVP runs on and needs nothing installed, and MinIO, which is the deployment
target named in the shared tech stack. Callers only ever hold the opaque
``storage_path`` string that ``save`` returns, so which one is in use is not
visible above this module.

The port has a ``local_path`` as well as a ``read`` because some callers
genuinely need a file on disk rather than bytes: PyMuPDF and openpyxl both
open documents by path, and streaming them through memory to satisfy an
interface would be worse than materialising once. On the filesystem backend
that is free; on MinIO it downloads into a cache directory, which is honest
about the cost rather than hiding it behind a pretend path.

Nothing here reaches outside the host. MinIO is a compose service on the
internal network, and its endpoint is validated as local at construction for
the same reason the model adapters validate theirs: a storage endpoint
pointing off-box would quietly end the sovereignty claim.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import tempfile
from pathlib import Path
from typing import BinaryIO, Protocol, runtime_checkable
from urllib.parse import urlparse
from uuid import UUID, uuid4

from app.core.config import settings

logger = logging.getLogger("workbench.storage")

# Hosts a storage endpoint may legitimately be on.
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}
LOCAL_SERVICE_NAMES = {"minio"}

READ_CHUNK = 1024 * 1024


@runtime_checkable
class StoragePort(Protocol):
    name: str

    def save(
        self, stream: BinaryIO, *, owner_id: UUID, filename: str
    ) -> tuple[str, int, str]:
        """Persist a stream. Returns ``(storage_path, size_bytes, sha256)``."""
        ...

    def read(self, storage_path: str) -> bytes:
        """The whole object. For callers that want bytes, not a file."""
        ...

    def local_path(self, storage_path: str) -> Path:
        """A real path on disk, for libraries that open documents by path."""
        ...

    def exists(self, storage_path: str) -> bool: ...

    def delete(self, storage_path: str) -> None: ...


def object_key(owner_id: UUID, filename: str) -> str:
    """Namespaced per owner, with a fresh id for the name.

    A hostile filename can therefore never escape the storage root or clobber
    a sibling: only its extension survives.
    """
    return f"{owner_id}/{uuid4()}{Path(filename).suffix.lower()}"


class LocalFilesystemStorage:
    """The default. Needs nothing running, which is why the MVP uses it."""

    name = "filesystem"

    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or settings.storage_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def save(
        self, stream: BinaryIO, *, owner_id: UUID, filename: str
    ) -> tuple[str, int, str]:
        relative = object_key(owner_id, filename)
        destination = self.root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)

        digest = hashlib.sha256()
        size = 0
        try:
            with destination.open("wb") as handle:
                while chunk := stream.read(READ_CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
                    handle.write(chunk)
        except BaseException:
            # A rejected or aborted upload must not leave bytes behind --
            # otherwise repeated failures fill the disk.
            destination.unlink(missing_ok=True)
            raise

        return relative, size, digest.hexdigest()

    def resolve(self, storage_path: str) -> Path:
        candidate = (self.root / storage_path).resolve()
        if not candidate.is_relative_to(self.root):
            raise ValueError("Resolved path escapes the storage root.")
        return candidate

    def local_path(self, storage_path: str) -> Path:
        return self.resolve(storage_path)

    def read(self, storage_path: str) -> bytes:
        return self.resolve(storage_path).read_bytes()

    def exists(self, storage_path: str) -> bool:
        return self.resolve(storage_path).is_file()

    def delete(self, storage_path: str) -> None:
        target = self.resolve(storage_path)
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        elif target.exists():
            target.unlink()


class MinioStorage:
    """S3-compatible object storage, on the internal compose network."""

    name = "minio"

    def __init__(
        self,
        endpoint: str | None = None,
        *,
        bucket: str | None = None,
        access_key: str | None = None,
        secret_key: str | None = None,
        secure: bool | None = None,
        cache_root: Path | None = None,
    ) -> None:
        raw = endpoint or settings.minio_endpoint
        host = urlparse(f"//{raw}").hostname or raw.split(":")[0]
        if host not in LOCAL_HOSTS and host not in LOCAL_SERVICE_NAMES:
            # Same rule the model adapters enforce, for the same reason.
            raise ValueError(
                f"Refusing a non-local storage endpoint: {raw}. "
                "Confidential documents must not leave this host."
            )

        self.endpoint = raw
        self.bucket = bucket or settings.minio_bucket
        self.secure = settings.minio_secure if secure is None else secure
        self._access_key = access_key or settings.minio_access_key
        self._secret_key = secret_key or settings.minio_secret_key
        # Downloaded objects land here so PyMuPDF and openpyxl have a real
        # file to open. Cleared per object after use is not worth it; the
        # directory is scoped to this process's storage root.
        self.cache_root = Path(
            cache_root or Path(settings.storage_root) / ".minio-cache"
        ).resolve()
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self._client = None

    def _connect(self):
        if self._client is not None:
            return self._client
        from minio import Minio

        client = Minio(
            self.endpoint,
            access_key=self._access_key,
            secret_key=self._secret_key,
            secure=self.secure,
        )
        if not client.bucket_exists(self.bucket):
            client.make_bucket(self.bucket)
        self._client = client
        return client

    def save(
        self, stream: BinaryIO, *, owner_id: UUID, filename: str
    ) -> tuple[str, int, str]:
        key = object_key(owner_id, filename)

        # Buffered to a temporary file first, because the checksum and the
        # length both have to be known before the object is written and the
        # caller's stream cannot be rewound.
        digest = hashlib.sha256()
        size = 0
        with tempfile.NamedTemporaryFile(delete=False) as scratch:
            staged = Path(scratch.name)
            try:
                while chunk := stream.read(READ_CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
                    scratch.write(chunk)
            except BaseException:
                scratch.close()
                staged.unlink(missing_ok=True)
                raise

        try:
            with staged.open("rb") as handle:
                self._connect().put_object(self.bucket, key, handle, length=size)
        finally:
            staged.unlink(missing_ok=True)

        return key, size, digest.hexdigest()

    def read(self, storage_path: str) -> bytes:
        response = self._connect().get_object(self.bucket, storage_path)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def local_path(self, storage_path: str) -> Path:
        """Materialise the object so a path-based library can open it."""
        target = (self.cache_root / storage_path).resolve()
        if not target.is_relative_to(self.cache_root):
            raise ValueError("Resolved path escapes the storage cache.")
        if target.is_file():
            return target

        target.parent.mkdir(parents=True, exist_ok=True)
        self._connect().fget_object(self.bucket, storage_path, str(target))
        return target

    def exists(self, storage_path: str) -> bool:
        from minio.error import S3Error

        try:
            self._connect().stat_object(self.bucket, storage_path)
        except S3Error:
            return False
        return True

    def delete(self, storage_path: str) -> None:
        self._connect().remove_object(self.bucket, storage_path)
        cached = self.cache_root / storage_path
        cached.unlink(missing_ok=True)


def build_storage() -> StoragePort:
    """Pick the backend from configuration.

    A MinIO that cannot be reached falls back to the filesystem rather than
    taking the API down. Uploads still work, and the backend actually in use
    is reported on the system status endpoint -- a silent switch would be
    worse than either outcome.
    """
    if settings.storage_backend != "minio":
        return LocalFilesystemStorage()

    try:
        backend = MinioStorage()
        backend._connect()
    except Exception as exc:
        logger.error(
            "MinIO is configured but unreachable (%s); falling back to the "
            "local filesystem. Uploads will not be in object storage.",
            exc,
        )
        return LocalFilesystemStorage()

    logger.info("object storage: MinIO bucket %r", backend.bucket)
    return backend


storage: StoragePort = build_storage()
