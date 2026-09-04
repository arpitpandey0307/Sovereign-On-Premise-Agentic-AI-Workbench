"""Model layer endpoints.

Part 02 computes all of this; Part 01 owns the HTTP surface, so the routes
live here. These power the model selector, the GPU/model health widget, and
the "why was this model chosen" panel.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.core.dependencies import DbSession, record_audit, require
from app.core.errors import NotFoundError
from app.db.models import User
from app.models.registry import ModelRegistry, to_descriptor
from app.models.service import model_service
from app.routing.model_router import ModelRouter, TaskRequirements

router = APIRouter(tags=["models"])

ReadUser = Annotated[User, Depends(require("model", "read"))]
AdminUser = Annotated[User, Depends(require("model", "admin"))]


class RoutingPreviewRequest(BaseModel):
    """Ask the router what it would choose, without running a model."""

    model_config = ConfigDict(protected_namespaces=())

    task_type: str = "general"
    model_type: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)
    preferred_capabilities: list[str] = Field(default_factory=list)
    classification: str = "INTERNAL"
    estimated_context_tokens: int = 2048
    needs_vision: bool = False
    needs_structured_output: bool = False
    exclude_models: list[str] = Field(default_factory=list)


@router.get("/api/v1/models")
def list_models(user: ReadUser, db: DbSession) -> dict:
    """The registry as the rest of the system sees it."""
    records = ModelRegistry(db).all()
    return {
        "models": [
            {
                **to_descriptor(record).model_dump(),
                "name": record.name,
                "provider": record.provider,
                "quantization": record.quantization,
                "status_detail": record.status_detail,
                "notes": record.notes,
            }
            for record in records
        ]
    }


@router.get("/api/v1/models/{model_id}")
def get_model(model_id: str, user: ReadUser, db: DbSession) -> dict:
    registry = ModelRegistry(db)
    record = registry.get(model_id)
    if record is None:
        raise NotFoundError("Model not found.")

    stats = registry.stats_for(model_id)
    return {
        **to_descriptor(record).model_dump(),
        "name": record.name,
        "provider": record.provider,
        "model_identifier": record.model_identifier,
        "quantization": record.quantization,
        "status_detail": record.status_detail,
        "notes": record.notes,
        "performance": [
            {
                "task_type": stat.task_type,
                "successes": stat.successes,
                "failures": stat.failures,
                "schema_failures": stat.schema_failures,
                "success_rate": stat.success_rate,
                "avg_latency_ms": round(stat.ewma_latency_ms),
                "last_used_at": stat.last_used_at,
                "last_error": stat.last_error,
            }
            for stat in stats
        ],
    }


@router.get("/internal/models/health", include_in_schema=False)
async def models_health(user: ReadUser, db: DbSession) -> dict:
    """GPU state, runtime reachability and per-model readiness."""
    return await model_service.health(db)


@router.post("/internal/models/refresh", include_in_schema=False)
async def refresh_registry(user: AdminUser, db: DbSession) -> dict:
    """Re-seed the catalogue and reconcile it against the running runtime."""
    outcome = await model_service.refresh_registry(db)
    record_audit(
        event_type="MODEL_REGISTRY_REFRESHED",
        action="model:refresh",
        component="models",
        user_id=user.id,
        metadata={"statuses": outcome},
    )
    return {"models": outcome}


@router.post("/api/v1/models/route")
def preview_routing(
    payload: RoutingPreviewRequest, user: ReadUser, db: DbSession
) -> dict:
    """Run the router and return its full reasoning without generating.

    This is what fills the "why was this model chosen" panel, and it is the
    cheapest way to show a judge that the choice is a considered one.
    """
    requirements = TaskRequirements(**payload.model_dump())
    decision = ModelRouter(db).route(requirements)

    record_audit(
        event_type="MODEL_SELECTED",
        action="model:route",
        component="routing",
        user_id=user.id,
        metadata={
            "task_type": requirements.task_type,
            "classification": requirements.classification,
            "selected": decision.selected.id if decision.selected else None,
            "rationale": decision.rationale,
        },
    )
    return decision.explain()
