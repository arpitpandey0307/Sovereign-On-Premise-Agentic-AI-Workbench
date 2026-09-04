"""Model registry and per-model performance tables (Part 02).

``models`` is the schema from section 6 of the Part 02 spec.
``model_stats`` is what makes the ``historical_success`` scoring factor real
rather than a constant: every generation records its outcome, and the router
reads it back on the next decision.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from app.db.database import Base


def _now() -> datetime:
    return datetime.now(UTC)


class ModelRecord(Base):
    __tablename__ = "models"

    # The id is the human-readable slug from the catalogue
    # (e.g. "reasoner-qwen3-8b-4bit"), not a UUID: it appears in audit records
    # and in the "why this model" panel, so it needs to be readable.
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    provider: Mapped[str] = mapped_column(String(64), index=True)
    model_identifier: Mapped[str] = mapped_column(String(255))
    type: Mapped[str] = mapped_column(String(32), index=True)

    capabilities: Mapped[list[str]] = mapped_column(JSON, default=list)
    context_length: Mapped[int] = mapped_column(Integer, default=4096)
    quantization: Mapped[str] = mapped_column(String(32), default="")
    vram_required_gb: Mapped[float] = mapped_column(Float, default=0.0)
    supported_modalities: Mapped[list[str]] = mapped_column(JSON, default=list)

    # Filled in by consulting Part 05's classification rules, never decided
    # here. Empty means "ask the policy engine", not "approved for nothing".
    approved_classifications: Mapped[list[str]] = mapped_column(JSON, default=list)

    status: Mapped[str] = mapped_column(String(32), default="unavailable", index=True)
    status_detail: Mapped[str] = mapped_column(Text, default="")

    benchmark_score: Mapped[float] = mapped_column(Float, default=0.5)
    latency_score: Mapped[float] = mapped_column(Float, default=0.5)
    reliability_score: Mapped[float] = mapped_column(Float, default=0.5)

    # Overwritten with a measured figure once the model has actually run, so
    # the planning estimate stops being the basis for hardware decisions.
    measured_vram_gb: Mapped[float | None] = mapped_column(Float, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    @property
    def effective_vram_gb(self) -> float:
        """Measured footprint once known, otherwise the planning estimate."""
        return (
            self.measured_vram_gb
            if self.measured_vram_gb is not None
            else self.vram_required_gb
        )


class ModelStat(Base):
    """Rolling outcome history per model per task type."""

    __tablename__ = "model_stats"

    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    model_id: Mapped[str] = mapped_column(
        String(128), ForeignKey("models.id", ondelete="CASCADE"), index=True
    )
    task_type: Mapped[str] = mapped_column(String(64), index=True, default="general")

    successes: Mapped[int] = mapped_column(Integer, default=0)
    failures: Mapped[int] = mapped_column(Integer, default=0)
    schema_failures: Mapped[int] = mapped_column(Integer, default=0)

    # Exponentially weighted so a model that has recovered is not held back by
    # old numbers, and a model that just degraded is caught quickly.
    ewma_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    ewma_tokens: Mapped[float] = mapped_column(Float, default=0.0)
    peak_vram_gb: Mapped[float] = mapped_column(Float, default=0.0)

    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[str] = mapped_column(Text, default="")

    @property
    def attempts(self) -> int:
        return self.successes + self.failures

    @property
    def success_rate(self) -> float | None:
        """None when there is no history yet, so the router can say so."""
        return self.successes / self.attempts if self.attempts else None
