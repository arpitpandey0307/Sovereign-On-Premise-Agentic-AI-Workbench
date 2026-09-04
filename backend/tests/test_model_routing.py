"""The router's decisions, not just its plumbing.

Each test pins one behaviour the routing is supposed to have, so a later
change that quietly turns it back into a first-match lookup fails here.
"""

from __future__ import annotations

import pytest

from app.db.models.model_registry import ModelRecord
from app.routing.hardware import GpuState, hardware
from app.routing.model_router import ModelRouter, TaskRequirements
from app.routing.scoring import WEIGHTS, score_model


def _model(db, **overrides) -> ModelRecord:
    defaults = {
        "id": "test-model",
        "name": "Test Model",
        "provider": "ollama",
        "model_identifier": "test:1b",
        "type": "reasoning",
        "capabilities": ["reasoning", "structured_output"],
        "context_length": 8192,
        "quantization": "Q4_K_M",
        "vram_required_gb": 2.0,
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
def clean_registry(db):
    db.query(ModelRecord).delete()
    db.commit()
    yield db
    db.query(ModelRecord).delete()
    db.commit()


@pytest.fixture
def gpu_8gb(monkeypatch):
    state = GpuState(
        present=True,
        name="Test GPU 8GB",
        total_vram_gb=8.0,
        used_vram_gb=0.5,
        detail="test",
    )
    monkeypatch.setattr(hardware, "state", lambda refresh=False: state)
    return state


# --- stage ordering -------------------------------------------------------


def test_capability_filter_rejects_before_anything_else(clean_registry, gpu_8gb):
    _model(clean_registry, id="text-only", capabilities=["reasoning"])
    decision = ModelRouter(clean_registry).route(
        TaskRequirements(needs_vision=True)
    )

    assert not decision.succeeded
    assert decision.rejections[0].stage == "capability"
    assert "vision" in decision.rejections[0].reason


def test_security_outranks_quality(clean_registry, gpu_8gb):
    """A better model that is not cleared must lose to a cleared weaker one."""
    _model(
        clean_registry,
        id="strong-but-unapproved",
        benchmark_score=0.99,
        approved_classifications=["PUBLIC"],
    )
    _model(
        clean_registry,
        id="weak-but-approved",
        benchmark_score=0.40,
        approved_classifications=["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    )

    decision = ModelRouter(clean_registry).route(
        TaskRequirements(classification="CONFIDENTIAL")
    )

    assert decision.selected.id == "weak-but-approved"
    rejected = {r.model_id: r for r in decision.rejections}
    assert rejected["strong-but-unapproved"].stage == "policy"


def test_model_that_does_not_fit_vram_is_excluded(clean_registry, monkeypatch):
    tight = GpuState(
        present=True, name="Tight", total_vram_gb=8.0, used_vram_gb=6.0, detail="test"
    )
    monkeypatch.setattr(hardware, "state", lambda refresh=False: tight)

    _model(clean_registry, id="big", vram_required_gb=6.5)
    _model(clean_registry, id="small", vram_required_gb=0.5)

    decision = ModelRouter(clean_registry).route(TaskRequirements())

    assert decision.selected.id == "small"
    rejected = {r.model_id: r for r in decision.rejections}
    assert rejected["big"].stage == "hardware"
    assert "usable" in rejected["big"].reason


def test_unpulled_model_is_never_routed_to(clean_registry, gpu_8gb):
    _model(clean_registry, id="not-pulled", status="unavailable", benchmark_score=0.99)
    _model(clean_registry, id="pulled", status="ready", benchmark_score=0.5)

    decision = ModelRouter(clean_registry).route(TaskRequirements())
    assert decision.selected.id == "pulled"


# --- the smallest-sufficient-model principle ------------------------------


def test_prefers_the_smallest_sufficient_model(clean_registry, gpu_8gb):
    """Both clear the bar, so the one that leaves VRAM free should win."""
    _model(clean_registry, id="large", vram_required_gb=6.5, benchmark_score=0.80)
    _model(clean_registry, id="small", vram_required_gb=2.0, benchmark_score=0.78)

    decision = ModelRouter(clean_registry).route(TaskRequirements())

    assert decision.selected.id == "small"
    assert "leaving" in decision.rationale or decision.selected.id == "small"


def test_a_clearly_better_model_still_wins_despite_size(clean_registry, gpu_8gb):
    """Smallest-sufficient is a preference, not a rule that ignores quality."""
    _model(clean_registry, id="large", vram_required_gb=6.0, benchmark_score=0.95)
    _model(clean_registry, id="tiny", vram_required_gb=0.5, benchmark_score=0.30)

    decision = ModelRouter(clean_registry).route(TaskRequirements())
    assert decision.selected.id == "large"


# --- feedback loop --------------------------------------------------------


def test_repeated_failures_demote_a_model(clean_registry, gpu_8gb):
    from app.models.registry import ModelRegistry

    _model(clean_registry, id="flaky", benchmark_score=0.80)
    _model(clean_registry, id="steady", benchmark_score=0.75)

    registry = ModelRegistry(clean_registry)
    before = ModelRouter(clean_registry).route(TaskRequirements(task_type="review"))
    assert before.selected.id == "flaky"

    flaky = registry.stat("flaky", "review")
    flaky.failures = 20
    steady = registry.stat("steady", "review")
    steady.successes = 20
    clean_registry.commit()

    after = ModelRouter(clean_registry).route(TaskRequirements(task_type="review"))
    assert after.selected.id == "steady", "history should override the headline score"


def test_malformed_json_is_penalised_as_a_reliability_problem(clean_registry, gpu_8gb):
    from app.models.registry import ModelRegistry

    record = _model(clean_registry, id="sloppy")
    stat = ModelRegistry(clean_registry).stat("sloppy", "general")
    stat.successes = 10
    stat.schema_failures = 8
    clean_registry.commit()

    card = score_model(record, TaskRequirements(), gpu_8gb, stat)
    reliability = next(f for f in card.factors if f.name == "reliability")
    assert reliability.value < record.reliability_score
    assert "malformed" in reliability.explanation


# --- explainability -------------------------------------------------------


def test_every_decision_explains_itself(clean_registry, gpu_8gb):
    _model(clean_registry, id="winner", benchmark_score=0.9)
    _model(clean_registry, id="loser", benchmark_score=0.4)

    decision = ModelRouter(clean_registry).route(TaskRequirements())
    payload = decision.explain()

    assert payload["selected"]["model_id"] == "winner"
    assert payload["rationale"]
    assert len(payload["ranked"]) == 2
    # All seven factors, each with a human-readable reason.
    factors = payload["ranked"][0]["factors"]
    assert {f["name"] for f in factors} == set(WEIGHTS)
    assert all(f["why"] for f in factors)
    assert payload["hardware"]["total_vram_gb"] == 8.0


def test_failure_explains_which_stage_rejected_what(clean_registry, gpu_8gb):
    _model(clean_registry, id="a", capabilities=["reasoning"])
    _model(clean_registry, id="b", capabilities=["reasoning"])

    decision = ModelRouter(clean_registry).route(
        TaskRequirements(required_capabilities=["vision"])
    )
    assert not decision.succeeded
    assert "2 considered" in decision.failure_reason
    assert "capability" in decision.failure_reason


def test_weights_match_the_specification():
    assert WEIGHTS == {
        "task_accuracy": 0.30,
        "capability_match": 0.20,
        "context_fit": 0.15,
        "latency": 0.10,
        "resource_efficiency": 0.10,
        "historical_success": 0.10,
        "reliability": 0.05,
    }
    assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9


# --- fallback -------------------------------------------------------------


def test_a_fallback_chain_is_offered(clean_registry, gpu_8gb):
    for index in range(4):
        _model(clean_registry, id=f"m{index}", benchmark_score=0.9 - index * 0.1)

    decision = ModelRouter(clean_registry).route(TaskRequirements())
    assert decision.fallbacks
    assert decision.selected.id not in decision.fallbacks


def test_excluded_model_is_not_reselected(clean_registry, gpu_8gb):
    _model(clean_registry, id="failed-already", benchmark_score=0.9)
    _model(clean_registry, id="alternative", benchmark_score=0.5)

    decision = ModelRouter(clean_registry).route(
        TaskRequirements(exclude_models=["failed-already"])
    )
    assert decision.selected.id == "alternative"


def test_context_that_exceeds_every_window_fails_cleanly(clean_registry, gpu_8gb):
    _model(clean_registry, id="short", context_length=4096)

    decision = ModelRouter(clean_registry).route(
        TaskRequirements(estimated_context_tokens=100_000)
    )
    assert not decision.succeeded
    assert "context window" in decision.rejections[0].reason
