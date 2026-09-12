# Sovereign On-Premise Agentic AI Workbench — Project Brief

**Problem statement:** PS26117 — Smart Automation theme, Smart India Hackathon 2026
**Customer:** MRPL (Mangalore Refinery and Petrochemicals Limited)

This document explains what we built, how it works, and why we made each
choice. Read it once and you should be able to answer almost any question a
judge asks.

---

## 1. What the project is, in one paragraph

A refinery has thousands of confidential documents — operating procedures,
P&ID drawings, inspection reports, HAZOP studies, incident records. Engineers
need answers from them every day. Today they either search by hand, or paste
the contents into ChatGPT and hope nobody notices.

We built an AI workbench that runs **entirely on the plant's own hardware**.
No document ever leaves the site. It reads your documents, answers questions
with citations you can click, runs calculations in a locked container, and
writes deliverables like approval notes — and it records every step so an
auditor can check what happened.

---

## 2. The core idea

Anyone can wrap an API around ChatGPT. The hard problem here is different:

> How do you get useful AI in a place where sending data outside is
> **not allowed**?

Everything in our design follows from that one constraint:

| Constraint | What it forces |
|---|---|
| No internet | Open-weight models running locally, no cloud API |
| Confidential documents | Clearance levels, and answers filtered by who is asking |
| Regulated industry | Every action written to an audit ledger |
| An answer can be wrong | Every claim carries a citation you can open |
| Modest hardware | A model router that picks the smallest model that will do the job |

---

## 3. Main features

### 3.1 AI Workbench (the chat)
- Ask a question in plain English.
- **Normal chat works.** "Hello" gets a normal reply — it does not scan the
  corpus. Only questions about the plant trigger a document search.
- **Citations.** A grounded answer lists its sources with page numbers, and
  "View source" opens that document at that page.
- **Attachments.** A `+` menu for documents, images and drawings,
  spreadsheets, or any file. Scanned drawings go through OCR and a vision
  model.
- **Voice input.** A microphone button dictates into the box. You read it
  before sending — speech never starts a task on its own.
- **Effort control.** Low / Balanced / High. This is a real instruction: it
  changes which model the router picks.
- **Chat history**, kept separately for the AI Workbench and the Coding
  Workspace so the two do not mix.

### 3.2 Live reasoning timeline
While a task runs you see the nine stages as they happen: Identity Check →
Authorization → Risk Classification → Retrieval → Model Selection → Execution
→ Validation → Checkpoint → Audit Log. Each step can be expanded to see *why*
it happened.

### 3.3 Knowledge Base
- Search the corpus, with diagnostics showing how the search was done
  (which vector backend, which reranker, how many chunks considered).
- **Equipment graph.** Type a tag like `P-101` and see everything connected to
  it across all documents. This is the feature a generic chatbot cannot do.

### 3.4 Documents
Upload, view, and re-ingest. The viewer keeps three things visually separate:
the real page text, anything OCR recovered, and any description a vision model
produced. A generated description is never mixed into the page's own words.

### 3.5 Coding Workspace
Describe a calculation. The system writes a Python program, runs it in a
Docker container with **no network** and a **read-only filesystem**, and
reports what it printed. If the program crashes, the error is fed back and it
tries again.

### 3.6 Approvals
Work drawn from HIGHLY_CONFIDENTIAL material stops and waits for a human to
approve or reject before a deliverable is produced.

### 3.7 Security Center (oversight roles only)
- **Sovereignty monitor** — counts every outbound connection attempt. It can
  say BREACHED, and it distinguishes "clean" from "not watching".
- **Audit ledger** — every action, with denials highlighted in red.
- **Policy in force** — the classification rules, shown read-only.

### 3.8 Model Center
Every model, its status, and why. A routing playground shows what the router
would choose for a request and explains the decision — without spending any
GPU time.

---

## 4. Overall architecture

