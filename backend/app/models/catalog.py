"""The default model catalogue, tiered by the VRAM class of the demo machine.

Section 5 of the Part 02 spec gives two hardware plans because VRAM class
materially changes what is safe to run. The tier is chosen from the GPU
actually present, so the same code seeds the right catalogue on a 6 GB or an
8 GB machine without anyone editing a config by hand.

``vram_required_gb`` figures are the planning estimates from the spec. They are
overwritten with measured values once a model has actually run -- see
``routing/telemetry.py``.
"""

from __future__ import annotations

from typing import Literal, TypedDict

VramTier = Literal["6gb", "8gb", "cpu"]


class CatalogEntry(TypedDict):
    id: str
    name: str
    provider: str
    model_identifier: str
    type: str
    capabilities: list[str]
    context_length: int
    quantization: str
    vram_required_gb: float
    supported_modalities: list[str]
    benchmark_score: float
    latency_score: float
    reliability_score: float
    notes: str


# --- 8 GB class (e.g. RTX 5050 Laptop) ------------------------------------

_EIGHT_GB: list[CatalogEntry] = [
    {
        "id": "reasoner-qwen3-8b-4bit",
        "name": "Qwen3 8B (4-bit)",
        "provider": "ollama",
        "model_identifier": "qwen3:8b",
        "type": "reasoning",
        "capabilities": ["planning", "reasoning", "structured_output", "tool_use"],
        # Deliberately not the model's maximum. The spec is explicit: keep
        # context to 4k-8k on this card rather than exploiting a large window.
        "context_length": 8192,
        "quantization": "Q4_K_M",
        "vram_required_gb": 6.5,
        "supported_modalities": ["text"],
        "benchmark_score": 0.82,
        "latency_score": 0.65,
        "reliability_score": 0.90,
        "notes": "Primary planner and agent JSON producer.",
    },
    {
        "id": "vision-gemma3-4b-q4",
        "name": "Gemma 3 4B (Q4)",
        "provider": "ollama",
        "model_identifier": "gemma3:4b",
        "type": "vision",
        "capabilities": ["vision", "ocr_postprocess", "summarisation", "reasoning"],
        "context_length": 8192,
        "quantization": "Q4_K_M",
        "vram_required_gb": 3.0,
        "supported_modalities": ["text", "image"],
        "benchmark_score": 0.74,
        "latency_score": 0.78,
        "reliability_score": 0.88,
        "notes": "Scanned pages, P&ID drawings, tables. Lighter than an 8B VLM.",
    },
    {
        "id": "coder-qwen25-coder-7b-q4",
        "name": "Qwen2.5 Coder 7B (Q4)",
        "provider": "ollama",
        "model_identifier": "qwen2.5-coder:7b",
        "type": "coding",
        "capabilities": ["code_generation", "code_explanation", "structured_output"],
        "context_length": 8192,
        "quantization": "Q4_K_M",
        "vram_required_gb": 5.5,
        "supported_modalities": ["text"],
        "benchmark_score": 0.79,
        "latency_score": 0.70,
        "reliability_score": 0.86,
        "notes": "Writes code the Part 04 sandbox executes; never asked to compute.",
    },
    {
        "id": "embed-bge-small",
        "name": "BGE Small (embeddings)",
        "provider": "ollama",
        "model_identifier": "bge-m3",
        "type": "embedding",
        "capabilities": ["embedding"],
        "context_length": 8192,
        "quantization": "F16",
        "vram_required_gb": 1.2,
        "supported_modalities": ["text"],
        "benchmark_score": 0.75,
        "latency_score": 0.95,
        "reliability_score": 0.95,
        "notes": "Cheap enough to stay resident alongside a heavyweight model.",
    },
    {
        "id": "rerank-bge-v2-m3",
        "name": "BGE Reranker v2 m3 (cross-encoder)",
        # A true cross-encoder needs a rerank endpoint. Ollama has none, so
        # this row stays unavailable on the dev laptop and Part 03 falls back
        # to scoring through a reasoning model. It becomes ready by itself the
        # day vLLM serves it -- no code change, which is the point of putting
        # it in the catalogue now rather than later.
        "provider": "vllm",
        "model_identifier": "BAAI/bge-reranker-v2-m3",
        "type": "reranking",
        "capabilities": ["reranking"],
        "context_length": 8192,
        "quantization": "F16",
        "vram_required_gb": 1.2,
        "supported_modalities": ["text"],
        "benchmark_score": 0.88,
        "latency_score": 0.80,
        "reliability_score": 0.92,
        "notes": "Retrieval precision. Requires vLLM; no Ollama equivalent.",
    },
]


# --- 6 GB class (e.g. RTX 3050) -------------------------------------------
# The reasoner drops to a 4B-class model: the spec says test an 8B at 4-bit and
# fall back if marginal, and on 6 GB it is marginal once KV cache is counted.

