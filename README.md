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
  app/db/           Part 01  SQLAlchemy models, repositories, migrations
  app/models/       Part 02  registry, provider adapters, model service
  app/routing/      Part 02  router, scoring, hardware probe, policy wrapper
  app/documents/    Part 03  ingestion, OCR, chunking, embedding
  app/knowledge/    Part 03  Neo4j knowledge graph, retrieval, rerank
  app/orchestration/Part 04  LangGraph-style executor, run state
  app/tools/        Part 04  tool registry and artifact generators
  app/sandbox/      Part 04  isolated code execution
  app/security/     Part 05  RBAC, policy engine, classification
  app/audit/        Part 05  append-only ledger, network egress monitor
  app/integrations/ the ports every part plugs into
  docs/             per-part design notes and the testing guide
  scripts/          demo corpus builders and standalone verify_*.py probes
  tests/

frontend/         React single-page app, builds to static files
  src/lib/          api client, auth, theme, types
  src/components/   design system, shell, state views
  src/pages/        login through workbench, documents, security, settings
  e2e/              Playwright hero flow
```

`backend/README.md` covers the full API surface and the model-routing design.
`frontend/README.md` covers the client and the two decisions worth knowing.

## Status

All five parts are implemented and running in one process. `GET
/api/v1/system/status` reports each one `live` rather than `stub`.

| Part | Scope | Status |
|---|---|---|
| 01 | API gateway, auth, conversations, tasks, file uploads, SSE | ✅ live |
| 02 | Model registry, smart router, Ollama/vLLM adapters | ✅ live |
| 03 | Document ingestion, OCR, Neo4j knowledge graph + RAG | ✅ live |
| 04 | Orchestration, tools, sandbox, artifact generation | ✅ live |
| 05 | RBAC, policy engine, audit ledger, sovereignty proof | ✅ live |

Verified on the current commit:

- **Backend** — 369 tests passing, `ruff check` clean.
- **Frontend** — 176 tests passing (15 skipped: they need a live API),
  `tsc -b` clean, production build succeeds.
- **Database** — 7 Alembic migrations apply in order and reverse to base
  cleanly; `--autogenerate` against the migrated schema produces an empty
  revision, so there is no model drift.
- **API** — 41 paths in the published schema; the `/internal/*` operational
  routes are deliberately absent from it.

## Getting started

Two processes: the API, and the client that talks to it.

### Backend

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

Defaults to SQLite so it runs with no external services.

### Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, API proxied to 127.0.0.1:8000
```

`/api`, `/health` and `/internal` are proxied in development, so the app is
same-origin in both environments and there is no base URL to get wrong.
Checks: `npm test` · `npm run typecheck` · `npm run build`.

### Everything at once

`docker compose up` from `backend/` brings up PostgreSQL, Neo4j, MinIO and the
API together, each bound to `127.0.0.1` and taking its credentials from the
environment. The same application code runs against SQLite and the filesystem
when those services are absent.

## Local models

Part 02 seeds a model catalogue matched to the GPU actually present, in three
tiers: 7 GB of VRAM and above, 5 GB and above, and a CPU-sized fallback below
that. On an 8 GB card it expects:

```bash
ollama pull qwen3:8b            # reasoning / planning / agent JSON
ollama pull gemma3:4b           # vision: scanned pages, P&IDs
ollama pull qwen2.5-coder:7b    # code for the Part 04 sandbox to execute
ollama pull bge-m3              # embeddings for the Part 03 vector index
```

Retrieval also scores candidates with a `bge-reranker-v2-m3` cross-encoder, and
falls back to lexical ranking with a stated diagnostic when it is unavailable.

Until the models are pulled the registry reports them unavailable and the
router correctly refuses to route — check `GET /internal/models/health`.

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
- **Side material stays out of the repository.** Slide decks, exported images
  and personal files live under the ignored `local-only/` directory; planning
  documents live beside `context-backend/`. Neither is part of the application.

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
- Compose binds Postgres, Neo4j, MinIO and the API to `127.0.0.1` and takes
  credentials from the environment — no database password is committed.
- The session token lives in `sessionStorage`, not `localStorage`: this runs on
  shared industrial workstations, and the token should not outlive the browser
  session for whoever sits down next.
- Permissions decide what the client *shows*, never what is *allowed*. The
  backend re-checks every call.

The server-side items above are each covered by one of the 34 regression tests
in `backend/tests/test_security.py`, so a hole cannot silently reopen. Token
storage is covered in `frontend/src/test/api.test.ts`. The compose bindings are
configuration, not behaviour, and are not test-enforced — read
`backend/docker-compose.yml` before deploying it anywhere.
