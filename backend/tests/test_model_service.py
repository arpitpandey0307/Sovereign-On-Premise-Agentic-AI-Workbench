"""Generation, failover and the telemetry loop.

Driven by fake providers so the behaviour is pinned without depending on a
multi-gigabyte model being pulled. The adapters themselves are thin HTTP
wrappers; what matters here is what the service does around them.
"""

from __future__ import annotations

import pytest

from app.db.models.model_registry import ModelRecord
from app.models.base import (
    ModelRequest,
    ModelResponse,
    ModelUnavailableError,
    ProviderError,
)
from app.models.registry import ModelRegistry
from app.models.service import ModelService
from app.routing.hardware import GpuState, hardware
from app.routing.model_router import TaskRequirements


class FakeProvider:
    name = "ollama"

    def __init__(
        self,
        *,
        fail_for: set[str] | None = None,
        unavailable_for: set[str] | None = None,
        text: str = "ok",
    ) -> None:
        self.fail_for = fail_for or set()
        self.unavailable_for = unavailable_for or set()
        self.text = text
        self.calls: list[str] = []

    async def generate(self, request: ModelRequest) -> ModelResponse:
        self.calls.append(request.model_id)
        if request.model_id in self.unavailable_for:
            raise ModelUnavailableError(
                "not pulled locally", model_id=request.model_id
            )
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

    # The failure is recorded, so reliability scoring penalises the model and
    # the router prefers the alternative next time. It stays registered,
    # though: a retryable failure is not evidence that the model is broken,
    # and taking it out of the registry is a decision nothing ever reverses.
    registry = ModelRegistry(registry_db)
    assert registry.stat("primary", "review").failures == 1
    assert registry.get("primary").status == "ready"

    assert [attempt["ok"] for attempt in outcome.attempts] == [False, True]


@pytest.mark.anyio
async def test_a_model_that_cannot_serve_is_taken_out_of_the_registry(
    registry_db, service
):
    """The other half of the rule: a real unavailability does disable it.

    A timeout says the call was slow. A ModelUnavailableError says the runtime
    is up and this model is not there -- nothing is gained by routing to it
    again, so it leaves the registry until a refresh finds it.
    """
    _model(registry_db, "missing", "gone:1b", benchmark_score=0.95)
    _model(registry_db, "backup", "beta:1b", benchmark_score=0.60)
    service._providers = {"ollama": FakeProvider(unavailable_for={"gone:1b"})}

    outcome = await service.generate(
        registry_db, TaskRequirements(task_type="review"), prompt="hello"
    )

    assert outcome.succeeded
    assert outcome.model_used == "backup"
    assert ModelRegistry(registry_db).get("missing").status == "unavailable"


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


# --- reconciliation against what the runtime actually holds ----------------


# Columns to carry across the snapshot. Listed rather than introspected so a
# new column is a visible decision rather than a silent omission.
_REGISTRY_COLUMNS = (
    "id",
    "name",
    "provider",
    "model_identifier",
    "type",
    "capabilities",
    "context_length",
    "quantization",
    "vram_required_gb",
    "supported_modalities",
    "approved_classifications",
    "status",
    "status_detail",
    "benchmark_score",
    "latency_score",
    "reliability_score",
    "notes",
)


@pytest.fixture
def clean_registry(db):
    """An empty model table for the duration, then put back as it was.

    Restored rather than merely emptied: the registry is shared state for the
    whole session, and a fixture that left it empty broke whichever suite ran
    next -- which is exactly the sort of failure that only appears in a full
    run and looks like a bug in innocent code.
    """
    saved = [
        {column: getattr(record, column) for column in _REGISTRY_COLUMNS}
        for record in db.query(ModelRecord).all()
    ]
    db.query(ModelRecord).delete()
    db.commit()

    yield db

    db.query(ModelRecord).delete()
    for row in saved:
        db.add(ModelRecord(**row))
    db.commit()


def _entry(db, model_id: str, identifier: str) -> ModelRecord:
    """One catalogue row, built directly.

    Not via `seed()`: that installs whichever profile suits the machine's own
    GPU, so a test built on it asserts something different on every host.
    """
    record = ModelRecord(
        id=model_id,
        name=model_id,
        provider="ollama",
        model_identifier=identifier,
        type="reasoning",
        capabilities=["reasoning"],
        context_length=8192,
        quantization="Q4_K_M",
        vram_required_gb=2.0,
        supported_modalities=["text"],
        approved_classifications=[],
        status="unavailable",
        benchmark_score=0.7,
        latency_score=0.7,
        reliability_score=0.9,
    )
    db.add(record)
    db.commit()
    return record


def test_a_pulled_sibling_does_not_make_a_missing_model_ready(clean_registry):
    """`qwen3:8b` being pulled must not report `qwen3:1.7b` as ready.

    They are different models: different weights, different VRAM, different
    answers. Matching on the family with the tag stripped reported every
    `qwen3:*` entry as present the moment any one qwen3 was pulled, so the
    registry advertised a model that was not installed, the router selected it
    on merit, and generation failed at the point of use with "is not pulled
    locally" -- which is the worst place to find out.
    """
    _entry(clean_registry, "reasoner-qwen3-8b-4bit", "qwen3:8b")
    _entry(clean_registry, "reasoner-qwen3-1_7b-q4", "qwen3:1.7b")

    registry = ModelRegistry(clean_registry)
    # Exactly what this machine had: one qwen3, and it is the 8b.
    registry.reconcile({"qwen3:8b", "qwen2.5-coder:7b", "gemma3:4b", "bge-m3:latest"})

    big = registry.get("reasoner-qwen3-8b-4bit")
    small = registry.get("reasoner-qwen3-1_7b-q4")

    assert big is not None and big.status == "ready"
    assert small is not None and small.status == "unavailable"
    assert "ollama pull qwen3:1.7b" in small.status_detail


def test_an_untagged_entry_matches_whatever_tag_is_installed(clean_registry):
    """`bge-m3` genuinely does mean whichever `bge-m3:*` is there."""
    _entry(clean_registry, "embed-bge", "bge-m3")

    registry = ModelRegistry(clean_registry)
    registry.reconcile({"bge-m3:latest"})

    record = registry.get("embed-bge")
    assert record is not None and record.status == "ready"


def test_nothing_pulled_leaves_nothing_ready(clean_registry):
    _entry(clean_registry, "reasoner-qwen3-8b-4bit", "qwen3:8b")

    registry = ModelRegistry(clean_registry)
    registry.reconcile(set())

    record = registry.get("reasoner-qwen3-8b-4bit")
    assert record is not None and record.status == "unavailable"
