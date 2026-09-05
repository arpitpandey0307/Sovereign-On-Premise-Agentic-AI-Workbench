"""Per-task scratch space.

Every task gets one directory and may not reach outside it. That boundary is
enforced here, once, rather than in each tool: ``resolve`` refuses any name
that escapes the workspace root, so a traversal in a model-supplied filename
fails at the point of resolution instead of somewhere deeper.

Input files are deliberately *not* in the workspace. They are read through the
file repository by id, so a task can only reach uploads it was created with --
naming a path is never how a file gets read.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from uuid import UUID

from app.core.config import settings

# A generated document is a few hundred kilobytes; a runaway loop writing to
# the workspace is what this actually guards against.
MAX_FILE_BYTES = 16 * 1024 * 1024


class WorkspaceError(RuntimeError):
    """A path escaped the workspace, or a file was too large."""


def root(task_id: UUID) -> Path:
    path = Path(settings.storage_root).resolve() / "workspaces" / str(task_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def resolve(task_id: UUID, name: str) -> Path:
    """Turn a caller-supplied name into a path inside this task's workspace."""
    if not name or name.strip() in {".", ".."}:
        raise WorkspaceError("A filename is required.")

    base = root(task_id)
    candidate = (base / name).resolve()
    if not candidate.is_relative_to(base):
        # The message names the rule, not the resolved host path: telling a
        # caller where their traversal landed is a disclosure in itself.
        raise WorkspaceError(f"{name!r} resolves outside the task workspace.")
    return candidate


def write(task_id: UUID, name: str, payload: bytes) -> Path:
    if len(payload) > MAX_FILE_BYTES:
        raise WorkspaceError(
            f"{len(payload)} bytes exceeds the {MAX_FILE_BYTES} byte workspace limit."
        )
    target = resolve(task_id, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload)
    return target


def read(task_id: UUID, name: str) -> bytes:
    target = resolve(task_id, name)
    if not target.is_file():
        raise WorkspaceError(f"{name!r} is not in the task workspace.")
    if target.stat().st_size > MAX_FILE_BYTES:
        raise WorkspaceError(f"{name!r} is too large to read.")
    return target.read_bytes()


def listing(task_id: UUID) -> list[dict]:
    base = root(task_id)
    return sorted(
        (
            {
                "name": path.relative_to(base).as_posix(),
                "size_bytes": path.stat().st_size,
            }
            for path in base.rglob("*")
            if path.is_file()
        ),
        key=lambda entry: entry["name"],
    )


def clear(task_id: UUID) -> None:
    shutil.rmtree(root(task_id), ignore_errors=True)
