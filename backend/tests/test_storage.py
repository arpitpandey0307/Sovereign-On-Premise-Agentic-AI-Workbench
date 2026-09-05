"""Object storage: the port, its two backends, and the containment rules.

The filesystem backend is exercised directly. MinIO is exercised as far as it
can be without a server -- endpoint validation, key shaping, cache
containment -- because those are the parts that are security-relevant, and the
round trip is verified against a real MinIO by scripts/verify_storage.py.
"""

from __future__ import annotations

import io
from uuid import uuid4

import pytest

from app.core.storage import (
    LocalFilesystemStorage,
    MinioStorage,
    StoragePort,
    object_key,
)


@pytest.fixture
def filesystem(tmp_path):
    return LocalFilesystemStorage(root=tmp_path)


# --- the key shape --------------------------------------------------------


def test_a_hostile_filename_keeps_only_its_extension():
    """Only the suffix survives, so a name can never become a path."""
    owner = uuid4()
    for hostile in (
        "../../etc/passwd.pdf",
        "..\\..\\windows\\system32\\evil.pdf",
        "/absolute/path.pdf",
    ):
        key = object_key(owner, hostile)
        assert key.startswith(f"{owner}/")
        assert key.endswith(".pdf")
        assert ".." not in key
        assert key.count("/") == 1


def test_keys_are_namespaced_per_owner_and_unique():
    owner = uuid4()
    first = object_key(owner, "report.pdf")
    second = object_key(owner, "report.pdf")
    assert first != second
    assert first.split("/")[0] == str(owner)


# --- the filesystem backend -----------------------------------------------


def test_a_round_trip_preserves_bytes_size_and_checksum(filesystem):
    import hashlib

    payload = b"Close valve V-103 and lock it out."
    key, size, digest = filesystem.save(
        io.BytesIO(payload), owner_id=uuid4(), filename="sop.txt"
    )

    assert size == len(payload)
    assert digest == hashlib.sha256(payload).hexdigest()
    assert filesystem.exists(key)
    assert filesystem.read(key) == payload
    assert filesystem.local_path(key).read_bytes() == payload


def test_reading_outside_the_root_is_refused(filesystem):
    for hostile in ("../outside.txt", "../../etc/passwd"):
        with pytest.raises(ValueError, match="escapes the storage root"):
            filesystem.read(hostile)


def test_deleting_removes_the_object(filesystem):
    key, _, _ = filesystem.save(
        io.BytesIO(b"x"), owner_id=uuid4(), filename="a.txt"
    )
    assert filesystem.exists(key)
    filesystem.delete(key)
    assert not filesystem.exists(key)


def test_a_failed_write_leaves_nothing_behind(filesystem):
    """Repeated failures must not fill the disk."""

    class _Exploding:
        def read(self, size=-1):
            raise OSError("upload aborted")

    owner = uuid4()
    with pytest.raises(OSError, match="upload aborted"):
        filesystem.save(_Exploding(), owner_id=owner, filename="big.bin")

    owner_dir = filesystem.root / str(owner)
    assert not owner_dir.exists() or not any(owner_dir.iterdir())


def test_a_missing_object_does_not_exist(filesystem):
    assert not filesystem.exists(f"{uuid4()}/nothing.txt")


# --- the MinIO backend ----------------------------------------------------


def test_a_non_local_storage_endpoint_is_refused():
    """A storage endpoint off this host would end the sovereignty claim."""
    for remote in ("s3.amazonaws.com:443", "storage.example.com:9000"):
        with pytest.raises(ValueError, match="non-local storage endpoint"):
            MinioStorage(remote)


@pytest.mark.parametrize(
    "endpoint", ["127.0.0.1:9000", "localhost:9000", "minio:9000"]
)
def test_local_storage_endpoints_are_accepted(endpoint, tmp_path):
    backend = MinioStorage(endpoint, cache_root=tmp_path)
    assert backend.endpoint == endpoint
    assert backend.name == "minio"


def test_the_download_cache_cannot_be_escaped(tmp_path):
    """A key from the database still must not reach outside the cache."""
    backend = MinioStorage("127.0.0.1:9000", cache_root=tmp_path)
    with pytest.raises(ValueError, match="escapes the storage cache"):
        backend.local_path("../../etc/passwd")


# --- the port ------------------------------------------------------------


def test_both_backends_satisfy_the_port(tmp_path):
    """Whichever is in use must be invisible to callers."""
    assert isinstance(LocalFilesystemStorage(root=tmp_path), StoragePort)
    assert isinstance(MinioStorage("127.0.0.1:9000", cache_root=tmp_path), StoragePort)


def test_an_unreachable_minio_falls_back_rather_than_failing(monkeypatch, tmp_path):
    """A storage outage must not take the API down -- but must not be silent."""
    from app.core import storage as storage_module

    monkeypatch.setattr(storage_module.settings, "storage_backend", "minio")
    monkeypatch.setattr(storage_module.settings, "storage_root", tmp_path)
    monkeypatch.setattr(storage_module.settings, "minio_endpoint", "127.0.0.1:59999")

    backend = storage_module.build_storage()
    assert backend.name == "filesystem"


def test_the_configured_default_is_the_filesystem(monkeypatch, tmp_path):
    from app.core import storage as storage_module

    monkeypatch.setattr(storage_module.settings, "storage_root", tmp_path)
    assert storage_module.build_storage().name == "filesystem"


def test_the_active_backend_is_reported_on_system_status(client, make_user):
    """A silent fallback would be worse than either outcome."""
    admin, password = make_user(roles=["ADMIN"])
    token = client.post(
        "/api/v1/auth/login", json={"email": admin.email, "password": password}
    ).json()["access_token"]

    body = client.get(
        "/api/v1/system/status", headers={"Authorization": f"Bearer {token}"}
    ).json()
    assert body["object_storage"] in {"filesystem", "minio"}
