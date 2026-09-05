# Agent Orchestration, Tools & Sandbox (Part 04)

This is the part that makes the system agentic rather than conversational: it
turns a request into a sequence of controlled steps, each with deterministic
control before and after any model call.

## The workflow

```
START ─route_entry─▶ analyse_request ─▶ check_permissions ─▶ analyse_inputs
      └─(resumed)──────────────────────────────────┐        │
                                                   │        ▼
                                                   │    build_plan ─▶ retrieve ─▶ reason
                                                   │                                │
                                                   │                                ▼
                                                   │                        approval_gate
                                                   │                          │        │
                                                   │                     (wait)│        │
                                                   └──────▶ generate_artifact ◀┘        │
                                                              │                         │
                                                              ▼                         │
                                                       validate_artifact ──(failed)─────┘
                                                              │
                                                              ▼
                                                          finalise ─▶ END
```

**A workflow engine with explicit states, not a free-form loop.** The agent
cannot decide to do something the graph has no edge for. That is less
impressive on paper and much better on stage: every run takes one of a small
number of known shapes, and a failure lands on a named node.

Two conditional edges carry the interesting behaviour:

- **`approval_gate`** ends the run when a person has to look, leaving the task
  in `waiting_approval`. Resuming re-enters at `generate_artifact`, *not* at
  the top — re-running the reasoning would spend a minute reproducing a draft
  the operator already read, and might produce a different one, which would
  make the approval meaningless.
- **`validate_artifact`** sends a rejected artifact back to be regenerated
  once. This is the self-checking loop; the attempt limit is what stops it
  being an infinite one.

## The tool gateway

    agent → gateway → policy check (Part 05) → tool → audit

**Nothing calls `tool.execute` directly.** No endpoint invokes a tool, and no
module outside `app/tools/` imports one. That is enforced by a test, because
a second call path would skip the policy check, the audit record and the trace
event all at once.

The gateway fails closed: an unknown tool, a denied policy check, arguments
that do not match the declared schema, or a tool that raises are each refused
with a reason — never waved through, and never reported to the agent as though
the tool ran and found nothing.

| tool | risk | notes |
|---|---|---|
| `knowledge.search` | low | Part 03's retrieval, filtered to the caller's clearance |
| `file.read` / `file.write` / `file.list` | low | workspace only; inputs by id, never by path |
| `ocr.extract` | low | a document's extracted text, page by page |
| `python.execute` | **high** | the Docker sandbox |
| `docx` / `xlsx` / `pptx.generate` | low | deterministic builders |

A task may only read the input files it was **created with**. Ownership is
checked when the task is made; the tool context enforces it thereafter, so a
prompt injection cannot widen a task's reach to the rest of the corpus.

## The sandbox

The agent writes code and this runs it — the most dangerous capability here.
The container is built to be useless to anything that escapes:

| control | how |
|---|---|
| no network | `network_mode="none"` — no interface exists, not a firewall rule |
| read-only root | `read_only=True`, one tmpfs workspace |
| memory / CPU | `mem_limit`, `cpu_quota` |
| privileges | non-root (65534), all capabilities dropped, no-new-privileges |
| timeout | the container is killed, not asked to stop |
| persistence | none; the tmpfs is gone with the container |

**Every one of these is verified against real Docker** by
`scripts/verify_sandbox.py`, which runs code that tries to break each. The
network check is the one that matters most: if code in the sandbox could open
a socket, the sovereignty claim would be false — a model could write code that
exfiltrates the documents it was reasoning over.

Getting files in and out took more work than expected. Docker refuses
`put_archive` into a container with a read-only rootfs — before or after
start, and regardless of the target being a writable mount — and `get_archive`
afterwards sees nothing, because a tmpfs is gone once the container stops.
Rather than give up the read-only rootfs, both directions go through the
process: the payload is a base64 tar passed as a command argument, and
produced files come back base64-encoded on stdout behind a per-run marker.

## Artifacts are generated, never written by a model

A model is never asked for a `.docx`. It is asked for JSON matching
`ApprovalNoteContent`, which Pydantic validates, and a deterministic generator
builds the document. A model asked for a binary can only be checked by opening
it; a model asked for this can be checked field by field before a byte is
written.

The validator then reopens the file from disk and checks it against the
evidence that was actually retrieved. The rule it is built around:

> **An artifact may not assert something the evidence does not support.**

A citation to a document that was never retrieved is the single most damaging
output this system could produce, so it is a hard failure — the artifact is
rejected and regenerated, and if the second attempt also invents a source the
task fails rather than shipping the note.

One detail worth knowing: the XLSX generator neutralises anything starting
with `=`. A spreadsheet that computes a different number when opened is worse
than one that is plainly wrong, and the arithmetic belongs in
`python.execute`, where the result is captured.

## Streaming

An `AgentEvent` is emitted at every meaningful transition — `task_started`,
`request_analysed`, `plan_built`, `retrieval_completed`, `model_selected`,
`tool_called`, `artifact_generated`, `validation_completed`, `task_completed`.
Part 01's SSE endpoint forwards them live. This is the feature that makes the
system look like an agent rather than a slow endpoint, so the graph runs in a
worker thread: blocking the event loop would stall the very stream that is
meant to be showing the run happen.

## State and resumption

LangGraph checkpoints in memory, which is enough to pause at an approval gate
and resume when the operator answers — both happen in one process. It is not
enough if that process restarts while a task is waiting, and a task stuck in
`waiting_approval` with no way to continue is worse than one that failed
loudly. So the state is written to `task_runs` after every node, and a resume
that finds no live checkpoint rebuilds from that row.

## Verifying it

```bash
docker pull python:3.12-slim
python scripts/verify_sandbox.py    # 20 confinement checks against real Docker
python scripts/verify_hero.py       # the demo path, against real models
```

`verify_hero.py` runs the flagship workflow: an inspection report and an SOP
in, an approval note out, with every deviation cited back to a clause.

## Layout

```
app/orchestration/        app/tools/              app/sandbox/
├── state.py              ├── base.py             ├── base.py
├── planner.py            ├── gateway.py          └── docker_runner.py
├── graph.py              ├── workspace.py
└── executor.py           ├── knowledge.py        app/artifacts/
                          ├── filesystem.py       ├── content.py
                          ├── python.py           ├── store.py
                          └── generators/         └── validator.py
```
