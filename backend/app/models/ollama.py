"""Ollama adapter -- the development and demo runtime.

Ollama binds to loopback and is never given an outbound route: the sovereignty
claim depends on the model endpoint being on this machine, so the base URL is
validated as local at construction rather than trusted.
"""

from __future__ import annotations

import base64
import logging
import time
from urllib.parse import urlparse

import httpx

from app.models.base import (
    ModelRequest,
    ModelResponse,
    ModelUnavailableError,
    ProviderError,
    coerce_structured,
)

logger = logging.getLogger("workbench.ollama")

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "host.docker.internal"}


class OllamaProvider:
    name = "ollama"

    def __init__(self, base_url: str = "http://127.0.0.1:11434") -> None:
        host = urlparse(base_url).hostname or ""
        if host not in LOCAL_HOSTS and not host.startswith("ollama"):
            # "ollama" is the compose service name; anything else would mean
            # confidential prompts leaving the machine.
            raise ValueError(
                f"Refusing a non-local model endpoint: {base_url}. "
                "This system must not send prompts off-host."
            )
        self.base_url = base_url.rstrip("/")

    async def is_reachable(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def loaded_models(self) -> list[str]:
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("could not list local models: %s", exc)
            return []
        return [entry.get("name", "") for entry in payload.get("models", [])]

    async def resident_models(self) -> list[dict]:
        """Models currently held in VRAM, from Ollama's /api/ps."""
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                response = await client.get(f"{self.base_url}/api/ps")
                response.raise_for_status()
                return response.json().get("models", [])
        except (httpx.HTTPError, ValueError):
            return []

    async def generate(self, request: ModelRequest) -> ModelResponse:
        payload: dict = {
            "model": request.model_id,
            "prompt": request.prompt,
            "stream": False,
            "options": {
                "temperature": request.temperature,
                "num_predict": request.max_tokens,
            },
        }
        if request.system:
            payload["system"] = request.system
        if request.images:
            payload["images"] = [
                base64.b64encode(image).decode("ascii") for image in request.images
            ]
        if request.response_schema is not None:
            # Ollama accepts a JSON schema here and constrains decoding to it,
            # which is what makes Part 04's planner parseable.
            payload["format"] = request.response_schema

        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=request.timeout_s) as client:
                response = await client.post(
                    f"{self.base_url}/api/generate", json=payload
                )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                f"{request.model_id} exceeded {request.timeout_s:.0f}s",
                model_id=request.model_id,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"local runtime unreachable: {exc}", model_id=request.model_id
            ) from exc

        latency_ms = int((time.perf_counter() - started) * 1000)

        if response.status_code == 404:
            raise ModelUnavailableError(
                f"{request.model_id} is not pulled locally", model_id=request.model_id
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"runtime returned {response.status_code}: {response.text[:200]}",
                model_id=request.model_id,
            )

        body = response.json()
        text = body.get("response", "")

        structured, satisfied = (None, False)
        if request.response_schema is not None:
            structured, satisfied = coerce_structured(text)

        return ModelResponse(
            text=text,
            structured=structured,
            latency_ms=latency_ms,
            tokens_used=body.get("eval_count", 0) + body.get("prompt_eval_count", 0),
            model_id=request.model_id,
            schema_satisfied=satisfied,
        )

    async def embed(self, model_id: str, texts: list[str]) -> list[list[float]]:
        """Used by Part 03 for the Neo4j vector index."""
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{self.base_url}/api/embed",
                    json={"model": model_id, "input": texts},
                )
                response.raise_for_status()
                return response.json().get("embeddings", [])
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(
                f"embedding call failed: {exc}", model_id=model_id
            ) from exc
