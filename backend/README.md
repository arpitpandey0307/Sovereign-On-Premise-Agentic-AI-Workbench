# Sovereign On-Premise Agentic AI Workbench — Backend

Self-hosted, air-gapped-by-design AI workbench for confidential industrial
work. All five backend parts run inside one FastAPI process (a modular
monolith); each part owns a folder and talks to the others only through the
interfaces in `app/integrations/ports.py`.

| Part | Folder | Status |
|---|---|---|
| 01 Foundation — API, auth, conversations, tasks, files | `app/api`, `app/core`, `app/db` | complete |
| 02 Model layer & routing | `app/models`, `app/routing` | complete |
| 03 Documents & knowledge (Neo4j RAG) | `app/documents`, `app/knowledge` | stubbed |
| 04 Orchestration, tools, sandbox | `app/orchestration`, `app/tools` | stubbed |
| 05 Security, policy, audit | `app/security`, `app/audit` | stubbed |

`GET /health` is a bare public liveness probe. The detailed picture — which
parts are placeholders, whether the model runtime answers, how many event
buffers are retained — is behind auth on `GET /api/v1/system/status`, for
`ADMIN` and `SECURITY_ADMIN`.

## Running locally

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements-dev.txt      # or requirements.txt for runtime only

cp .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(48))"   # paste into JWT_SECRET_KEY

uvicorn app.main:app --reload
```

Interactive API docs: <http://127.0.0.1:8000/docs> — served only when
`ENABLE_API_DOCS=true`, since the schema names every route including the
operational ones. `.env.example` enables it for local development.

Uploads and generated artifacts go to the local filesystem by default, which
needs nothing running. `STORAGE_BACKEND=minio` switches to object storage;
compose sets it for the containerised api. A configured but unreachable MinIO
falls back to the filesystem rather than taking the API down, and
`/api/v1/system/status` reports which backend is actually in use.

The default `DATABASE_URL` is SQLite, so the API runs with no external
services. Docker Compose points the same SQLAlchemy models at PostgreSQL
and brings up Neo4j for the knowledge index (set `NEO4J_PASSWORD` first —
compose refuses to start without it):

```bash
docker compose up --build
```

On an empty database the app seeds the five roles and one demo account
(`admin@mrpl.local` / `workbench`). Set `SEED_DEMO_USER=false` for any
deployment that is not the demo.

The knowledge index and the code sandbox run separately, and the test suite
pins them off so its results never depend on what happens to be running. Each
has its own check against the real thing:

```bash
docker compose up -d neo4j
docker pull python:3.12-slim

python scripts/verify_neo4j.py     # the graph index, against a live server
python scripts/verify_sandbox.py   # sandbox confinement, against real Docker
python scripts/verify_vision.py    # the vision pass, against a real model
python scripts/verify_hero.py      # the demo workflow, end to end
python scripts/verify_sovereignty.py  # zero external calls, provably watched
python scripts/verify_storage.py   # MinIO round trip (see its docstring)
```

## Database migrations

`init_db()` calls `create_all()` on startup, which is enough while schemas are
still moving. Alembic is configured and holds the initial migration; it reads
`DATABASE_URL` from application settings rather than `alembic.ini`, so it
always targets the same database the app uses.

```bash
alembic upgrade head                       # apply
alembic revision --autogenerate -m "..."   # after changing a model
alembic check                              # fail if models drift from migrations
```

## Tests and linting

`docs/testing.md` is the full runbook: what to run, in what order, what
good looks like, and how to check the refusals rather than only the happy
path.

```bash
pytest -q
ruff check app tests
```

## API surface

```
POST   /api/v1/auth/login             GET    /api/v1/auth/me
POST   /api/v1/auth/logout

POST   /api/v1/conversations          GET    /api/v1/conversations
GET    /api/v1/conversations/{id}     POST   /api/v1/conversations/{id}/messages

POST   /api/v1/files/upload           GET    /api/v1/files
GET    /api/v1/files/{id}             DELETE /api/v1/files/{id}

POST   /api/v1/tasks                  GET    /api/v1/tasks
GET    /api/v1/tasks/{id}             POST   /api/v1/tasks/{id}/cancel
POST   /api/v1/tasks/{id}/resume
GET    /api/v1/tasks/{id}/events      -- SSE stream of AgentEvent
GET    /api/v1/tasks/{id}/trace       -- historical trace from the audit ledger

GET    /api/v1/artifacts/{id}         GET    /api/v1/artifacts/{id}/download
GET    /api/v1/tasks/{id}/execution   -- the orchestrator's own trace
GET    /api/v1/tasks/{id}/artifacts   -- what the task produced
GET    /api/v1/tools                  -- the tool catalogue and its risks
GET    /internal/sandbox/status       -- code execution and its confinement

GET    /api/v1/security/status        -- policy in force and egress observed
GET    /api/v1/security/sovereignty   -- the network monitor widget
GET    /api/v1/security/network-events-- external attempts actually seen
GET    /api/v1/security/audit         -- the audit log viewer
GET    /api/v1/security/permissions   -- what the calling user may do
GET    /api/v1/tasks/{id}/receipt     -- the task receipt, from the ledger

