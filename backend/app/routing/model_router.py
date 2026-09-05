"""The model router.

Three stages, in this order, and the order is the point:

    capability filter  ->  policy filter (Part 05)  ->  hardware fit  ->  score

Capability first because a model that cannot do the job is not a candidate at
any price. Security second because a model that is not cleared for the data is
not a candidate however good it is -- quality never overrides classification.
Hardware third because a model that will not load is not a candidate either.
Only what survives all three gets ranked.

Every decision carries its rationale: which models were considered, why each
was excluded, the full score breakdown for the survivors, and a fallback chain
to use if the winner fails at generation time.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.db.models.model_registry import ModelRecord
from app.models.registry import ModelRegistry, to_descriptor
from app.routing import policies
from app.routing.hardware import GpuState, hardware
from app.routing.scoring import ScoreCard, score_model
from app.schemas.shared import ModelDescriptor

logger = logging.getLogger("workbench.router")


class TaskRequirements(BaseModel):
    """What Part 04 asks for. Everything has a default so a bare ask works."""

    model_config = ConfigDict(protected_namespaces=())

    task_type: str = "general"
    model_type: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)
    preferred_capabilities: list[str] = Field(default_factory=list)
    classification: str = "INTERNAL"
    estimated_context_tokens: int = 2048
    needs_vision: bool = False
    needs_structured_output: bool = False
    # Set when re-routing after a failure, so the router does not hand back
    # the model that just failed.
    exclude_models: list[str] = Field(default_factory=list)

    def resolved_required(self) -> set[str]:
        """Capabilities implied by the request as well as those stated."""
        required = set(self.required_capabilities)
        if self.needs_vision:
            required.add("vision")
        if self.needs_structured_output:
            required.add("structured_output")
        return required

    def resolved_model_type(self) -> str | None:
        if self.model_type:
            return self.model_type
        if self.needs_vision:
            return "vision"
        return None


@dataclass
class Rejection:
    model_id: str
    stage: str
    reason: str


@dataclass
class RoutingDecision:
    """A routing result and the complete reasoning behind it."""

    selected: ModelRecord | None
    requirements: TaskRequirements
    gpu: GpuState
    scorecards: list[ScoreCard] = field(default_factory=list)
    rejections: list[Rejection] = field(default_factory=list)
    fallbacks: list[str] = field(default_factory=list)
    considered: int = 0

    @property
    def succeeded(self) -> bool:
        return self.selected is not None

    @property
    def rationale(self) -> str:
        if self.selected is None:
            return self.failure_reason
        winner = next(
            (card for card in self.scorecards if card.model_id == self.selected.id), None
        )
        detail = f" -- {winner.summary}" if winner else ""
        runner_up = ""
        if len(self.scorecards) > 1:
            second = self.scorecards[1]
            margin = self.scorecards[0].total - second.total
            runner_up = f"; chosen over {second.model_id} by {margin:.3f}"
        return f"Selected {self.selected.name}{detail}{runner_up}"

    @property
    def failure_reason(self) -> str:
        if self.considered == 0:
            return "No models are registered."
        by_stage: dict[str, int] = {}
        for rejection in self.rejections:
            by_stage[rejection.stage] = by_stage.get(rejection.stage, 0) + 1
        breakdown = ", ".join(
            f"{count} on {stage}" for stage, count in by_stage.items()
        )
        return (
            f"No model satisfied the request "
            f"({self.considered} considered: {breakdown})."
        )

    def explain(self) -> dict:
        """The payload behind the frontend's 'why this model' panel."""
        return {
            "selected": to_descriptor(self.selected).model_dump()
            if self.selected
            else None,
            "rationale": self.rationale,
            "requirements": self.requirements.model_dump(),
            "hardware": {
                "gpu": self.gpu.name,
                "present": self.gpu.present,
                "total_vram_gb": self.gpu.total_vram_gb,
                "free_vram_gb": round(self.gpu.free_vram_gb, 2),
                "usable_vram_gb": round(self.gpu.usable_vram_gb, 2),
                "pressure": round(self.gpu.pressure, 2),
            },
            "considered": self.considered,
            "ranked": [card.as_dict() for card in self.scorecards],
            "rejected": [
                {"model_id": r.model_id, "stage": r.stage, "reason": r.reason}
                for r in self.rejections
            ],
            "fallback_chain": self.fallbacks,
        }


