# Testing the backend

Four levels, cheapest first. Each answers a different question, and running
them in order means a failure at one level explains failures at the next.

| level | question it answers | needs |
|---|---|---|
| 1. unit suite | is the logic correct? | nothing |
| 2. verification scripts | do the real services behave as claimed? | Docker, Ollama |
| 3. by hand | is it wired end to end over HTTP? | the server running |
| 4. the one-glance check | is everything live right now? | the server running |

---

## Level 0 — is the machine ready

```bash
ollama list                      # bge-m3, qwen3:8b, gemma3:4b, qwen2.5-coder:7b
docker ps                        # neo4j, postgres, minio -- all (healthy)
tesseract --version              # 5.x
nvidia-smi --query-gpu=memory.free --format=csv
```

If the containers are not up:

```bash
cd backend
docker compose up -d neo4j postgres minio
docker pull python:3.12-slim     # the sandbox image, needed once
```

`.env` must have `NEO4J_PASSWORD`, `POSTGRES_PASSWORD`, `MINIO_ACCESS_KEY` and
`MINIO_SECRET_KEY` set — compose refuses to start without them, deliberately.

---

## Level 1 — the unit suite

```bash
cd backend
.venv/Scripts/python -m pytest tests/ -q          # ~2 min, 315 tests
```

It needs **no services at all**: Neo4j, the model runtime and the egress
monitor are pinned off in `tests/conftest.py`, so the result does not depend
on what happens to be running. That is the point — a suite whose outcome
changes because a container is up is not telling you about your code.

Useful variants:

```bash
.venv/Scripts/python -m pytest tests/ -q -k security      # one area
.venv/Scripts/python -m pytest tests/ -x -q               # stop at first failure
.venv/Scripts/python -m pytest tests/ -q --lf             # only what failed last time
.venv/Scripts/python -m ruff check app/ tests/ scripts/   # lint
```

**Expected:** `315 passed`.

---

## Level 2 — the verification scripts

The suite deliberately does not touch the real services, so these do. Each one
runs the real thing and checks a claim that cannot be checked in-process.

```bash
cd backend
.venv/Scripts/python scripts/verify_sandbox.py       # 20 confinement checks
.venv/Scripts/python scripts/verify_neo4j.py         # 30 graph checks
.venv/Scripts/python scripts/verify_sovereignty.py   # zero external calls
.venv/Scripts/python scripts/verify_vision.py        # a model reads a P&ID
.venv/Scripts/python scripts/verify_hero.py          # the full demo path
```

Each prints `[PASS]`/`[FAIL]` per check and exits non-zero if anything failed,
so they work in CI as well as by eye.

**`verify_storage.py` is the odd one out.** The compose MinIO sits on an
internal network and is deliberately unreachable from the host — that is the
guarantee — so point the script at a throwaway one:

```bash
docker run -d --name minio-verify -p 127.0.0.1:9010:9000 \
  -e MINIO_ROOT_USER=verify -e MINIO_ROOT_PASSWORD=verify-secret \
  minio/minio:RELEASE.2025-04-22T22-12-26Z server /data

MINIO_ENDPOINT=127.0.0.1:9010 MINIO_ACCESS_KEY=verify \
  MINIO_SECRET_KEY=verify-secret .venv/Scripts/python scripts/verify_storage.py

docker rm -f minio-verify
```

### What each one is really proving

- **sandbox** — runs code that *tries* to open a socket, read `/etc/shadow`,
  write to `/`, allocate 400 MB and loop forever, and checks it cannot. The
  network check is the one the sovereignty claim rests on.
- **neo4j** — that both retrieval arms actually use the graph rather than
  silently falling back, that reingest replaces instead of duplicating, and
  that the clearance filter runs *inside* the Cypher.
- **sovereignty** — runs real work with the monitor on, then **deliberately
  makes one outbound connection to prove the monitor catches it**. Zero
  external calls from a monitor nobody has shown to be awake is not evidence.
- **vision** — generates a P&ID with known contents and checks a real model
  reads the tags off it.
- **hero** — the demo path: inspection report + SOP in, validated approval
  note out.

### If one fails

Read the `[FAIL]` line first — they carry the reason. Common causes that are
*not* bugs:

| symptom | cause |
|---|---|
| `no reasoning model was available` | VRAM. `ollama ps`, then `ollama stop <model>` |
| `graph index unreachable` | Neo4j container down, or `NEO4J_PASSWORD` unset |
| `sandbox is unavailable` | Docker not running, or the image not pulled |
| `vision pass skipped` | `ollama pull gemma3:4b` |

---

## Level 3 — by hand, over HTTP

This is the one that proves the *wiring*, because it goes through the same
surface the frontend will.

```bash
cd backend
.venv/Scripts/python -m uvicorn app.main:app --reload
```

With `ENABLE_API_DOCS=true` in `.env` (it is, for local development), the
interactive docs are at <http://127.0.0.1:8000/docs> — the easiest way to
click through every endpoint. Use **Authorize** with a token from the login
call below.

### The whole flow in one pass

