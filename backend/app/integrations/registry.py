"""Single swap point between Part 01 and the parts it depends on.

When Part 03/04/05 land, they call ``register_*`` at startup and every
endpoint picks up the real implementation with no other code change.
"""

from __future__ import annotations

from app.integrations import stubs
from app.integrations.ports import (
    ArtifactsPort,
    AuditPort,
    DocumentsPort,
    ModelPort,
    OrchestratorPort,
    PolicyPort,
)

_policy: PolicyPort = stubs.PermissivePolicy()
_audit: AuditPort = stubs.InMemoryAudit()
_documents: DocumentsPort = stubs.NoopDocuments()
_orchestrator: OrchestratorPort = stubs.EchoOrchestrator()
_artifacts: ArtifactsPort = stubs.EmptyArtifacts()
_models: ModelPort = stubs.LocalOllamaProbe()


def get_policy() -> PolicyPort:
    return _policy


def get_audit() -> AuditPort:
    return _audit


def get_documents() -> DocumentsPort:
    return _documents


def get_orchestrator() -> OrchestratorPort:
    return _orchestrator


def get_artifacts() -> ArtifactsPort:
    return _artifacts


def get_models() -> ModelPort:
    return _models


def register_policy(impl: PolicyPort) -> None:
    global _policy
    _policy = impl


def register_audit(impl: AuditPort) -> None:
    global _audit
    _audit = impl


def register_documents(impl: DocumentsPort) -> None:
    global _documents
    _documents = impl


def register_orchestrator(impl: OrchestratorPort) -> None:
    global _orchestrator
    _orchestrator = impl


def register_artifacts(impl: ArtifactsPort) -> None:
    global _artifacts
    _artifacts = impl


def register_models(impl: ModelPort) -> None:
    global _models
    _models = impl


def using_stub(port: object) -> bool:
    """True while a port is still served by its placeholder."""
    return port.__class__.__module__ == stubs.__name__
