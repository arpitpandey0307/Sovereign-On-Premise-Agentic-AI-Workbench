"""Docker-backed code execution.

The agent writes code and this runs it. That is the single most dangerous
capability in the system, so the container is built to be useless to anything
that escapes the code's intended purpose:

- **no network at all** (``network_mode="none"``) -- not a firewall rule, no
  interface exists. This is also what keeps the sovereignty claim true: code a
  model wrote cannot exfiltrate the confidential documents it was reasoning
  over, because it has nowhere to send them.
- **read-only root filesystem**, with one writable workspace mounted as a
  tmpfs. Nothing survives the run except the files read back out deliberately.
- **memory and CPU caps**, so a runaway loop cannot take the host down.
- **no new privileges**, all capabilities dropped, and a non-root user.
- **a hard timeout**, enforced by killing the container rather than trusting
  the code to stop.

The workspace is a tmpfs rather than a bind mount on purpose: a bind mount
would put host paths inside the container, and a path traversal there reaches
the real filesystem.

Getting files in and out of that arrangement is less obvious than it looks.
Docker refuses ``put_archive`` into a container whose rootfs is read-only --
before or after start, and regardless of the target being a writable mount --
and ``get_archive`` afterwards sees nothing, because a tmpfs is gone once the
container stops. Rather than give up the read-only rootfs, both directions go
through the process itself: the payload is a base64 tar passed as a command
argument, and anything the program produces comes back base64-encoded on
stdout behind a per-run marker.
"""

from __future__ import annotations

import base64
import io
import logging
import tarfile
import time
import uuid

from app.sandbox.base import SandboxRequest, SandboxResult

logger = logging.getLogger("workbench.sandbox")

# Plain upstream Python. No extra packages by design: a sandbox that can
# import anything is a much larger surface, and the deterministic work this
# runs (arithmetic, table manipulation) needs only the standard library.
SANDBOX_IMAGE = "python:3.12-slim"

WORKSPACE = "/workspace"

# Command arguments are bounded by ARG_MAX (~2 MB on Linux), and the payload
# is base64 so it inflates by a third. Well under, with room for the code.
MAX_PAYLOAD_BYTES = 900_000

# A single file the program produced. Bounded so a runaway write cannot be
# streamed back through stdout into the host.
MAX_PRODUCED_BYTES = 8 * 1024 * 1024

# Runs inside the container. It unpacks the payload into the workspace, runs
# the program, and hands back whatever the program wrote. ``filter="data"``
# makes tar extraction refuse absolute paths and traversal -- the payload is
# built here, but a tar reader that trusts its input is worth not writing.
BOOTSTRAP = f'''
import base64, io, os, runpy, sys, tarfile

payload, marker, seeded = sys.argv[1], sys.argv[2], set(sys.argv[3].split("|"))
os.chdir("{WORKSPACE}")

with tarfile.open(fileobj=io.BytesIO(base64.b64decode(payload)), mode="r") as bundle:
    bundle.extractall("{WORKSPACE}", filter="data")


def emit():
    """Hand back whatever the program wrote, since the tmpfs will not survive."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as out:
        for root, _, names in os.walk("{WORKSPACE}"):
            for name in names:
                path = os.path.join(root, name)
                relative = os.path.relpath(path, "{WORKSPACE}")
                if relative in seeded or os.path.getsize(path) > {MAX_PRODUCED_BYTES}:
                    continue
                out.add(path, arcname=relative)
    sys.stdout.flush()
    sys.stdout.write("\\n" + marker + base64.b64encode(buffer.getvalue()).decode())
    sys.stdout.flush()


try:
    sys.argv = ["main.py"]
    runpy.run_path("{WORKSPACE}/main.py", run_name="__main__")
finally:
    # Even a failed run may have produced something worth keeping.
    emit()
'''


