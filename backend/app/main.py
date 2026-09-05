"""Application entry point for the Sovereign AI Workbench backend.

All five parts ship inside this one FastAPI process for the MVP -- a modular
monolith, not five services. Parts 02-05 attach by registering their
implementations of the ports in ``app/integrations/registry.py``.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import knowledge as knowledge_api
from app.api import models as models_api
from app.api import orchestration as orchestration_api
from app.api.router import api_router
from app.core.config import settings
from app.core.dependencies import require
from app.core.errors import register_exception_handlers
from app.core.events import event_bus
from app.db.database import SessionLocal, init_db
from app.db.models import User
from app.db.repositories.users import UserRepository
from app.documents import port as documents_port
from app.integrations import registry
from app.models import port as model_port
from app.models.service import model_service
from app.orchestration import executor as orchestration

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("workbench")

SystemReader = Annotated[User, Depends(require("system", "read"))]


def _bootstrap() -> None:
    init_db()
    with SessionLocal() as db:
        repo = UserRepository(db)
        repo.seed_roles()

        seeded = repo.get_by_email(settings.seed_admin_email)
        # The demo password is published in the repository README. Creating
        # that account on a non-development instance would be handing out a
        # known credential, so it is refused rather than warned about.
        default_password = settings.seed_admin_password == "workbench"
        if settings.seed_demo_user and default_password and not settings.debug:
            logger.error(
                "Refusing to seed %s: the default demo password is public. "
                "Set SEED_ADMIN_PASSWORD, or SEED_DEMO_USER=false.",
                settings.seed_admin_email,
            )
        elif settings.seed_demo_user and seeded is None:
            repo.create(
                email=settings.seed_admin_email,
                name="Workbench Admin",
                password=settings.seed_admin_password,
                roles=["ADMIN", "ENGINEER"],
            )
            logger.info("Seeded demo account %s", settings.seed_admin_email)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _bootstrap()

    # Part 02 takes over the model port, then seeds its catalogue against
    # the GPU actually present and reconciles it with the live runtime.
    model_port.install()
    # Part 03 takes over ingestion and retrieval. It is installed after the
    # model layer because embedding routes through it.
    documents_port.install()
    # Part 04 registers the tools, the orchestrator and the artifact store.
    # Last, because its tools call into Parts 02 and 03.
    orchestration.install()
    if settings.refresh_model_registry_on_startup:
        with SessionLocal() as db:
            statuses = await model_service.refresh_registry(db)
        ready = [name for name, state in statuses.items() if state == "ready"]
        logger.info(
            "model registry: %d/%d ready (%s)",
            len(ready),
            len(statuses),
            ", ".join(ready) or "none pulled",
        )

    pending = [
        name
        for name, port in (
            ("models (Part 02)", registry.get_models()),
            ("policy (Part 05)", registry.get_policy()),
            ("audit (Part 05)", registry.get_audit()),
            ("documents (Part 03)", registry.get_documents()),
            ("knowledge (Part 03)", registry.get_knowledge()),
            ("orchestrator (Part 04)", registry.get_orchestrator()),
            ("artifacts (Part 04)", registry.get_artifacts()),
        )
        if registry.using_stub(port)
    ]
    if pending:
        logger.warning("Running against stub implementations of: %s", ", ".join(pending))

    yield


app = FastAPI(
    title=settings.app_name,
    description=(
        "Self-hosted agentic AI workbench for confidential industrial work. "
        "No component in this system makes an external network call."
    ),
    version="0.1.0",
    lifespan=lifespan,
    # The schema names every route, including operational ones. Publishing it
    # to anonymous callers hands an attacker the map, so it is opt-in.
    docs_url="/docs" if settings.enable_api_docs else None,
    redoc_url="/redoc" if settings.enable_api_docs else None,
    openapi_url="/openapi.json" if settings.enable_api_docs else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_exception_handlers(app)
app.include_router(api_router)
app.include_router(models_api.router)
app.include_router(knowledge_api.router)
app.include_router(orchestration_api.router)


def _part_status(port: object) -> str:
    return "stub" if registry.using_stub(port) else "live"


@app.get("/health", tags=["system"])
def health() -> dict:
    """Liveness only.

    Deliberately says nothing about hardware, model names, or which parts are
    wired: this is the one route an unauthenticated caller can reach, and a
    liveness probe has no need to describe the system it is probing. The
    detail lives behind auth on ``/api/v1/system/status``.
    """
    return {"status": "ok"}


@app.get("/api/v1/system/status", tags=["system"])
async def system_status(user: SystemReader) -> dict:
    """The detailed picture, for operators."""
    reachable, detail = await registry.get_models().health()
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": app.version,
        "external_network_allowed": settings.allow_external_network,
        "model_runtime": {"reachable": reachable, "detail": detail},
        "event_buffers_retained": event_bus.retained_tasks(),
        "parts": {
            "01_foundation": "live",
            "02_model_layer": _part_status(registry.get_models()),
            "03_documents": _part_status(registry.get_documents()),
            "04_orchestration": _part_status(registry.get_orchestrator()),
            "05_security_audit": _part_status(registry.get_policy()),
        },
    }


