"""Part 02's implementation of the ``ModelPort`` Part 01 declared.

Registering this at startup replaces the placeholder probe with the real
registry, so ``/health`` and ``/api/v1/models`` stop reporting a stub.
"""

from __future__ import annotations

from app.db.database import SessionLocal
from app.models.service import model_service
from app.routing.hardware import hardware
from app.schemas.shared import ModelDescriptor


class ModelLayer:
    """The narrow view Part 01 needs. Part 04 uses ``ModelService`` directly."""

    def available_models(self) -> list[ModelDescriptor]:
        with SessionLocal() as db:
            return model_service.descriptors(db)

    async def health(self) -> tuple[bool, str]:
        with SessionLocal() as db:
            report = await model_service.health(db)

        runtimes = report["runtimes"]
        reachable = any(runtime["reachable"] for runtime in runtimes.values())
        summary = report["summary"]
        gpu = hardware.state()

        if not reachable:
            return False, "no local model runtime is reachable"

        where = f"on {gpu.name}" if gpu.present else "(CPU)"
        detail = f"{summary['ready']}/{summary['registered']} models ready {where}"
        if summary["ready"] == 0:
            return False, f"runtime up but no catalogue model is pulled ({detail})"
        return True, detail


def install() -> None:
    """Swap the placeholder for the real model layer."""
    from app.integrations import registry

    registry.register_models(ModelLayer())
