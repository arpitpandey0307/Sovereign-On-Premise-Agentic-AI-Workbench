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

    # Model runtimes. Both must be loopback or a compose service name --
    # the provider adapters refuse anything else.
    ollama_base_url: str = "http://127.0.0.1:11434"
    vllm_base_url: str = ""
    # Startup asks the runtime what it holds. Disabled in tests so the
    # suite never depends on a model daemon being up.
    refresh_model_registry_on_startup: bool = True

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
