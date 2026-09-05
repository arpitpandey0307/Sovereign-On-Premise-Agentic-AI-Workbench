"""Network sovereignty: proving no external call is made, rather than claiming it.

The problem statement asks for proof "through logs or a visible network
monitor, that no external calls are made at any point". A label reading
"100% private" proves nothing, so this observes what the process actually
does.

The observation point is CPython's own audit hook (`sys.addaudithook`). Every
`socket.connect` and every `socket.getaddrinfo` raises an audit event before
it happens, from inside the interpreter -- below `httpx`, below `requests`,
below anything a dependency might reach for. A library cannot avoid it by
using a different HTTP client, because the event fires at the socket layer.

That gives the monitor a property a firewall log does not have: it names the
*attempt*, in-process, with the task that was running at the time. Both are
worth having, and the two are complementary:

    in-process monitor   what this application tried to do
    Docker network       what any container is physically able to do
    sandbox (no NIC)     what model-written code is able to do

A hook cannot be uninstalled once added, which is the right property here: a
monitor that could be turned off mid-task would prove nothing about the rest
of the task.

What is *not* claimed: this observes this process. Another process on the host
is outside its view, which is what the network-level controls are for.
"""

from __future__ import annotations

import ipaddress
import logging
import sys
import threading
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

logger = logging.getLogger("workbench.sovereignty")

# The task a connection was attempted during, so an external attempt can be
# attributed rather than merely counted. A ContextVar rather than a global
# because requests are concurrent.
current_task: ContextVar[UUID | None] = ContextVar("current_task", default=None)

# Hostnames that are the local machine by definition.
LOCAL_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "host.docker.internal",
    "gateway.docker.internal",
}

# Compose service names this system legitimately talks to. They resolve inside
# the Docker network and never leave it.
LOCAL_SERVICE_NAMES = {"postgres", "neo4j", "ollama", "vllm", "minio", "api"}

MAX_RECENT = 200


@dataclass
class EgressSnapshot:
    """What the dashboard widget shows, backed by real counts."""

    external_connections: int = 0
    external_dns: int = 0
    local_connections: int = 0
    local_dns: int = 0
    monitoring: bool = False
    started_at: datetime | None = None
    recent_external: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "external_requests": self.external_connections + self.external_dns,
            "external_connections": self.external_connections,
            "external_dns_queries": self.external_dns,
            "local_connections": self.local_connections,
            "local_dns_queries": self.local_dns,
            "network_egress": (
                "BLOCKED" if self.external_connections == 0 else "BREACHED"
            ),
            "monitoring": self.monitoring,
            "monitoring_since": (
                self.started_at.isoformat() if self.started_at else None
            ),
            "recent_external": self.recent_external,
        }


def is_local(host: str) -> bool:
    """Whether an address is this machine or the compose network.

    Anything that is not provably local is treated as external. A monitor that
    guessed in the permissive direction would report a clean sheet it had not
    earned.
    """
    if not host:
        return False

    candidate = host.strip().strip("[]").lower()
    if candidate in LOCAL_HOSTNAMES or candidate in LOCAL_SERVICE_NAMES:
        return True

    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        # A name that is not a known-local service. Unresolved names are the
        # interesting case, so they count as external.
        return False

    return bool(
        address.is_loopback
        or address.is_private
        or address.is_link_local
        or address.is_unspecified
    )