```
                    ┌───────────────────────────┐
  Browser  ───────► │  React app (static build) │
                    └────────────┬──────────────┘
                                 │  same-origin HTTP + SSE
                    ┌────────────▼──────────────┐
                    │   FastAPI (one process)   │
                    │                           │
                    │  Part 01  API, auth, tasks│
                    │  Part 02  Model registry  │
                    │  Part 03  Documents, RAG  │
                    │  Part 04  Orchestration   │
                    │  Part 05  Security, audit │
                    └──┬────────┬────────┬──────┘
                       │        │        │
              ┌────────▼─┐  ┌───▼────┐  ┌▼─────────┐
              │  Ollama  │  │ Neo4j  │  │  Docker  │
              │ (models) │  │ (graph)│  │ (sandbox)│
              └──────────┘  └────────┘  └──────────┘
                     all on the same machine
```

**Everything in that diagram runs on one box inside the plant.** There is no
outbound arrow anywhere.

### Why a modular monolith and not microservices?

The five parts are separate folders that talk to each other only through
defined interfaces (`app/integrations/ports.py`). But they all run in **one
process**.

Reason: this ships to an air-gapped refinery. Every extra service is another
thing a plant IT team has to install, patch and restart with no internet. One
process is one thing to deploy. The code is already split cleanly, so it can
be pulled apart later if it ever needs to scale.

---

## 5. Backend — how it works

### 5.1 Tech stack and why

| Technology | Used for | Why this one |
|---|---|---|
| **Python + FastAPI** | The whole API | Async, automatic validation with Pydantic, and Python is where the AI ecosystem lives |
| **SQLAlchemy + SQLite** | Database | SQLite means the app runs with **zero external services**. Same models point at PostgreSQL in Docker Compose |
| **Alembic** | Schema migrations | Schema changes are versioned and reversible, not hand-edited |
| **LangGraph** | Agent orchestration | The agent is a **state graph**, not a prompt loop. Every step is a named node we can log, test and show in the UI |
| **Ollama** | Running models locally | Simple local runtime, easy to install offline, handles GPU/CPU automatically |
| **Neo4j** | Knowledge graph + vector index | Stores chunks *and* equipment relationships in one place, so "what connects to P-101" is a graph query, not guesswork |
| **Docker** | Code sandbox | Real isolation: no network, read-only root, all capabilities dropped, non-root user |
| **Tesseract** | OCR | Offline OCR for scanned drawings. No cloud OCR anywhere |
| **MinIO** (optional) | Object storage | S3-compatible, self-hosted. Filesystem is the default so nothing extra is needed |
| **JWT** | Authentication | Stateless, no session store, works offline |
| **SSE** | Live progress | Server-Sent Events. Simpler than WebSockets, and we only need one direction |
| **pytest + ruff** | Tests and linting | 333 backend tests |

### 5.2 The five parts

**Part 01 — Foundation**
API gateway, JWT login, users and roles, conversations, tasks, file uploads.
Every error returns the same envelope: `{"error": {"code", "message", "details"}}`.

**Part 02 — Model layer**
A **registry** of available models and a **router** that picks one per request.

The router scores every candidate on eight factors:

| Factor | Weight | Meaning |
|---|---|---|
| task_accuracy | 0.25 | Is this model built for this job? |
| capability_match | 0.20 | Does it have the needed capabilities (vision, JSON output)? |
| context_fit | 0.13 | Will the prompt fit in its context window? |
| **effort_fit** | 0.12 | Did the operator ask for a small/fast or large/careful model? |
| historical_success | 0.09 | Has it worked before on this task type? |
| latency | 0.08 | How fast is it? |
| resource_efficiency | 0.08 | How much VRAM does it want? |
| reliability | 0.05 | How often does it fail? |

It also **explains itself** — the routing playground shows the score
breakdown and why each rejected model was ruled out.

**Part 03 — Documents and knowledge**
Upload → extract text → OCR if needed → vision model if a page has no text
layer → classify → chunk → embed → store in Neo4j → extract equipment tags.

Retrieval is **hybrid**: vector similarity plus keyword matching, then
reranking. Results are filtered by the caller's clearance *before* they are
returned.

**Part 04 — Orchestration**
The LangGraph state machine:

```
analyse_request
      │
check_permissions
      │
      ├── conversational? ──► converse ──────────┐
      │                                          │
analyse_inputs → build_plan → retrieve           │
                                   │             │
                          calculation? ──► calculate
                                   │             │
                                reason ──────────┤
                                   │             │
                          needs artifact?        │
                                   │             │
                          approval_gate          │
                                   │             │
                    generate_artifact → validate_artifact
                                   │             │
                                finalise ◄───────┘
```

