"""The model layer's public face.

Part 04 asks for work to be done and gets back a response plus the reasoning
for how it was routed. It never names a model unless it wants to, never picks
a provider, and never has to handle a model falling over -- the fallback chain
computed during routing is used automatically.

This is also where the loop closes: every generation records its outcome, and
the next routing decision reads those numbers back through the
``historical_success``, ``latency`` and ``reliability`` factors. That feedback
is what separates this from a static rule table.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.base import ModelProvider, ModelRequest, ModelResponse, ProviderError
from app.models.ollama import OllamaProvider
from app.models.registry import ModelRegistry, to_descriptor
from app.models.vllm import VLLMProvider
from app.routing.hardware import hardware
from app.routing.model_router import ModelRouter, RoutingDecision, TaskRequirements
from app.schemas.shared import ModelDescriptor

logger = logging.getLogger("workbench.models")

# Weight of a new measurement in the rolling average. High enough to react to
# a degrading model, low enough that one slow call does not reorder routing.
EWMA_ALPHA = 0.3


@dataclass
class GenerationOutcome:
    response: ModelResponse | None
    decision: RoutingDecision
    model_used: str | None
    attempts: list[dict]
    error: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.response is not None

    def explain(self) -> dict:
        payload = self.decision.explain()
        payload["attempts"] = self.attempts
        payload["model_used"] = self.model_used
        if self.error:
            payload["error"] = self.error
        return payload


class ModelService:
    """Owns the providers and turns a routing decision into an answer."""

    def __init__(self) -> None:
        self._providers: dict[str, ModelProvider] = {}
        try:
            self._providers["ollama"] = OllamaProvider(settings.ollama_base_url)
        except ValueError as exc:
            logger.error("Ollama provider rejected: %s", exc)
        if settings.vllm_base_url:
            try:
                self._providers["vllm"] = VLLMProvider(settings.vllm_base_url)
            except ValueError as exc:
                logger.error("vLLM provider rejected: %s", exc)

    def provider(self, name: str) -> ModelProvider | None:
        return self._providers.get(name)

    # --- health and registry upkeep ---------------------------------------

    async def refresh_registry(self, db: Session) -> dict[str, str]:
        """Seed the catalogue, then mark rows against what the runtime holds."""
        registry = ModelRegistry(db)
        registry.seed()

        present: set[str] = set()
        for provider in self._providers.values():
            present.update(await provider.loaded_models())

        return registry.reconcile(present)

    async def health(self, db: Session) -> dict:
        gpu = hardware.state(refresh=True)
        registry = ModelRegistry(db)

        runtimes = {}
        for name, provider in self._providers.items():
            reachable = await provider.is_reachable()
            runtimes[name] = {
                "reachable": reachable,
                "endpoint_is_local": True,
                "models": await provider.loaded_models() if reachable else [],
            }

        records = registry.all()
        ready = [record for record in records if record.status == "ready"]

        resident = []
        ollama = self._providers.get("ollama")
        if ollama is not None and isinstance(ollama, OllamaProvider):
            resident = [
                {
                    "model": entry.get("name"),
                    "vram_gb": round(entry.get("size_vram", 0) / 1_000_000_000, 2),
                }
                for entry in await ollama.resident_models()
            ]

        return {
            "gpu": {
                "present": gpu.present,
                "name": gpu.name,
                "total_vram_gb": gpu.total_vram_gb,
                "used_vram_gb": gpu.used_vram_gb,
                "free_vram_gb": round(gpu.free_vram_gb, 2),
                "usable_vram_gb": round(gpu.usable_vram_gb, 2),
                "utilisation_pct": gpu.utilisation_pct,
                "pressure": round(gpu.pressure, 2),
                "detail": gpu.detail,
            },
            "runtimes": runtimes,
            "resident_models": resident,
            "models": [
                {
                    "id": record.id,
                    "name": record.name,
                    "type": record.type,
                    "status": record.status,
                    "detail": record.status_detail,
                    "vram_required_gb": record.effective_vram_gb,
                    "context_length": record.context_length,
                    "quantization": record.quantization,
                }
                for record in records
            ],
            "summary": {
                "registered": len(records),
                "ready": len(ready),
                "unavailable": len(records) - len(ready),
            },
        }

    def descriptors(self, db: Session) -> list[ModelDescriptor]:
        return [to_descriptor(record) for record in ModelRegistry(db).all()]

    # --- the main entry point ---------------------------------------------

    async def generate(
        self,
        db: Session,
        requirements: TaskRequirements,
        *,
        prompt: str,
        system: str | None = None,
        images: list[bytes] | None = None,
        max_tokens: int = 1024,
        response_schema: dict | None = None,
        max_attempts: int = 3,
    ) -> GenerationOutcome:
        """Route, generate, and fail over -- recording every outcome."""
        router = ModelRouter(db)
        decision = router.route(requirements)
        attempts: list[dict] = []

        if not decision.succeeded:
            return GenerationOutcome(
                response=None,
                decision=decision,
                model_used=None,
                attempts=attempts,
                error=decision.failure_reason,
            )

        chain = [decision.selected.id, *decision.fallbacks][:max_attempts]
        registry = ModelRegistry(db)
        last_error = ""

        for model_id in chain:
            record = registry.get(model_id)
            if record is None:
                continue
            provider = self._providers.get(record.provider)
            if provider is None:
                attempts.append(
                    {
                        "model_id": model_id,
                        "ok": False,
                        "error": f"no adapter for provider {record.provider}",
                    }
                )
                continue

            request = ModelRequest(
                model_id=record.model_identifier,
                prompt=prompt,
                system=system,
                images=images or [],
                max_tokens=max_tokens,
                response_schema=response_schema,
            )

            try:
                response = await provider.generate(request)
            except ProviderError as exc:
                last_error = str(exc)
                self._record_failure(db, model_id, requirements.task_type, str(exc))
                registry.set_status(model_id, "unavailable", str(exc))
                attempts.append({"model_id": model_id, "ok": False, "error": str(exc)})
                logger.warning("model %s failed, falling back: %s", model_id, exc)
                continue

            self._record_success(
                db,
                model_id,
                requirements.task_type,
                response,
                schema_requested=response_schema is not None,
            )
            attempts.append(
                {
                    "model_id": model_id,
                    "ok": True,
                    "latency_ms": response.latency_ms,
                    "schema_satisfied": response.schema_satisfied,
                }
            )
            response.model_id = model_id
            return GenerationOutcome(
                response=response,
                decision=decision,
                model_used=model_id,
                attempts=attempts,
            )

        return GenerationOutcome(
            response=None,
            decision=decision,
            model_used=None,
            attempts=attempts,
            error=last_error or "every candidate model failed",
        )

    # --- telemetry --------------------------------------------------------

    def _record_success(
        self,
        db: Session,
        model_id: str,
        task_type: str,
        response: ModelResponse,
        *,
        schema_requested: bool,
    ) -> None:
        registry = ModelRegistry(db)
        stat = registry.stat(model_id, task_type)

        stat.successes += 1
        stat.last_used_at = datetime.now(UTC)
        stat.ewma_latency_ms = _ewma(stat.ewma_latency_ms, response.latency_ms)
        stat.ewma_tokens = _ewma(stat.ewma_tokens, response.tokens_used)

        # A call that returned text but ignored the requested schema counts
        # separately: it is a reliability problem for Part 04's planner, which
        # needs parseable JSON, not a crash. The reliability factor reads it.
        if schema_requested and not response.schema_satisfied:
            stat.schema_failures += 1

        db.commit()
        self._capture_measured_vram(db, model_id)

    def _record_failure(
        self, db: Session, model_id: str, task_type: str, error: str
    ) -> None:
        stat = ModelRegistry(db).stat(model_id, task_type)
        stat.failures += 1
        stat.last_error = error[:500]
        stat.last_used_at = datetime.now(UTC)
        db.commit()

    def _capture_measured_vram(self, db: Session, model_id: str) -> None:
        """Replace the planning estimate with what the model actually used."""
        gpu = hardware.state(refresh=True)
        if not gpu.present:
            return
        record = ModelRegistry(db).get(model_id)
        if record is None:
            return
        stat = ModelRegistry(db).stat(model_id, "general")
        if gpu.used_vram_gb > stat.peak_vram_gb:
            stat.peak_vram_gb = gpu.used_vram_gb
            db.commit()


def _ewma(current: float, sample: float) -> float:
    if current <= 0:
        return float(sample)
    return (1 - EWMA_ALPHA) * current + EWMA_ALPHA * sample


model_service = ModelService()
