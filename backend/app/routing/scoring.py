"""The seven-factor scoring function, with its reasoning kept intact.

Weights are exactly those in section 4 of the Part 02 spec. Every factor
returns a normalised 0..1 value *and* a sentence explaining the number, because
the frontend has a "why was this model chosen" panel and a score with no
rationale cannot fill it.

This is deliberately a transparent weighted sum, not a learned ranker: the
decision has to be auditable on a system whose whole claim is auditability.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.db.models.model_registry import ModelRecord, ModelStat
from app.routing.hardware import GpuState

WEIGHTS: dict[str, float] = {
    "task_accuracy": 0.30,
    "capability_match": 0.20,
    "context_fit": 0.15,
    "latency": 0.10,
    "resource_efficiency": 0.10,
    "historical_success": 0.10,
    "reliability": 0.05,
}

# Used for historical_success before a model has any record. Neutral rather
# than optimistic, so an unproven model does not outrank a proven one on a
# factor it has not earned.
NEUTRAL_PRIOR = 0.5

# Below this many attempts the history is blended toward the prior, so three
# lucky runs cannot dominate the ranking.
CONFIDENCE_ATTEMPTS = 10


@dataclass
class FactorScore:
    name: str
    value: float
    weight: float
    explanation: str

    @property
    def contribution(self) -> float:
        return self.value * self.weight


@dataclass
class ScoreCard:
    model_id: str
    total: float
    factors: list[FactorScore] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "model_id": self.model_id,
            "total": round(self.total, 4),
            "factors": [
                {
                    "name": factor.name,
                    "value": round(factor.value, 3),
                    "weight": factor.weight,
                    "contribution": round(factor.contribution, 4),
                    "why": factor.explanation,
                }
                for factor in self.factors
            ],
        }

    @property
    def summary(self) -> str:
        """The two factors that most drove the result, in plain words."""
        ranked = sorted(self.factors, key=lambda f: f.contribution, reverse=True)
        return "; ".join(factor.explanation for factor in ranked[:2])


def _task_accuracy(record: ModelRecord, requirements) -> FactorScore:
    value = record.benchmark_score

    # A model built for the job beats a generalist that merely tolerates it.
    if requirements.model_type and record.type == requirements.model_type:
        value = min(1.0, value + 0.08)
        note = (
            f"purpose-built {record.type} model "
            f"(benchmark {record.benchmark_score:.2f})"
        )
    else:
        value = max(0.0, value - 0.10)
        note = (
            f"{record.type} model handling a {requirements.model_type or 'general'} "
            f"task (benchmark {record.benchmark_score:.2f})"
        )

    return FactorScore("task_accuracy", value, WEIGHTS["task_accuracy"], note)


def _capability_match(record: ModelRecord, requirements) -> FactorScore:
    required = set(requirements.required_capabilities)
    preferred = set(requirements.preferred_capabilities)
    owned = set(record.capabilities or [])

    if not required and not preferred:
        return FactorScore(
            "capability_match",
            0.7,
            WEIGHTS["capability_match"],
            "no capabilities requested",
        )

    # Required capabilities are already guaranteed by the filter stage, so
    # this factor ranks on the optional extras a model brings.
    if preferred:
        hit = len(preferred & owned) / len(preferred)
        note = (
            f"has {len(preferred & owned)} of {len(preferred)} preferred "
            f"capabilities ({', '.join(sorted(preferred & owned)) or 'none'})"
        )
    else:
        hit = 1.0
        note = f"covers all required capabilities ({', '.join(sorted(required))})"

    # A narrow model that exactly fits is preferable to a sprawling one.
    focus = len(owned & (required | preferred)) / max(1, len(owned))
    value = 0.75 * hit + 0.25 * focus
    return FactorScore("capability_match", value, WEIGHTS["capability_match"], note)


def _context_fit(record: ModelRecord, requirements) -> FactorScore:
    needed = max(1, requirements.estimated_context_tokens)
    available = max(1, record.context_length)
    ratio = needed / available

    if ratio > 1.0:
        return FactorScore(
            "context_fit",
            0.0,
            WEIGHTS["context_fit"],
            f"needs ~{needed} tokens, window is {available}",
        )

    # Peak just below the window: comfortable headroom without paying for a
    # window the task will never use.
    value = 1.0 - abs(0.7 - ratio)
    value = max(0.0, min(1.0, value))
    return FactorScore(
        "context_fit",
        value,
        WEIGHTS["context_fit"],
        f"~{needed} of {available} tokens ({ratio:.0%} of the window)",
    )


def _latency(record: ModelRecord, stat: ModelStat | None) -> FactorScore:
    if stat is not None and stat.ewma_latency_ms > 0:
        # 2s or faster is full marks; 30s or slower scores zero.
        measured = stat.ewma_latency_ms
        value = max(0.0, min(1.0, 1.0 - (measured - 2000) / 28000))
        return FactorScore(
            "latency",
            value,
            WEIGHTS["latency"],
            f"measured ~{measured / 1000:.1f}s average on this task type",
        )

    return FactorScore(
        "latency",
        record.latency_score,
        WEIGHTS["latency"],
        f"estimated latency score {record.latency_score:.2f} (no measurements yet)",
    )


def _resource_efficiency(record: ModelRecord, gpu: GpuState) -> FactorScore:
    required = record.effective_vram_gb

    if not gpu.present or gpu.total_vram_gb <= 0:
        return FactorScore(
            "resource_efficiency", 0.5, WEIGHTS["resource_efficiency"], "CPU inference"
        )

    # The spec's key principle: prefer the smallest sufficient model, because
    # leaving VRAM free is what lets the vision model run alongside the
    # reasoner on an 8 GB card. Smaller therefore scores higher outright.
    footprint = required / gpu.total_vram_gb
    value = max(0.0, 1.0 - footprint)
    leftover = gpu.usable_vram_gb - required

    return FactorScore(
        "resource_efficiency",
        value,
        WEIGHTS["resource_efficiency"],
        f"{required:.1f} GB of {gpu.total_vram_gb:.1f} GB, "
        f"leaving {max(0.0, leftover):.1f} GB for a second model",
    )


def _historical_success(stat: ModelStat | None) -> FactorScore:
    if stat is None or stat.attempts == 0:
        return FactorScore(
            "historical_success",
            NEUTRAL_PRIOR,
            WEIGHTS["historical_success"],
            "no history yet on this task type",
        )

    observed = stat.success_rate or 0.0
    # Blend toward the prior until there is enough history to trust it.
    confidence = min(1.0, stat.attempts / CONFIDENCE_ATTEMPTS)
    value = confidence * observed + (1 - confidence) * NEUTRAL_PRIOR

    return FactorScore(
        "historical_success",
        value,
        WEIGHTS["historical_success"],
        f"{stat.successes}/{stat.attempts} successful runs on this task type",
    )


def _reliability(record: ModelRecord, stat: ModelStat | None) -> FactorScore:
    value = record.reliability_score
    note = f"declared reliability {record.reliability_score:.2f}"

    # Malformed JSON is a reliability problem, not an accuracy one: it breaks
    # Part 04's planner outright rather than degrading an answer.
    if stat is not None and stat.attempts > 0 and stat.schema_failures:
        penalty = min(0.5, stat.schema_failures / stat.attempts)
        value = max(0.0, value - penalty)
        note = (
            f"{stat.schema_failures} malformed structured replies in "
            f"{stat.attempts} runs"
        )

    return FactorScore("reliability", value, WEIGHTS["reliability"], note)


def score_model(
    record: ModelRecord,
    requirements,
    gpu: GpuState,
    stat: ModelStat | None = None,
) -> ScoreCard:
    factors = [
        _task_accuracy(record, requirements),
        _capability_match(record, requirements),
        _context_fit(record, requirements),
        _latency(record, stat),
        _resource_efficiency(record, gpu),
        _historical_success(stat),
        _reliability(record, stat),
    ]
    total = sum(factor.contribution for factor in factors)
    return ScoreCard(model_id=record.id, total=total, factors=factors)