- **converse** — small talk and general questions, answered directly with no
  document search.
- **calculate** — writes a Python program with the coding model, runs it in
  the sandbox, retries once with the error if it crashes.
- **validate_artifact** — checks the produced file against the evidence. If
  the model invented a citation, the artifact is **refused**.

**Part 05 — Security**
- **RBAC** — five roles, each with a permission set.
- **Classification** — every document gets PUBLIC / INTERNAL / CONFIDENTIAL /
  HIGHLY_CONFIDENTIAL, read from markings **in the document text**.
- **Clearance** — each role can read up to a level. Retrieval filters by it.
- **Audit ledger** — an append-only record of every action, including denials.
- **Sovereignty monitor** — an in-process hook on every socket connect and DNS
  lookup. It counts external attempts. Currently: zero.

### 5.3 How sovereignty is actually enforced

Not by a promise in a slide. Four real mechanisms:

1. An audit hook on every socket connect and DNS lookup in the process.
2. The code sandbox has **no network interface at all**.
3. Model runtimes are **refused at construction** unless the endpoint is local.
4. Docker Compose publishes every service on loopback only.

---

## 6. Frontend — how it works

### 6.1 Tech stack and why

| Technology | Used for | Why this one |
|---|---|---|
| **Vite + React 19 + TypeScript** | The app | See the Vite note below. TypeScript catches API shape mistakes at compile time |
| **Tailwind CSS v4** | Styling | Design tokens live in CSS variables, so the whole theme is one file |
| **TanStack Query** | Server state | Caching, refetching, loading and error states handled once instead of in forty components |
| **React Router** | Routing | Standard, and supports the role-based route guard we need |
| **Framer Motion** | Animation | Page transitions and card animations. Respects `prefers-reduced-motion` |
| **Recharts** | Dashboard charts | Model usage and task activity |
| **three.js / React Three Fiber** | Landing page 3D | The sovereignty boundary, rendered. Lazy-loaded so no other page carries it |
| **Vitest + Testing Library** | Tests | 171 tests |

### 6.2 Why Vite and not Next.js

This is a deliberate choice and worth explaining:

- The product ships **air-gapped**. A static build is served directly by
  FastAPI, so there is **no Node runtime** to install and patch in the plant.
- SSR and SEO buy nothing behind a login on an internal network.
- One less moving part in a facility with no internet.

### 6.3 Screens

| Screen | What it does |
|---|---|
| Landing | Marketing page with a 3D sovereignty boundary |
| Choose role | "Who are you signing in as?" — before login |
| Dashboard | Recent tasks, activity charts, system status |
| AI Workbench | The chat, with attachments, effort, voice, history |
| Coding Workspace | Sandbox confinement facts, and coding sessions |
| My Documents | Your uploads |
| Knowledge Base | Search the corpus, plus the equipment graph |
| Artifacts | Generated files with the validator's verdict |
| Approvals | Requests waiting for a decision |
| Security Center | Sovereignty, audit, policy |
| Model Center | Model status, routing playground |
| Settings / Profile | Preferences, personal instructions |

### 6.4 The sign-in flow

```
Landing → "Enter Workbench"
       → "Who are you signing in as?"  (Engineer / Analyst / Manager /
                                         Security Administrator / Administrator)
       → Sign in
       → Your credentials decide whether that claim holds
       → Land in your workspace
```

The role cards are **not disabled** before sign-in. The screen genuinely does
not know who is looking at it, and disabling them would leak the shape of the
organisation. The claim is settled by the credentials.

### 6.5 Role boundaries

Backend roles map to four ranks:

| Rank | Backend role | Can see |
|---|---|---|
| employee | ENGINEER, ANALYST | Dashboard, AI Workbench, My Documents, Knowledge Base, Artifacts, Settings |
| manager | MANAGER | + Approval Requests, Tasks |
| security | SECURITY_ADMIN | Security Center, Models, Audit, Approvals — **no chat, no corpus** |
| admin | ADMIN | Everything |

Two important points:

- **Nothing above your rank is even visible.** Typing `/security` as an
  engineer is refused with an explanation, not a blank page.
