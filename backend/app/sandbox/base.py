"""The sandbox interface.

Code execution sits behind this protocol so the isolation mechanism can change
without the tool layer noticing. The MVP runs a Docker container; gVisor,
Firecracker or Kata are Phase 2, and swapping to one of them should be a
registration change, not a rewrite of ``python.execute``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class SandboxRequest:
    code: str
    language: str = "python"
    # Files copied into the workspace before the run, by relative name. The
    # sandbox never sees a path from the host: the tool layer resolves and
    # reads them, so a hostile path cannot escape the task workspace.
    files: dict[str, bytes] = field(default_factory=dict, repr=False)
    timeout_s: int = 30
    memory_mb: int = 512
    cpus: float = 1.0


@dataclass
class SandboxResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    # Files the code wrote into its workspace, read back out afterwards.
    produced: dict[str, bytes] = field(default_factory=dict, repr=False)
    # "ok" | "timeout" | "unavailable" | "failed" -- distinguishes code that
    # ran and failed from a sandbox that could not run it at all. The agent
    # must not read the second as evidence about the code.
    status: str = "ok"
    detail: str = ""

    @property
    def succeeded(self) -> bool:
        return self.status == "ok" and self.exit_code == 0


@runtime_checkable
class SandboxRunner(Protocol):
    name: str

    def available(self) -> tuple[bool, str]:
        """Whether code can be run at all, and why not if it cannot."""
        ...

    def run(self, request: SandboxRequest) -> SandboxResult: ...


class SandboxUnavailable(RuntimeError):
    """No sandbox can run this. Never raised past the tool gateway."""
