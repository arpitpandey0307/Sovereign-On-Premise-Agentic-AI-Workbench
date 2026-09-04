"""The interface every other part depends on to reach a model.

Part 04 holds a ``ModelProvider`` and never learns which runtime is behind it.
Swapping Ollama for vLLM changes the registry's ``provider`` field and the
compose file -- no calling code.
"""

from __future__ import annotations

from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field


class ModelRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_id: str
    prompt: str
    system: str | None = None
    images: list[bytes] = Field(default_factory=list)
    max_tokens: int = 1024
    temperature: float = 0.2
    # When set, the runtime is asked for JSON matching this schema. Part 04's
    # planner depends on this: it parses {"tool": ..., "args": {...}} rather
    # than regex-scraping prose.
    response_schema: dict | None = None
    timeout_s: float = 120.0


class ModelResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    text: str
    structured: dict | None = None
    latency_ms: int
    tokens_used: int
    model_id: str = ""
    # True when a schema was requested and the runtime returned valid JSON.
    schema_satisfied: bool = False


@runtime_checkable
class ModelProvider(Protocol):
    """One runtime. Adapters: OllamaProvider (dev), VLLMProvider (lab GPU)."""

    name: str

    async def generate(self, request: ModelRequest) -> ModelResponse: ...

    async def is_reachable(self) -> bool: ...

    async def loaded_models(self) -> list[str]:
        """Model identifiers the runtime currently reports as available."""
        ...


class ProviderError(RuntimeError):
    """The runtime failed. Carries the model so the router can penalise it."""

    def __init__(self, message: str, *, model_id: str, retryable: bool = True) -> None:
        super().__init__(message)
        self.model_id = model_id
        self.retryable = retryable


class ModelUnavailableError(ProviderError):
    """The runtime is up but this model cannot serve the request."""

    def __init__(self, message: str, *, model_id: str) -> None:
        super().__init__(message, model_id=model_id, retryable=False)


ModelType = Literal["reasoning", "vision", "coding", "embedding", "reranking"]

# Capability vocabulary. The router matches on these strings, so they are
# shared here rather than spelled out per model row.
CAPABILITIES = (
    "planning",
    "reasoning",
    "structured_output",
    "tool_use",
    "long_context",
    "vision",
    "ocr_postprocess",
    "code_generation",
    "code_explanation",
    "summarisation",
    "embedding",
    "reranking",
)


def coerce_structured(text: str) -> tuple[dict | None, bool]:
    """Best-effort JSON extraction from a model reply.

    Runtimes that honour a schema return clean JSON. Ones that do not often
    wrap it in prose or a fenced block, so a single salvage attempt here saves
    Part 04 from doing it in every call site.
    """
    import json

    candidate = text.strip()
    if not candidate:
        return None, False

    try:
        parsed = json.loads(candidate)
        return (parsed, True) if isinstance(parsed, dict) else (None, False)
    except json.JSONDecodeError:
        pass

    if "```" in candidate:
        blocks = candidate.split("```")
        for block in blocks[1:]:
            body = block.removeprefix("json").strip()
            try:
                parsed = json.loads(body)
                if isinstance(parsed, dict):
                    return parsed, True
            except json.JSONDecodeError:
                continue

    start, end = candidate.find("{"), candidate.rfind("}")
    if 0 <= start < end:
        try:
            parsed = json.loads(candidate[start : end + 1])
            if isinstance(parsed, dict):
                return parsed, True
        except json.JSONDecodeError:
            pass

    return None, False


def as_public_dict(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")