- **A security administrator outranks a manager but cannot read the corpus.**
  Oversight and production work are different jobs, not different amounts of
  the same one. This is deliberate.

The rule is enforced in **three places from one table**: the chooser, the
sidebar, and the router. And the server re-checks every request anyway — the
frontend rules are about not *offering* what the server would refuse.

---

## 7. The data

### 7.1 Corpus loaded for the demo

**18 documents · 1,637 chunks · 353 entities · all four classification levels**

Real public documents:

| File | Size | Classification |
|---|---|---|
| MRPL Annual Report 2024-25 | 382 pages | INTERNAL |
| CSB Incident Reports Vol 1 | 52 pages | CONFIDENTIAL |
| Suncor CEI Inspection Report | 11 pages | INTERNAL |
| CAD asset hierarchy (897 objects) | 32 pages | INTERNAL |
| 2 × P&ID drawings (JPEG) | 1 page each | CONFIDENTIAL / INTERNAL |

Generated operating documents (one imaginary unit, CDU-3):

| File | Classification |
|---|---|
| SOP-204 Pump Isolation | CONFIDENTIAL |
| SOP-311 Relief Valve Testing | CONFIDENTIAL |
| INS-2026-018 Inspection Report | CONFIDENTIAL |
| HAZ-CDU3-07 HAZOP Worksheet | CONFIDENTIAL |
| DS-CDU3 Datasheet Register | HIGHLY_CONFIDENTIAL |
| BRD-2026-04 Turnaround Note | HIGHLY_CONFIDENTIAL |
| PUB-2026-01 Safety Bulletin | PUBLIC |
| MAINT-CDU3 readings (CSV, 180 days) | INTERNAL |

**Every generated file says in its own text that it is demonstration
material.** A synthetic document that reads as a real record is exactly what
this product must never produce.

### 7.2 Why we generated some documents

The public datasets are real and on-topic, but none of them describe **one
plant**. Nothing refers to the same equipment as anything else, and nothing
carries a sensitivity marking. Without that there is no equipment graph, no
clearance boundary to show, and nothing that reaches the approval gate.

The generated documents share ISA-5.1 equipment tags — `P-101`, `V-103`,
`PSV-107`, `E-201`, `TK-401`, `K-102`, `PT-2201`, `FIC-305`, `R-501` — so the
same pump appears in the SOP, the inspection report, the HAZOP and the
datasheet. That is what gives the graph something to traverse.

### 7.3 Classification is read, not chosen

There is no dropdown. The ingester reads the document's own markings:

| Text in the document | Becomes |
|---|---|
| HIGHLY CONFIDENTIAL, TRADE SECRET, BOARD CONFIDENTIAL | HIGHLY_CONFIDENTIAL |
| CONFIDENTIAL, PROPRIETARY, INTERNAL USE ONLY, P&ID, HAZOP | CONFIDENTIAL |
| FOR PUBLIC RELEASE, UNCLASSIFIED | PUBLIC |
| *(no marking)* | INTERNAL |

And it records **why** it decided, against each document.

---

## 8. Models on the demo machine

| Model | Role | Ollama tag |
|---|---|---|
| Qwen3 8B (Q4) | Reasoning — the main model | `qwen3:8b` |
| Qwen3 1.7B (Q4) | Reasoning — fast/low effort | `qwen3:1.7b` |
| Qwen2.5-Coder 7B (Q4) | Writes code for the sandbox | `qwen2.5-coder:7b` |
| Gemma3 4B (Q4) | Vision — reads drawings | `gemma3:4b` |
| BGE-M3 | Embeddings for search | `bge-m3` |
| BGE Reranker v2 | Reranking | *not served — see gaps* |

All open-weight. All running locally. Nothing calls out.

---

## 9. Test coverage

| Suite | Count | What it covers |
|---|---|---|
| Backend (pytest) | 333 | API, auth, RBAC, ingestion, retrieval, routing, orchestration, security |
| Frontend (Vitest) | 171 | Components, role boundaries, pipeline reducer, formatters |
| Live integration | 15 | Every screen rendered against a **running** backend |

The live suite is worth mentioning. Normal frontend tests mock the network,
which only proves the screen matches what we *believe* the API returns. The
live suite removes the mock and signs in for real — that is how we found four
screens reading fields the API never sent.

