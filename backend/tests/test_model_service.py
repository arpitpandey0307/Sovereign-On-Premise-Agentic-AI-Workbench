"""Generation, failover and the telemetry loop.

Driven by fake providers so the behaviour is pinned without depending on a
multi-gigabyte model being pulled. The adapters themselves are thin HTTP
wrappers; what matters here is what the service does around them.
"""

from __future__ import annotations

import pytest

from app.db.models.model_registry import ModelRecord
from app.models.base import ModelRequest, ModelResponse, ProviderError
from app.models.registry import ModelRegistry
from app.models.service import ModelService
from app.routing.hardware import GpuState, hardware
from app.routing.model_router import TaskRequirements


class FakeProvider:
    name = "ollama"

    def __init__(self, *, fail_for: set[str] | None = None, text: str = "ok") -> None:
        self.fail_for = fail_for or set()
        self.text = text
        self.calls: list[str] = []

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.calls.append(request.model_id)
        if request.model_id in self.fail_for:
            raise ProviderError("simulated failure", model_id=request.model_id)
        structured = None
        satisfied = False
        if request.response_schema is not None:
            import json

            try:
                structured = json.loads(self.text)
                satisfied = isinstance(structured, dict)
            except json.JSONDecodeError:
                structured, satisfied = None, False
        return ModelResponse(
            text=self.text,
            structured=structured,
            latency_ms=1500,
            tokens_used=42,
            model_id=request.model_id,
            schema_satisfied=satisfied,
        )

    async def is_reachable(self) -> bool:
        return True

    async def loaded_models(self) -> list[str]:
        return ["alpha:1b", "beta:1b"]


def _model(db, model_id: str, identifier: str, **overrides) -> ModelRecord:
    defaults = {
        "id": model_id,
        "name": model_id,
        "provider": "ollama",
        "model_identifier": identifier,
        "type": "reasoning",
        "capabilities": ["reasoning", "structured_output"],
        "context_length": 8192,
        "quantization": "Q4",
        "vram_required_gb": 1.0,
        "supported_modalities": ["text"],
        "approved_classifications": [],
        "status": "ready",
        "benchmark_score": 0.7,
        "latency_score": 0.7,
        "reliability_score": 0.9,
    }
    defaults.update(overrides)
    record = ModelRecord(**defaults)
    db.add(record)
    db.commit()
    return record


@pytest.fixture
def registry_db(db, monkeypatch):
    db.query(ModelRecord).delete()
    db.commit()
    monkeypatch.setattr(
        hardware,
        "state",
        lambda refresh=False: GpuState(
            present=True, name="Test", total_vram_gb=8.0, used_vram_gb=0.5, detail="test"
        ),
    )
    yield db
    db.query(ModelRecord).delete()
    db.commit()


@pytest.fixture
def service(monkeypatch):
    instance = ModelService()
    return instance


@pytest.mark.anyio
async def test_generation_records_success_and_latency(registry_db, service):
    _model(registry_db, "alpha", "alpha:1b", benchmark_score=0.9)
    provider = FakeProvider()
    service._providers = {"ollama": provider}

    outcome = await service.generate(
        registry_db, TaskRequirements(task_type="review"), prompt="hello"
    )

    assert outcome.succeeded
    assert outcome.model_used == "alpha"
    assert provider.calls == ["alpha:1b"]

    stat = ModelRegistry(registry_db).stat("alpha", "review")
    assert stat.successes == 1
    assert stat.ewma_latency_ms == 1500


@pytest.mark.anyio
async def test_a_failing_model_falls_back_to_the_next_candidate(registry_db, service):
    _model(registry_db, "primary", "alpha:1b", benchmark_score=0.95)
    _model(registry_db, "backup", "beta:1b", benchmark_score=0.60)
    provider = FakeProvider(fail_for={"alpha:1b"})
    service._providers = {"ollama": provider}

    outcome = await service.generate(
        registry_db, TaskRequirements(task_type="review"), prompt="hello"
    )

    assert outcome.succeeded
    assert outcome.model_used == "backup"
    assert provider.calls == ["alpha:1b", "beta:1b"]

    # The failure is recorded, and the model is marked unavailable so the next
    # routing decision does not pick it again while it is broken.
    registry = ModelRegistry(registry_db)
    assert registry.stat("primary", "review").failures == 1
    assert registry.get("primary").status == "unavailable"

    assert [attempt["ok"] for attempt in outcome.attempts] == [False, True]


@pytest.mark.anyio
async def test_every_candidate_failing_reports_cleanly(registry_db, service):
    _model(registry_db, "one", "alpha:1b")
    _model(registry_db, "two", "beta:1b")
    service._providers = {"ollama": FakeProvider(fail_for={"alpha:1b", "beta:1b"})}

    outcome = await service.generate(
        registry_db, TaskRequirements(), prompt="hello"
    )

    assert not outcome.succeeded
    assert outcome.error
    assert len(outcome.attempts) == 2


@pytest.mark.anyio
async def test_malformed_json_counts_as_a_schema_failure(registry_db, service):
    _model(registry_db, "sloppy", "alpha:1b")
    service._providers = {"ollama": FakeProvider(text="this is not json")}

    outcome = await service.generate(
        registry_db,
        TaskRequirements(task_type="planning"),
        prompt="plan",
        response_schema={"type": "object"},
    )

    assert outcome.succeeded  # text came back, so the call itself worked
    stat = ModelRegistry(registry_db).stat("sloppy", "planning")
    assert stat.successes == 1
    assert stat.schema_failures == 1


@pytest.mark.anyio
async def test_valid_json_does_not_count_as_a_schema_failure(registry_db, service):
    _model(registry_db, "tidy", "alpha:1b")
    service._providers = {"ollama": FakeProvider(text='{"tool": "search"}')}

    outcome = await service.generate(
        registry_db,
        TaskRequirements(task_type="planning"),
        prompt="plan",
        response_schema={"type": "object"},
    )

    assert outcome.response.structured == {"tool": "search"}
    assert ModelRegistry(registry_db).stat("tidy", "planning").schema_failures == 0


@pytest.mark.anyio
async def test_no_candidate_returns_the_routing_reason_not_a_crash(
    registry_db, service
):
    _model(registry_db, "text-only", "alpha:1b", capabilities=["reasoning"])
    service._providers = {"ollama": FakeProvider()}

    outcome = await service.generate(
        registry_db, TaskRequirements(needs_vision=True), prompt="look"
    )

    assert not outcome.succeeded
    assert "No model satisfied" in outcome.error
    assert outcome.explain()["rejected"]


def test_a_remote_endpoint_is_refused():
    """The sovereignty guarantee is enforced, not assumed."""
    from app.models.ollama import OllamaProvider

    with pytest.raises(ValueError, match="non-local"):
        OllamaProvider("https://api.example.com")

    # Loopback and the compose service name are both fine.
    assert OllamaProvider("http://127.0.0.1:11434")
    assert OllamaProvider("http://ollama:11434")


def test_structured_output_is_salvaged_from_prose():
    from app.models.base import coerce_structured

    fenced = 'Here you go:\n```json\n{"tool": "search"}\n```\nHope that helps.'
    parsed, ok = coerce_structured(fenced)
    assert ok and parsed == {"tool": "search"}

    bare = 'Sure! {"tool": "read"} done'
    parsed, ok = coerce_structured(bare)
    assert ok and parsed == {"tool": "read"}

    parsed, ok = coerce_structured("no json at all")
    assert not ok and parsed is None