class DockerSandbox:
    """Runs one snippet in a locked-down, disposable container."""

    name = "docker"

    def __init__(self, image: str = SANDBOX_IMAGE) -> None:
        self.image = image
        self._client = None
        self._last_error = ""

    # --- availability -----------------------------------------------------

    def _connect(self):
        if self._client is not None:
            return self._client
        try:
            import docker

            client = docker.from_env()
            client.ping()
        except Exception as exc:
            self._last_error = f"{type(exc).__name__}: {exc}"
            return None
        self._client = client
        return client

    def available(self) -> tuple[bool, str]:
        client = self._connect()
        if client is None:
            return False, f"Docker is not reachable ({self._last_error})"
        try:
            client.images.get(self.image)
        except Exception:
            return False, (
                f"sandbox image {self.image} is not pulled: "
                f"run `docker pull {self.image}`"
            )
        return True, f"{self.image} ready"

    # --- execution --------------------------------------------------------

    def run(self, request: SandboxRequest) -> SandboxResult:
        if request.language != "python":
            return SandboxResult(
                exit_code=-1,
                stdout="",
                stderr="",
                duration_ms=0,
                status="unavailable",
                detail=f"no runner for language {request.language!r}",
            )

        ready, detail = self.available()
        if not ready:
            return SandboxResult(
                exit_code=-1,
                stdout="",
                stderr="",
                duration_ms=0,
                status="unavailable",
                detail=detail,
            )

        seeded = {_safe_name(name): payload for name, payload in request.files.items()}
        try:
            bundle = self._bundle(request.code, seeded)
        except ValueError as exc:
            return SandboxResult(
                exit_code=-1,
                stdout="",
                stderr="",
                duration_ms=0,
                status="failed",
                detail=str(exc),
            )

        marker = f"---sandbox-{uuid.uuid4().hex}---"
        client = self._connect()
        container = None
        started = time.perf_counter()

        try:
            container = client.containers.create(
                self.image,
                command=[
                    "python",
                    "-I",
                    "-B",
                    "-c",
                    BOOTSTRAP,
                    bundle,
                    marker,
                    "|".join(["main.py", *sorted(seeded)]),
                ],
                working_dir=WORKSPACE,
                # The whole point. No interface, so no exfiltration path.
                network_mode="none",
                read_only=True,
                tmpfs={WORKSPACE: f"rw,size={request.memory_mb}m,mode=1777"},
                mem_limit=f"{request.memory_mb}m",
                # Docker takes CPU quota against a 100 ms period.
                cpu_period=100_000,
                cpu_quota=int(request.cpus * 100_000),
                pids_limit=128,
                user="65534:65534",  # nobody
                security_opt=["no-new-privileges:true"],
                cap_drop=["ALL"],
                environment={
                    "HOME": WORKSPACE,
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONUNBUFFERED": "1",
                },
                detach=True,
            )

            container.start()

            try:
                outcome = container.wait(timeout=request.timeout_s)
                exit_code = int(outcome.get("StatusCode", -1))
                status = "ok"
                detail = ""
            except Exception:
                # wait() raises on timeout. Kill rather than wait politely:
                # the code has already had its whole budget.
                self._kill(container)
                exit_code = -1
                status = "timeout"
                detail = f"exceeded {request.timeout_s}s and was killed"

            raw_stdout = self._logs(container, stdout=True)
            stderr = self._logs(container, stdout=False)
            stdout, produced = self._split_output(raw_stdout, marker)

            return SandboxResult(
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
                duration_ms=int((time.perf_counter() - started) * 1000),
                produced=produced,
                status=status,
                detail=detail,
            )

        except Exception as exc:
            logger.warning("sandbox run failed: %s", exc)
            return SandboxResult(
                exit_code=-1,
                stdout="",
                stderr="",
                duration_ms=int((time.perf_counter() - started) * 1000),
                status="failed",
                detail=f"{type(exc).__name__}: {exc}",
            )
        finally:
            if container is not None:
                self._remove(container)

    # --- file transfer ----------------------------------------------------

    def _bundle(self, code: str, seeded: dict[str, bytes]) -> str:
        """Pack the code and its inputs into the base64 tar passed as an arg."""
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as tar:
            self._add(tar, "main.py", code.encode("utf-8"))
            for name, payload in seeded.items():
                self._add(tar, name, payload)

        encoded = base64.b64encode(archive.getvalue()).decode("ascii")
        if len(encoded) > MAX_PAYLOAD_BYTES:
            raise ValueError(
                f"the code and its input files come to {len(encoded)} bytes "
                f"encoded, over the {MAX_PAYLOAD_BYTES} byte sandbox limit"
            )
        return encoded

    @staticmethod
    def _add(tar: tarfile.TarFile, name: str, payload: bytes) -> None:
        info = tarfile.TarInfo(name=name)
        info.size = len(payload)
        info.mode = 0o644
        tar.addfile(info, io.BytesIO(payload))

    @staticmethod
    def _split_output(raw: str, marker: str) -> tuple[str, dict[str, bytes]]:
        """Separate the program's own stdout from the files it produced.

        The marker is generated per run, so nothing the program prints can be
        mistaken for the boundary by accident.
        """
        if marker not in raw:
            return raw, {}

        stdout, _, encoded = raw.partition(marker)
        produced: dict[str, bytes] = {}
        try:
            archive = io.BytesIO(base64.b64decode(encoded.strip()))
            with tarfile.open(fileobj=archive, mode="r") as tar:
                for member in tar.getmembers():
                    if not member.isfile() or member.size > MAX_PRODUCED_BYTES:
                        continue
                    handle = tar.extractfile(member)
                    if handle is not None:
                        produced[_safe_name(member.name)] = handle.read()
        except Exception as exc:
            logger.debug("could not decode produced files: %s", exc)

        return stdout.rstrip("\n"), produced

    # --- teardown ---------------------------------------------------------

    @staticmethod
    def _logs(container, *, stdout: bool) -> str:
        try:
            raw = container.logs(stdout=stdout, stderr=not stdout)
        except Exception:
            return ""
        text = raw.decode("utf-8", errors="replace")
        # Bounded: a loop printing forever must not become a database row.
        return text if len(text) <= 64_000 else text[:64_000] + "\n[truncated]"

    @staticmethod
    def _kill(container) -> None:
        try:
            container.kill()
        except Exception:
            logger.debug("sandbox container was already gone")

    @staticmethod
    def _remove(container) -> None:
        try:
            container.remove(force=True, v=True)
        except Exception:
            logger.debug("sandbox container could not be removed")


def _safe_name(name: str) -> str:
    """Reduce a caller-supplied name to a harmless basename."""
    cleaned = name.replace("\\", "/").split("/")[-1].strip()
    return cleaned or "input.dat"


docker_sandbox = DockerSandbox()