---

## 10. Honest gaps

Being straight about this is better than being caught out.

**Not built (each is visibly marked in the UI as awaiting its service):**
- Sign-up — accounts are provisioned by an administrator
- Policy editor — shows the live policy read-only; there is no policy store yet
- Runtime model add/remove — the form generates a catalogue entry instead
- Per-user assistant memory
- Product download

**Working but limited:**
- **Reranker** is not served (needs vLLM). Retrieval falls back to lexical
  reranking — it works, it just ranks slightly worse.
- **Profile settings** (photo, custom instructions) are stored in the browser,
  not on the server. The panel says so. The instructions genuinely do get sent
  with every request.
- **`nvidia-smi` permissions** on the demo laptop mean the GPU panel may show
  hardware as unavailable. The system still routes correctly — an unreadable
  sensor is treated as "unknown", not as "no GPU".

---

## 11. Running it

```bash
# Backend
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Frontend (production build)
cd frontend
npm run build
npx vite preview --port 4173
```

Open **http://localhost:4173**

**Demo accounts** — password `workbench` for all:

| Email | Role |
|---|---|
| engineer@mrpl.local | ENGINEER |
| analyst@mrpl.local | ANALYST |
| manager@mrpl.local | MANAGER |
| security@mrpl.local | SECURITY_ADMIN |
| admin@mrpl.local | ADMIN + ENGINEER |

Needs Docker running for Neo4j (graph) and the code sandbox, and Ollama for
the models.

---

## 12. Suggested demo path

1. **Landing page** — 3D sovereignty boundary, the pitch.
2. **Enter Workbench** → choose **Engineer** → sign in.
3. Type **"hello"** — a normal reply. It is a real assistant, not a search box.
4. Ask **"Which valve isolates P-101 and what must be confirmed before
   breaking a flange?"** → answer plus six citations. Click **View source**.
5. **Knowledge Base** — show the corpus. Point out that the two
   HIGHLY_CONFIDENTIAL documents are **missing** for this engineer.
6. **Equipment graph** — type `P-101`. Thirteen connected items across four
   documents. *"A generic chatbot cannot do this."*
7. Sign out → sign in as **security@mrpl.local** — no chat, no documents, but
   full oversight. The boundary runs both ways.
8. **Security Center** — sovereignty monitor showing zero external calls, and
   the audit ledger with real denials in red.
9. Sign in as **admin** → attach the board note → **the approval gate fires**.
10. **Coding Workspace** — ask for a calculation over the readings CSV, and
    watch it write and run a program.

---

## 13. Likely questions, and how to answer them

### About the concept

**Q: Why not just use ChatGPT with a privacy agreement?**
A refinery's P&IDs and HAZOP studies are trade secrets and safety-critical
records. A contract is a promise; an air gap is a fact. Our system counts
every outbound connection attempt and shows you the number. It is currently
zero, and we can prove it rather than assert it.

**Q: Isn't a local model much worse than GPT-4?**
For open-ended writing, yes. For "what does SOP-204 say about isolating
P-101", the quality comes from **retrieval**, not from the model's world
knowledge. We give the model the right three paragraphs and ask it to answer
from them. An 8B model does that well. And we validate the output — if it
cites something that was not retrieved, we refuse to ship it.

**Q: What is actually novel here?**
Three things: the equipment graph (cross-document reasoning about physical
plant), the artifact validator (the system catches its own hallucinations and
refuses), and the sovereignty evidence (a receipt per task proving nothing
left the building).

**Q: Could this work for another industry?**
Yes — defence, hospitals, banks, legal firms. Anywhere the documents cannot
leave. The refinery specifics are the equipment tag patterns and the document
types, which are configuration, not architecture.

### About the technology

**Q: Why LangGraph and not a simple prompt chain?**
Because we need to *show* the process. Each node is a named step we can log,
test individually, and render on the timeline. A prompt chain is a black box;
a state graph is inspectable. It also gives us the approval gate — the graph
genuinely pauses and waits for a human.

**Q: Why Neo4j? Why not just a vector database?**
A vector database answers "what text is similar to this question". It cannot
answer "what else connects to pump P-101". We need both, so we store chunks
with their embeddings *and* the equipment relationships in the same place.

