"""vLLM adapter -- the lab GPU runtime, Phase 2.

Written now and kept to the same protocol so the swap is a registry field and
a compose entry, not a code change. vLLM exposes an OpenAI-compatible API and
supports guided decoding, which gives stronger structured-output guarantees
than the dev runtime.
"""

from __future__ import annotations

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
from app.models.ollama import LOCAL_HOSTS

logger = logging.getLogger("workbench.vllm")


class VLLMProvider:
    name = "vllm"

    def __init__(self, base_url: str = "http://127.0.0.1:8100") -> None:
        host = urlparse(base_url).hostname or ""
        if host not in LOCAL_HOSTS and not host.startswith("vllm"):
            raise ValueError(
                f"Refusing a non-local model endpoint: {base_url}. "
                "This system must not send prompts off-host."
            )
        self.base_url = base_url.rstrip("/")

    async def is_reachable(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/v1/models")
            return response.status_code == 200
        except httpx.HTTPError:
            return False

    async def loaded_models(self) -> list[str]:
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                response = await client.get(f"{self.base_url}/v1/models")
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("could not list vLLM models: %s", exc)
            return []
        return [entry.get("id", "") for entry in payload.get("data", [])]

    async def generate(self, request: ModelRequest) -> ModelResponse:
        content: list[dict] | str = request.prompt
        if request.images:
            import base64

            content = [{"type": "text", "text": request.prompt}]
            for image in request.images:
                encoded = base64.b64encode(image).decode("ascii")
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{encoded}"},
                    }
                )

        messages = []
        if request.system:
            messages.append({"role": "system", "content": request.system})
        messages.append({"role": "user", "content": content})

        payload: dict = {
            "model": request.model_id,
            "messages": messages,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
        }
        if request.response_schema is not None:
            # Guided decoding: the runtime constrains generation to the schema
            # rather than hoping the model complies.
            payload["guided_json"] = request.response_schema

        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=request.timeout_s) as client:
                response = await client.post(
                    f"{self.base_url}/v1/chat/completions", json=payload
                )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                f"{request.model_id} exceeded {request.timeout_s:.0f}s",
                model_id=request.model_id,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                f"vLLM unreachable: {exc}", model_id=request.model_id
            ) from exc

        latency_ms = int((time.perf_counter() - started) * 1000)

        if response.status_code == 404:
            raise ModelUnavailableError(
                f"{request.model_id} is not served by this vLLM instance",
                model_id=request.model_id,
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"vLLM returned {response.status_code}: {response.text[:200]}",
                model_id=request.model_id,
            )

        body = response.json()
        choices = body.get("choices") or [{}]
        text = choices[0].get("message", {}).get("content", "")
        usage = body.get("usage", {})

        structured, satisfied = (None, False)
        if request.response_schema is not None:
            structured, satisfied = coerce_structured(text)

        return ModelResponse(
            text=text,
            structured=structured,
            latency_ms=latency_ms,
            tokens_used=usage.get("total_tokens", 0),
            model_id=request.model_id,
            schema_satisfied=satisfied,
        )
