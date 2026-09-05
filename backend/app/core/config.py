"""Application settings, loaded from the environment or a local .env file."""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "Sovereign AI Workbench"
    api_v1_prefix: str = "/api/v1"
    debug: bool = False

    database_url: str = "sqlite:///./sih.db"

    jwt_secret_key: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 480

    storage_root: Path = Path("./storage")
    max_upload_size_mb: int = 100

    # OCR engine (Part 03). Empty means "find it on PATH"; set it
    # explicitly when the installer did not add it there.
    tesseract_cmd: str = ""

    # Vision pass (Part 03). Pages holding a drawing, a photo or a dense
    # table get looked at by a vision model rather than trusted to OCR alone.
    # It is capped per document because a VLM pass costs seconds and VRAM on
    # an 8 GB card, and a 200-page scan would otherwise stall ingestion.
    enable_vision_pass: bool = True
    vision_pass_max_pages: int = 5

    # Reranking (Part 03). A model-scored rerank improves precision but adds a
    # model call to every search; turning it off leaves the lexical reranker,
    # which is free and still breaks the V-103/V-104 tie.
    enable_model_rerank: bool = True

    # Approval gates (Part 04). A deliverable drawn from CONFIDENTIAL or
    # higher material waits for a person before it is produced. Turning this
    # off is a deliberate decision, not a default -- the audit trail records
    # an unapproved artifact either way.
    require_approval_above_internal: bool = True
    # Code execution (Part 04). The sandbox is network-disabled by
    # construction; this switch is for a host with no Docker at all.
    enable_code_sandbox: bool = True

    # Neo4j (Part 03). Loopback only, like every other dependency here.
    neo4j_uri: str = "bolt://127.0.0.1:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = ""
    neo4j_database: str = "neo4j"

    # Model runtimes. Both must be loopback or a compose service name --
    # the provider adapters refuse anything else.
    ollama_base_url: str = "http://127.0.0.1:11434"
    vllm_base_url: str = ""
    # Startup asks the runtime what it holds. Disabled in tests so the
    # suite never depends on a model daemon being up.
    refresh_model_registry_on_startup: bool = True

    # Interactive docs publish the entire API surface, internal routes
    # included. Off unless deliberately enabled -- .env.example turns it
    # on for local development.
    enable_api_docs: bool = False

    allow_external_network: bool = False
    # NoDecode: the env value is a comma-separated list, not JSON, so the
    # validator below owns the parsing.
    cors_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:3000",
        "http://localhost:5173",
    ]

    # Convenience for the demo build: create one account on an empty database
    # so the frontend has something to log in with. Turn off for any real
    # deployment and provision users deliberately.
    seed_demo_user: bool = True
    seed_admin_email: str = "admin@mrpl.local"
    seed_admin_password: str = "workbench"

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @model_validator(mode="after")
    def _guard_signing_key(self) -> Settings:
        # HS256 keys shorter than the hash output weaken the signature
        # (RFC 7518 section 3.2), and the shipped placeholder is public.
        weak = len(self.jwt_secret_key.encode()) < 32
        placeholder = self.jwt_secret_key == "change-me-in-production"
        if (weak or placeholder) and not self.debug:
            raise ValueError(
                "JWT_SECRET_KEY must be a unique value of at least 32 bytes. "
                "Generate one with: python -c \"import secrets; "
                'print(secrets.token_urlsafe(48))"'
            )
        if weak or placeholder:
            logging.getLogger("workbench").warning(
                "JWT_SECRET_KEY is weak or still the placeholder. "
                "This is tolerated only because DEBUG is on."
            )
        return self

    @property
    def max_upload_size_bytes(self) -> int:
        return int(self.max_upload_size_mb * 1024 * 1024)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.storage_root.mkdir(parents=True, exist_ok=True)
    return settings


settings = get_settings()