**Q: How does the model router actually work?**
Four stages: filter by capability, filter by policy (some classifications
only allow local models), filter by hardware fit, then score the survivors on
eight weighted factors. It explains every decision — you can see the score
breakdown and why each model was rejected, without running anything.

**Q: What does the "effort" control really do?**
It changes model selection. Low picks the 1.7B model for a fast answer; High
reaches for the largest model that fits. It is a field on the task, stored in
the database, and a weighted factor in the router. It is not a label.

**Q: How is the code sandbox safe?**
Docker container with: no network interface, read-only root filesystem, tmpfs
workspace discarded after the run, all Linux capabilities dropped,
`no-new-privileges`, running as user `nobody`. The system reports these as
measured facts, not aspirations — and if the sandbox cannot start, it says the
code never ran rather than reporting a failed calculation.

**Q: Why SSE and not WebSockets?**
We only need server → client. SSE is simpler, works over plain HTTP, and
reconnects automatically. WebSockets would be extra complexity for nothing.

**Q: How do you handle a scanned drawing with no text?**
Tesseract OCR first. If a page still has no usable text layer, a local vision
model describes it. Crucially, that description is kept **separate** from the
page text — so a generated description can never be quoted as the document's
own words.

### About security

**Q: What stops an engineer reading a board-confidential document?**
Three layers. The document is classified from its own markings. The engineer's
clearance tops out at CONFIDENTIAL. Retrieval filters by clearance *before*
results are returned, so the text never reaches them — and the document is
reported as *not found*, not "forbidden", because confirming it exists is
itself a disclosure.

**Q: Can someone bypass the UI by calling the API directly?**
Yes, they can call it — and the server refuses them. The frontend rules decide
what is *offered*; the server decides what is *allowed*, and re-checks every
single request. We have tests that sign in as each role and attempt the
escalation.

**Q: What is in the audit ledger?**
Every login, permission check, document access, model selection, tool call,
sandbox execution, artifact generation and download — including every
**denial**. Denials are shown in red, because they are the evidence the
controls are live.

**Q: What is the "receipt"?**
Per task: which models ran, which tools were used, which tools were
**denied**, which documents were consulted, how many external calls were made
(zero), and a sovereignty verdict. Assembled from the audit ledger as the work
happened, not summarised afterwards.

### Awkward questions — answer honestly

**Q: Is this data real MRPL data?**
No, and deliberately not. We used real public documents — MRPL's own annual
report, US Chemical Safety Board incident reports, a public refinery
inspection report — plus operating documents we generated for one imaginary
unit. Every generated file states in its own text that it is demonstration
material. Putting real confidential plant data on a demo laptop would be the
exact behaviour this product exists to prevent.

**Q: What does not work yet?**
Sign-up, a policy editor with storage, runtime model management, and per-user
memory. Each is visibly marked in the interface as awaiting its backend. We
chose to mark them honestly rather than build fake forms — a demo that implies
a capability it lacks costs more than the feature gains.

**Q: The reranker shows unavailable — why?**
It needs vLLM serving a specific model, which we have not set up on this
machine. Retrieval falls back to lexical reranking. It works; it just ranks a
little worse. The system reports it accurately rather than hiding it.

**Q: How do you know the citations are real?**
The validator checks every citation in a generated artifact against the
passages actually retrieved. If the model cites a page that was not retrieved,
the artifact is refused and the task fails. We have watched this happen —
it caught an invented citation, refused twice, and failed the task rather than
shipping it. That is the behaviour we want.

**Q: What are the hardware requirements?**
It runs on a laptop with an 8 GB GPU. 16 GB of system RAM is the floor and it
is tight; 32 GB is comfortable. A plant deployment would use a proper server,
where you could run larger models and serve many users.

**Q: How long did this take / who built what?**
*(Fill in your own team's answer here.)*

---

## 14. One-line summaries to have ready

- **The project:** an AI workbench for confidential industrial documents that
  runs entirely on the plant's own hardware.
- **The problem:** engineers need AI on documents that legally cannot leave
  the site.
- **The proof:** every task comes with a receipt showing zero external calls.
- **The differentiator:** it reasons across documents about physical equipment,
  and it refuses to ship an answer it cannot support with a real citation.
