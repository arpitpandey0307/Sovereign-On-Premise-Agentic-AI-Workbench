# Sovereign On-Premise Agentic AI Workbench

**SIH 2026 · PS26117** — Smart Automation
**Problem owner:** Mangalore Refinery and Petrochemicals Limited (MRPL)

A self-hosted, air-gapped-by-design AI workbench. An engineer uploads
confidential documents — scanned inspection reports, P&IDs, spreadsheets — and
gets real agentic work done against locally hosted open-weight models: multi-step
reasoning, code execution, document generation. **Zero external network calls,
with an audit trail that proves it.**

## Repository layout

```
backend/          FastAPI modular monolith — all five parts, one process
  app/api/          Part 01  HTTP surface (the only part exposing routes)
  app/core/         Part 01  config, auth, storage, events, errors
  app/db/           Part 01  SQLAlchemy models and repositories
  app/models/       Part 02  registry, provider adapters, model service
  app/routing/      Part 02  router, scoring, hardware probe, policy wrapper
  app/integrations/ the ports every part plugs into
  tests/
```

Read **[`backend/README.md`](backend/README.md)** for the full API surface,
architecture and the model-routing design.

## Status

| Part | Scope | Status |
|---|---|---|
| 01 | API gateway, auth, conversations, tasks, file uploads, SSE | ✅ complete |
| 02 | Model registry, smart router, Ollama/vLLM adapters | ✅ complete |
| 03 | Document ingestion, OCR, Neo4j knowledge graph + RAG | ⬜ not started |
| 04 | LangGraph orchestration, tools, sandbox, artifacts | ⬜ not started |
| 05 | RBAC, policy engine, audit ledger, sovereignty proof | ⬜ not started |

Parts 03–05 have working placeholders, so the API runs end to end today.
`GET /health` reports which parts are still stubs.

47 tests passing · `ruff` clean · Alembic migrations with no model drift.

## Getting started

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate            # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements-dev.txt

cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"    # paste into JWT_SECRET_KEY

uvicorn app.main:app --reload
```

- API docs: <http://127.0.0.1:8000/docs> (only when `ENABLE_API_DOCS=true`)
- Demo login: `admin@mrpl.local` / `workbench` — **local development only**;
  the app refuses to seed this account unless `DEBUG=true`
- Tests: `pytest -q` · Lint: `ruff check app tests`

Defaults to SQLite so it runs with no external services. `docker compose up`
points the same models at PostgreSQL.

## Local models

Part 02 seeds a model catalogue matched to the GPU actually present. On an
8 GB card it expects:

```bash
ollama pull qwen3:8b            # reasoning / planning / agent JSON
ollama pull gemma3:4b           # vision: scanned pages, P&IDs
ollama pull qwen2.5-coder:7b    # code for the Part 04 sandbox to execute
ollama pull bge-m3              # embeddings for the Part 03 vector index
```

Until these are pulled the registry reports them unavailable and the router
correctly refuses to route — check `GET /internal/models/health`.

## Ground rules

- **No external network calls, ever.** Provider adapters reject any non-loopback
  endpoint at construction. This is the project's central claim; treat it as a
  hard constraint, not a default.
- **Build interfaces, not dependencies.** Parts talk through the protocols in
  `app/integrations/ports.py` — never by importing another part's internals.
- **Never commit `.env`,** local databases, uploaded files, or key material.
  `.env.example` is the template to copy.
- **Fail closed.** An undefined permission is denied, not allowed. Placeholders
  for parts that are not built yet must not be more permissive than the real
  thing will be.

## Security posture

| Surface | Exposure |
|---|---|
| `GET /health` | public, liveness only — `{"status": "ok"}` and nothing else |
| `/docs`, `/redoc`, `/openapi.json` | disabled unless `ENABLE_API_DOCS=true` |
| `/api/v1/*` | authenticated, permission-checked per endpoint |
| `/api/v1/system/status` | `ADMIN` / `SECURITY_ADMIN` only |
| `/internal/*` | `ADMIN` only, and kept out of the published schema |

- Login is throttled per account **and** per source: five failures locks that
  key out, and the lockout applies to the correct password too, so an attacker
  cannot read success from a changed response.
- Validation errors report which field failed, never the value submitted.
- Unhandled exceptions return a generic message; detail goes to the log.
- Model provider adapters refuse any non-loopback endpoint at construction.
- Compose binds Postgres and the API to `127.0.0.1` and takes credentials from
  the environment — no database password is committed.