class EgressMonitor:
    """Counts, classifies and records every outbound attempt this process makes."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._external_connections = 0
        self._external_dns = 0
        self._local_connections = 0
        self._local_dns = 0
        self._recent: list[dict] = []
        self._installed = False
        self._started_at: datetime | None = None
        # Set while the monitor is writing its own row, so the database
        # connection that write needs cannot recurse back into the hook.
        self._recording = threading.local()

    # --- installation -----------------------------------------------------

    def install(self) -> bool:
        """Attach the audit hook. Idempotent; cannot be undone by design."""
        if self._installed:
            return False
        sys.addaudithook(self._hook)
        self._installed = True
        self._started_at = datetime.now(UTC)
        logger.info("network egress monitor active")
        return True

    def _hook(self, event: str, args: tuple) -> None:
        # Must never raise: an exception here would propagate into whatever
        # the process was doing, and a monitor that breaks the thing it
        # watches is worse than no monitor.
        try:
            if event == "socket.connect":
                self._on_connect(args)
            elif event == "socket.getaddrinfo":
                self._on_dns(args)
        except Exception:  # noqa: BLE001 - see above
            pass

    # --- observation ------------------------------------------------------

    def _on_connect(self, args: tuple) -> None:
        address = args[1] if len(args) > 1 else None
        host, port = _unpack(address)
        if host is None:
            return  # a unix socket or something with no address to judge

        if is_local(host):
            with self._lock:
                self._local_connections += 1
            return

        self._flag("connect", host, port)

    def _on_dns(self, args: tuple) -> None:
        host = args[0] if args else None
        if isinstance(host, bytes):
            host = host.decode("utf-8", errors="replace")
        if not isinstance(host, str):
            return

        if is_local(host):
            with self._lock:
                self._local_dns += 1
            return

        port = args[1] if len(args) > 1 and isinstance(args[1], int) else 0
        self._flag("dns", host, port)

    def _flag(self, kind: str, host: str, port: int) -> None:
        """Record an external attempt loudly. This should never happen."""
        task_id = current_task.get()
        entry = {
            "kind": kind,
            "host": host,
            "port": port,
            "task_id": str(task_id) if task_id else None,
            "at": datetime.now(UTC).isoformat(),
        }

        with self._lock:
            if kind == "connect":
                self._external_connections += 1
            else:
                self._external_dns += 1
            self._recent.append(entry)
            del self._recent[:-MAX_RECENT]

        logger.warning(
            "EXTERNAL NETWORK ATTEMPT: %s %s:%s during task %s",
            kind,
            host,
            port,
            task_id,
        )
        self._persist(kind, host, port, task_id)

    def _persist(self, kind: str, host: str, port: int, task_id: UUID | None) -> None:
        """Write the attempt to the ledger, guarding against recursion.

        Persisting opens a database connection, which is itself a socket
        connect -- straight back into this hook. The guard is what stops one
        external attempt becoming an unbounded loop.
        """
        if getattr(self._recording, "busy", False):
            return
        self._recording.busy = True
        try:
            from app.db.database import SessionLocal
            from app.db.models.audit import NetworkEvent

            with SessionLocal() as db:
                db.add(
                    NetworkEvent(
                        task_id=task_id,
                        host=host[:255],
                        port=port,
                        kind=kind,
                        scope="external",
                        detail="observed by the in-process egress monitor",
                    )
                )
                db.commit()
        except Exception as exc:  # noqa: BLE001
            logger.error("could not record external network attempt: %s", exc)
        finally:
            self._recording.busy = False

    # --- reporting --------------------------------------------------------

    def snapshot(self) -> EgressSnapshot:
        with self._lock:
            return EgressSnapshot(
                external_connections=self._external_connections,
                external_dns=self._external_dns,
                local_connections=self._local_connections,
                local_dns=self._local_dns,
                monitoring=self._installed,
                started_at=self._started_at,
                recent_external=list(self._recent[-20:]),
            )

    def reset(self) -> None:
        """Zero the counters. Test support only; never exposed over HTTP."""
        with self._lock:
            self._external_connections = 0
            self._external_dns = 0
            self._local_connections = 0
            self._local_dns = 0
            self._recent.clear()


def _unpack(address: object) -> tuple[str | None, int]:
    """Pull host and port out of the many shapes a sockaddr takes."""
    if isinstance(address, tuple) and address:
        host = address[0]
        if isinstance(host, bytes):
            host = host.decode("utf-8", errors="replace")
        port = address[1] if len(address) > 1 and isinstance(address[1], int) else 0
        return (host if isinstance(host, str) else None), port
    return None, 0


egress_monitor = EgressMonitor()