```bash
# 1. log in (the demo account exists only because SEED_DEMO_USER=true)
TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@mrpl.local","password":"workbench"}' \
  | python -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# 2. upload a document -- ingestion runs in the background, so the response
#    says ingestion_status: pending and that is correct
curl -s -X POST http://127.0.0.1:8000/api/v1/files/upload \
  -H "Authorization: Bearer $TOKEN" -F "file=@C:/path/to/sop.txt;type=text/plain"

# 3. confirm it was ingested: chunks > 0 and indexed_in_graph true
curl -s http://127.0.0.1:8000/api/v1/documents -H "Authorization: Bearer $TOKEN"

# 4. search it -- check diagnostics.vector_backend is "neo4j", not a fallback
curl -s -X POST http://127.0.0.1:8000/api/v1/knowledge/search \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"how do I isolate V-103?","limit":3}'

# 5. run the agent
CONV=$(curl -s -X POST http://127.0.0.1:8000/api/v1/conversations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"manual check"}' | python -c "import json,sys; print(json.load(sys.stdin)['id'])")

curl -s -X POST http://127.0.0.1:8000/api/v1/tasks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"conversation_id\":\"$CONV\",\"request_text\":\"Write an approval note about isolating valve V-103.\",\"task_type\":\"inspection_review\"}"

# 6. watch it happen live (this is what the frontend timeline consumes)
curl -N http://127.0.0.1:8000/api/v1/tasks/<TASK_ID>/events \
  -H "Authorization: Bearer $TOKEN"

# 7. what it did, what it produced, and the proof it stayed local
curl -s http://127.0.0.1:8000/api/v1/tasks/<TASK_ID>/execution -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:8000/api/v1/tasks/<TASK_ID>/artifacts  -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:8000/api/v1/tasks/<TASK_ID>/receipt    -H "Authorization: Bearer $TOKEN"
```

**On Windows, give `curl` a real Windows path** (`C:/Users/.../sop.txt`). Git
Bash's `/tmp/...` will not resolve, because `curl.exe` is a Windows binary and
does not know about the shell's mapped paths. The upload fails with an
unhelpful empty response if you get this wrong.

### What good looks like

- upload → `201`, then `/documents` shows `chunk_count > 0` and
  `indexed_in_graph: true`
- search → `diagnostics.vector_backend: "neo4j"` and `keyword_backend: "neo4j"`;
  `"local_scan"` means the graph is down and you are on the fallback
- task → status walks `pending → planning → running → completed`
- receipt → `external_calls: 0`, `sovereignty: "INTACT"`, with `models_used`
  and `documents_consulted` populated

### Checking the refusals, not just the happy path

A system that only works is half-tested. These should all fail, and the
failure is the point:

```bash
# no token -> 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/v1/documents

# an ordinary engineer reading the audit log -> 403
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/v1/security/audit \
  -H "Authorization: Bearer $ENGINEER_TOKEN"

# someone else's task -> 404, not 403 (confirming it exists would be a leak)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/v1/tasks/<OTHER_ID> \
  -H "Authorization: Bearer $TOKEN"

# the API schema is not published unless ENABLE_API_DOCS=true
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/openapi.json
```

---

## Level 4 — the one-glance check

If you only run one thing:

```bash
curl -s http://127.0.0.1:8000/api/v1/system/status -H "Authorization: Bearer $TOKEN"
```

```json
{
  "parts": {
    "01_foundation": "live", "02_model_layer": "live", "03_documents": "live",
    "04_orchestration": "live", "05_security_audit": "live"
  },
  "model_runtime": { "reachable": true, "detail": "5/6 models ready on ..." },
  "object_storage": "filesystem",
  "external_network_allowed": false
}
```

**Any part reading `"stub"` means it failed to install at startup** — that is
the single most useful signal in the whole system, because it says the wiring
broke rather than the logic. `5/6 models ready` is expected: the sixth is the
vLLM cross-encoder reranker, which has no Ollama equivalent.

The other operator views (`ADMIN` or `SECURITY_ADMIN` only):

```
GET /internal/models/health      GPU, runtimes, per-model readiness
GET /internal/knowledge/status   graph reachability, OCR, corpus size
GET /internal/sandbox/status     code execution and its confinement
GET /api/v1/security/status      policy in force and egress observed
GET /api/v1/security/sovereignty the network monitor widget
GET /api/v1/security/audit       the audit log
```

---

## Before a demo

```bash
docker compose up -d neo4j postgres minio
ollama ps                                   # free VRAM if a big model is warm
.venv/Scripts/python -m pytest tests/ -q
.venv/Scripts/python scripts/verify_hero.py
.venv/Scripts/python scripts/verify_sovereignty.py
```

Two things that will bite otherwise:

- **VRAM.** On an 8 GB card the reasoner (6.5 GB) and the vision model (3 GB)
  cannot both be resident. The router counts memory Ollama can reclaim, so it
  usually copes, but a browser or a game holding VRAM will make it decline the
  reasoner. `ollama ps` shows what is warm; `ollama stop <model>` frees it.
- **The first model call after a restart is slow** — Ollama is loading weights
  from disk. Run the hero script once before anyone is watching.