_SIX_GB: list[CatalogEntry] = [
    {
        "id": "reasoner-qwen3-4b-q4",
        "name": "Qwen3 4B (Q4)",
        "provider": "ollama",
        "model_identifier": "qwen3:4b",
        "type": "reasoning",
        "capabilities": ["planning", "reasoning", "structured_output", "tool_use"],
        "context_length": 4096,
        "quantization": "Q4_K_M",
        "vram_required_gb": 3.4,
        "supported_modalities": ["text"],
        "benchmark_score": 0.71,
        "latency_score": 0.80,
        "reliability_score": 0.88,
        "notes": "Smaller reasoner: an 8B at 4-bit is marginal on a 6 GB card.",
    },
    {
        "id": "vision-gemma3-4b-q4",
        "name": "Gemma 3 4B (Q4)",
        "provider": "ollama",
        "model_identifier": "gemma3:4b",
        "type": "vision",
        "capabilities": ["vision", "ocr_postprocess", "summarisation", "reasoning"],
        "context_length": 4096,
        "quantization": "Q4_K_M",
        "vram_required_gb": 3.0,
        "supported_modalities": ["text", "image"],
        "benchmark_score": 0.74,
        "latency_score": 0.78,
        "reliability_score": 0.88,
        "notes": "Still the safest vision choice at this VRAM class.",
    },
    {
        "id": "coder-qwen25-coder-3b-q4",
        "name": "Qwen2.5 Coder 3B (Q4)",
        "provider": "ollama",
        "model_identifier": "qwen2.5-coder:3b",
        "type": "coding",
        "capabilities": ["code_generation", "code_explanation"],
        "context_length": 4096,
        "quantization": "Q4_K_M",
        "vram_required_gb": 2.4,
        "supported_modalities": ["text"],
        "benchmark_score": 0.68,
        "latency_score": 0.85,
        "reliability_score": 0.84,
        "notes": "CPU fallback is acceptable here if VRAM is the bottleneck.",
    },
    {
        "id": "embed-bge-small",
        "name": "BGE Small (embeddings)",
        "provider": "ollama",
        "model_identifier": "bge-m3",
        "type": "embedding",
        "capabilities": ["embedding"],
        "context_length": 4096,
        "quantization": "F16",
        "vram_required_gb": 1.2,
        "supported_modalities": ["text"],
        "benchmark_score": 0.75,
        "latency_score": 0.95,
        "reliability_score": 0.95,
        "notes": "Cheap enough to stay resident alongside a heavyweight model.",
    },
    {
        "id": "rerank-bge-v2-m3",
        "name": "BGE Reranker v2 m3 (cross-encoder)",
        # A true cross-encoder needs a rerank endpoint. Ollama has none, so
        # this row stays unavailable on the dev laptop and Part 03 falls back
        # to scoring through a reasoning model. It becomes ready by itself the
        # day vLLM serves it -- no code change, which is the point of putting
        # it in the catalogue now rather than later.
        "provider": "vllm",
        "model_identifier": "BAAI/bge-reranker-v2-m3",
        "type": "reranking",
        "capabilities": ["reranking"],
        "context_length": 8192,
        "quantization": "F16",
        "vram_required_gb": 1.2,
        "supported_modalities": ["text"],
        "benchmark_score": 0.88,
        "latency_score": 0.80,
        "reliability_score": 0.92,
        "notes": "Retrieval precision. Requires vLLM; no Ollama equivalent.",
    },
]


# --- No usable GPU --------------------------------------------------------
# Small models only. Everything still runs, just slowly -- which is the right
# behaviour for a laptop without CUDA rather than refusing to start.

_CPU: list[CatalogEntry] = [
    {
        "id": "reasoner-qwen3-1_7b-q4",
        "name": "Qwen3 1.7B (Q4)",
        "provider": "ollama",
        "model_identifier": "qwen3:1.7b",
        "type": "reasoning",
        "capabilities": ["planning", "reasoning", "structured_output"],
        "context_length": 4096,
        "quantization": "Q4_K_M",
        "vram_required_gb": 0.0,
        "supported_modalities": ["text"],
        "benchmark_score": 0.55,
        "latency_score": 0.35,
        "reliability_score": 0.80,
        "notes": "CPU inference. Usable for development, not for the demo.",
    },
    {
        "id": "embed-bge-small",
        "name": "BGE Small (embeddings)",
        "provider": "ollama",
        "model_identifier": "bge-m3",
        "type": "embedding",
        "capabilities": ["embedding"],
        "context_length": 4096,
        "quantization": "F16",
        "vram_required_gb": 0.0,
        "supported_modalities": ["text"],
        "benchmark_score": 0.75,
        "latency_score": 0.60,
        "reliability_score": 0.95,
        "notes": "CPU inference.",
    },
]


CATALOGUES: dict[VramTier, list[CatalogEntry]] = {
    "8gb": _EIGHT_GB,
    "6gb": _SIX_GB,
    "cpu": _CPU,
}


def tier_for_vram(total_vram_gb: float) -> VramTier:
    """Pick the catalogue that matches the card actually present."""
    if total_vram_gb >= 7.0:
        return "8gb"
    if total_vram_gb >= 5.0:
        return "6gb"
    return "cpu"


def catalogue_for(total_vram_gb: float) -> list[CatalogEntry]:
    return CATALOGUES[tier_for_vram(total_vram_gb)]
