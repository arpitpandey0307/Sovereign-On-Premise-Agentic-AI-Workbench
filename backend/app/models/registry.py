"""The model registry: what exists, what it costs, and whether it is ready.

Seeding is hardware-aware -- the catalogue chosen depends on the GPU actually
present -- and reconciliation marks each row ``ready`` or ``unavailable`` by
asking the runtime what it really has, so the router never routes to a model
that was never pulled.
"""

from __future__ import annotations

import logging
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.model_registry import ModelRecord, ModelStat
from app.models.catalog import catalogue_for, tier_for_vram
from app.routing.hardware import hardware
from app.schemas.shared import ModelDescriptor

logger = logging.getLogger("workbench.registry")


def to_descriptor(record: ModelRecord) -> ModelDescriptor:
    """The cross-part view. Parts 04 and 05 see only this."""
    return ModelDescriptor(
        model_id=record.id,
        type=record.type,
        capabilities=list(record.capabilities or []),
        context_length=record.context_length,
        vram_required_gb=record.effective_vram_gb,
        approved_for=list(record.approved_classifications or []),
        status=record.status if record.status in {"ready", "loading"} else "unavailable",
    )


class ModelRegistry:
    def __init__(self, db: Session) -> None:
        self.db = db

    # --- reads ------------------------------------------------------------

    def all(self) -> list[ModelRecord]:
        return list(self.db.scalars(select(ModelRecord).order_by(ModelRecord.id)))

    def get(self, model_id: str) -> ModelRecord | None:
        return self.db.get(ModelRecord, model_id)

    def ready(self) -> list[ModelRecord]:
        return list(
            self.db.scalars(select(ModelRecord).where(ModelRecord.status == "ready"))
        )

    def of_type(self, model_type: str) -> list[ModelRecord]:
        return list(
            self.db.scalars(select(ModelRecord).where(ModelRecord.type == model_type))
        )

    # --- seeding ----------------------------------------------------------

    def seed(self) -> int:
        """Install the catalogue matching this machine. Idempotent.

        Existing rows are left alone apart from static metadata, so measured
        VRAM and accumulated scores survive a restart.
        """
        gpu = hardware.state(refresh=True)
        entries = catalogue_for(gpu.total_vram_gb)
        logger.info(
            "seeding %s catalogue for %s (%.1f GB VRAM)",
            tier_for_vram(gpu.total_vram_gb),
            gpu.name,
            gpu.total_vram_gb,
        )

        added = 0
        for entry in entries:
            record = self.db.get(ModelRecord, entry["id"])
            if record is None:
                record = ModelRecord(id=entry["id"], status="unavailable")
                self.db.add(record)
                added += 1

            record.name = entry["name"]
            record.provider = entry["provider"]
            record.model_identifier = entry["model_identifier"]
            record.type = entry["type"]
            record.capabilities = entry["capabilities"]
            record.context_length = entry["context_length"]
            record.quantization = entry["quantization"]
            record.vram_required_gb = entry["vram_required_gb"]
            record.supported_modalities = entry["supported_modalities"]
            record.benchmark_score = entry["benchmark_score"]
            record.latency_score = entry["latency_score"]
            record.reliability_score = entry["reliability_score"]
            record.notes = entry["notes"]

        self.db.commit()
        return added

    # --- reconciliation ---------------------------------------------------

    def reconcile(self, present_identifiers: set[str]) -> dict[str, str]:
        """Mark models ready or unavailable against what the runtime holds.

        Ollama tags carry an explicit tag (``qwen3:8b``) and sometimes a
        ``:latest`` suffix, so matching is done on both forms.
        """
        normalised = {identifier.split(":")[0] for identifier in present_identifiers}
        outcome: dict[str, str] = {}

        for record in self.all():
            identifier = record.model_identifier
            available = (
                identifier in present_identifiers
                or f"{identifier}:latest" in present_identifiers
                or identifier.split(":")[0] in normalised
            )
            record.status = "ready" if available else "unavailable"
            record.status_detail = (
                "present in local runtime"
                if available
                else f"not pulled: run `ollama pull {identifier}`"
            )
            outcome[record.id] = record.status

        self.db.commit()
        return outcome

    def set_status(self, model_id: str, status: str, detail: str = "") -> None:
        record = self.get(model_id)
        if record is None:
            return
        record.status = status
        record.status_detail = detail
        self.db.commit()

    def set_approved_classifications(
        self, model_id: str, classifications: list[str]
    ) -> None:
        """Written from Part 05's rules. Part 02 stores, it does not decide."""
        record = self.get(model_id)
        if record is None:
            return
        record.approved_classifications = classifications
        self.db.commit()

    # --- statistics -------------------------------------------------------

    def stat(self, model_id: str, task_type: str) -> ModelStat:
        existing = self.db.scalar(
            select(ModelStat).where(
                ModelStat.model_id == model_id, ModelStat.task_type == task_type
            )
        )
        if existing is not None:
            return existing

        created = ModelStat(id=uuid4(), model_id=model_id, task_type=task_type)
        self.db.add(created)
        self.db.commit()
        self.db.refresh(created)
        return created

    def stats_for(self, model_id: str) -> list[ModelStat]:
        return list(
            self.db.scalars(select(ModelStat).where(ModelStat.model_id == model_id))
        )