class ModelRouter:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.registry = ModelRegistry(db)

    def route(self, requirements: TaskRequirements) -> RoutingDecision:
        gpu = hardware.state()
        candidates = self.registry.all()
        decision = RoutingDecision(
            selected=None,
            requirements=requirements,
            gpu=gpu,
            considered=len(candidates),
        )

        candidates = self._stage_capability(candidates, requirements, decision)
        candidates = self._stage_policy(candidates, requirements, decision)
        candidates = self._stage_hardware(candidates, gpu, decision)

        if not candidates:
            logger.warning("routing failed: %s", decision.failure_reason)
            return decision

        cards = [
            score_model(
                record,
                requirements,
                gpu,
                self.registry.stat(record.id, requirements.task_type),
            )
            for record in candidates
        ]
        # Ties break toward the smaller model: the spec's "smallest sufficient
        # model" principle, applied where the scores cannot separate them.
        by_id = {record.id: record for record in candidates}
        cards.sort(
            key=lambda card: (
                -round(card.total, 4),
                by_id[card.model_id].effective_vram_gb,
            )
        )

        decision.scorecards = cards
        decision.selected = by_id[cards[0].model_id]
        decision.fallbacks = [card.model_id for card in cards[1:4]]

        logger.info(
            "routed %s -> %s (%.3f)",
            requirements.task_type,
            decision.selected.id,
            cards[0].total,
        )
        return decision

    # --- stages -----------------------------------------------------------

    def _stage_capability(
        self,
        records: list[ModelRecord],
        requirements: TaskRequirements,
        decision: RoutingDecision,
    ) -> list[ModelRecord]:
        required = requirements.resolved_required()
        wanted_type = requirements.resolved_model_type()
        survivors = []

        for record in records:
            owned = set(record.capabilities or [])

            if record.id in requirements.exclude_models:
                decision.rejections.append(
                    Rejection(
                        record.id, "capability", "excluded by caller after a failure"
                    )
                )
                continue

            missing = required - owned
            if missing:
                decision.rejections.append(
                    Rejection(
                        record.id,
                        "capability",
                        f"missing {', '.join(sorted(missing))}",
                    )
                )
                continue

            if requirements.needs_vision and "image" not in (
                record.supported_modalities or []
            ):
                decision.rejections.append(
                    Rejection(record.id, "capability", "cannot accept image input")
                )
                continue

            # An embedding model is never a substitute for a generative one.
            is_embedding = record.type == "embedding"
            if wanted_type and is_embedding and wanted_type != "embedding":
                decision.rejections.append(
                    Rejection(record.id, "capability", "embedding model, not generative")
                )
                continue

            if requirements.estimated_context_tokens > record.context_length:
                decision.rejections.append(
                    Rejection(
                        record.id,
                        "capability",
                        f"context window {record.context_length} < "
                        f"{requirements.estimated_context_tokens} needed",
                    )
                )
                continue

            survivors.append(record)

        return survivors

    def _stage_policy(
        self,
        records: list[ModelRecord],
        requirements: TaskRequirements,
        decision: RoutingDecision,
    ) -> list[ModelRecord]:
        local_only = []
        for record in records:
            if policies.is_local(record):
                local_only.append(record)
            else:
                decision.rejections.append(
                    Rejection(
                        record.id,
                        "policy",
                        "non-local provider: barred on an air-gapped system",
                    )
                )

        allowed, rejected = policies.filter_models(
            local_only, requirements.classification
        )
        for model_id, reason in rejected.items():
            decision.rejections.append(Rejection(model_id, "policy", reason))
        return allowed

    def _stage_hardware(
        self,
        records: list[ModelRecord],
        gpu: GpuState,
        decision: RoutingDecision,
    ) -> list[ModelRecord]:
        survivors = []
        for record in records:
            if record.status != "ready":
                decision.rejections.append(
                    Rejection(
                        record.id,
                        "hardware",
                        record.status_detail or f"status is {record.status}",
                    )
                )
                continue

            required = record.effective_vram_gb

            # No GPU: only models that declare no VRAM need can run.
            if not gpu.present:
                if required > 0:
                    decision.rejections.append(
                        Rejection(record.id, "hardware", "no GPU present")
                    )
                    continue
                survivors.append(record)
                continue

            if required > gpu.usable_vram_gb:
                decision.rejections.append(
                    Rejection(
                        record.id,
                        "hardware",
                        f"needs {required:.1f} GB, only "
                        f"{gpu.usable_vram_gb:.1f} GB usable "
                        f"({gpu.free_vram_gb:.1f} GB free plus "
                        f"{gpu.resident_vram_gb:.1f} GB reclaimable, "
                        "minus overhead)",
                    )
                )
                continue

            survivors.append(record)

        return survivors

    # --- convenience ------------------------------------------------------

    def select_descriptor(
        self, requirements: TaskRequirements
    ) -> tuple[ModelDescriptor | None, RoutingDecision]:
        decision = self.route(requirements)
        selected = to_descriptor(decision.selected) if decision.selected else None
        return selected, decision
