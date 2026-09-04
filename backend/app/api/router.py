"""Aggregates every Part 01 router under the versioned prefix.

No other part mounts HTTP routes. Parts 02-05 expose Python interfaces that
this part or the orchestrator calls.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api import artifacts, auth, conversations, files, tasks
from app.core.config import settings

api_router = APIRouter(prefix=settings.api_v1_prefix)

api_router.include_router(auth.router)
api_router.include_router(conversations.router)
api_router.include_router(files.router)
api_router.include_router(tasks.router)
api_router.include_router(artifacts.router)