GET    /api/v1/documents              -- the knowledge-base list
GET    /api/v1/documents/{id}         -- one document, its pages and its tags
GET    /api/v1/documents/{id}/pages/{n}
POST   /api/v1/documents/reingest/{file_id}
POST   /api/v1/knowledge/search       -- hybrid retrieval, returns Evidence
GET    /api/v1/knowledge/equipment/{tag}  -- P&ID graph traversal
GET    /internal/knowledge/status     -- index reachability and corpus size

GET    /api/v1/models                 -- the model registry
GET    /api/v1/models/{id}            -- one model plus its measured performance
POST   /api/v1/models/route           -- what the router would pick, and why
GET    /internal/models/health        -- GPU state, runtime reachability, readiness
POST   /internal/models/refresh       -- re-seed and reconcile the catalogue

GET    /api/v1/system/status          -- operator detail (ADMIN/SECURITY_ADMIN)
GET    /health                        -- public liveness probe, {"status": "ok"}
```

A task is returned as `task_id`, matching the shared `Task` contract in
`app/schemas/shared.py`. `id` is serialised alongside it, so a client written
against either name works.

Every error shares one envelope — including 404s on unknown routes and
unhandled exceptions — so the frontend never parses a second shape:

```json
{"error": {"code": "permission_denied", "message": "...", "details": {}}}
```

Codes in use: `unauthenticated`, `permission_denied`, `not_found`, `conflict`,
`payload_too_large`, `unsupported_media_type`, `validation_error`,
`method_not_allowed`, `internal_error`. An unhandled exception returns a
generic message and logs the detail server-side — on a system holding
confidential work, internals must not reach the client.

## How the other parts attach

Part 01 depends on seven protocols in `app/integrations/ports.py` and resolves
them through `app/integrations/registry.py`. Placeholders in
`app/integrations/stubs.py` keep the API runnable end to end today; each part
replaces its own by calling the matching `register_*` function at startup.

```python
from app.integrations import registry
registry.register_orchestrator(LangGraphOrchestrator())   # Part 04
```

Nothing else in Part 01 changes when a real implementation lands.

| Port | Owner | Placeholder |
|---|---|---|
| `ModelPort` | Part 02 | **live** — `ModelLayer` over the real registry |
| `DocumentsPort` | Part 03 | **live** — `DocumentPipeline`, the real ingestion pipeline |
| `KnowledgePort` | Part 03 | **live** — `KnowledgeService`, hybrid retrieval |
| `OrchestratorPort` | Part 04 | **live** — `LangGraphOrchestrator` |
| `ArtifactsPort` | Part 04 | **live** — `ArtifactStore` |
| `PolicyPort` | Part 05 | **live** — `PolicyEngine` |
| `AuditPort` | Part 05 | **live** — `AuditLedger`, append-only |

Every port is now served by its real implementation. The placeholders remain
for reference, and the policy placeholder was changed to **deny everything**
once Part 05 landed: a second copy of the security rules would be a second
source of truth, and if those denials appear in a log the policy engine did
not start — which should be loud, not a quiet downgrade.


## The model layer (Part 02)

The rest of the system never names a runtime. Part 04 hands `ModelService` a
`TaskRequirements` and gets back an answer plus the reasoning behind it.

### Routing

Three filters run in a fixed order, and the order carries the policy:

1. **Capability** — a model that cannot do the job is not a candidate at any price.
2. **Policy** (Part 05) — a model not cleared for the data is not a candidate however good it is. Quality never overrides classification.
3. **Hardware** — a model that will not load is not a candidate either. Free VRAM is measured live, minus CUDA overhead and KV-cache headroom.

Survivors are ranked by the seven-factor weighted score from the spec
(`task_accuracy` .30, `capability_match` .20, `context_fit` .15, `latency` .10,
`resource_efficiency` .10, `historical_success` .10, `reliability` .05). Ties
break toward the **smaller** model: leaving VRAM free is what lets the vision
model run beside the reasoner on an 8 GB card.

Every decision records what it considered, why each model was excluded and at
which stage, the full score breakdown, and a fallback chain. `POST
/api/v1/models/route` returns exactly that payload — it is what fills the
frontend's "why was this model chosen" panel.

### The feedback loop

Every generation writes its outcome to `model_stats`: successes, failures,
malformed-JSON replies, and an exponentially weighted latency average, keyed by
model *and* task type. The next routing decision reads those numbers back
through the `historical_success`, `latency` and `reliability` factors, so a
model that starts failing is demoted without anyone editing a config.

If the chosen model fails at generation time, the service walks the fallback
chain automatically and marks the failed model unavailable.

### Catalogue

The catalogue is seeded from the GPU actually present — an 8 GB plan, a 6 GB
plan, and a CPU-only plan — so the same code installs the right models on
whichever machine runs the demo. Models are marked `ready` only when the
runtime confirms it holds them; an unpulled model is never routed to, and the
status carries the `ollama pull` command that would fix it.

### Sovereignty

Both provider adapters refuse a non-loopback endpoint at construction. The
check is enforced rather than assumed, and it is covered by a test.
