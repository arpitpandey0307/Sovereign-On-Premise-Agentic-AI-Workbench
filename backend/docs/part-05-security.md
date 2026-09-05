# Security, Policy, Audit & Sovereignty (Part 05)

This part turns "the system is private" from a claim into a demonstrated,
logged fact — and owns who is allowed to see and do what.

## The policy engine

Parts 02 and 04 both ask; neither decides. Part 02 knows which model is
*best*, this knows whether it is *permitted*, and quality never overrides
classification. Every method returns `(allowed, reason)` — there is no code
path that produces a denial without one, because a denial with no reason is
useless both to the operator reading the audit log and to the engineer
debugging why a demo stopped.

Everything fails closed:

| situation | outcome |
|---|---|
| an unmapped permission | denied — "no policy defines `x:y`" |
| an unrecognised role | no clearance at all, not the lowest one |
| a tool with an unknown risk level | denied |
| an unrecognised classification | coerced to INTERNAL, never to PUBLIC |

## Roles govern actions; clearance governs data

These are separate axes, and conflating them is a mistake that looks correct
until it bites. Applying the classification ceiling to *every* permission
locked `SECURITY_ADMIN` — deliberately given no clearance over the corpus — out
of the audit log as well. So `check_permission` takes a classification only
when classified material is actually at stake; endpoint permissions are
governed by the role matrix alone.

| role | clearance | notes |
|---|---|---|
| ENGINEER, ANALYST | CONFIDENTIAL | stop below the top rung |
| MANAGER, ADMIN | HIGHLY_CONFIDENTIAL | |
| SECURITY_ADMIN | PUBLIC | oversees the system without reading the corpus |

That last row is deliberate. Separating oversight from access is the point of
having the role: a security administrator reads the audit trail and the
dashboard, not the documents.

## Classification

```
PUBLIC → INTERNAL → CONFIDENTIAL → HIGHLY_CONFIDENTIAL
```

An unmarked document is **INTERNAL, never PUBLIC** — it is one nobody has
reviewed yet, and treating it as publishable is the failure that matters.
PUBLIC has to be claimed explicitly. A marking anywhere in the filename or the
opening pages raises the level, and whitespace is collapsed first so a marking
broken across a line — which is what OCR of a stamped header produces — is
still found.

`HIGHLY_CONFIDENTIAL` is the one rung with teeth beyond read access: high-risk
tools are barred there (so no code execution against board material, sandbox
or not), and a deliverable waits for a person before it is produced.

## The audit ledger

Append-only **by construction**: the class exposes `record`, `trace`,
`recent`, `event_types` and `receipt`, and no update or delete exists anywhere
in the code that touches the table. A test pins that surface, so adding a
mutation method fails the suite.

The honest framing: this is tamper-*resistant*, not tamper-*evident*. Signed
records are a later hardening step, and claiming them now would be the wrong
thing to tell a reviewer.

Two design details worth keeping:

- **Rows record references, not content.** That a document was read, not what
  it said. The ledger must not become a second copy of the corpus, so metadata
  values are capped.
- **`task_id` and `user_id` are not foreign keys.** A task or user being
  deleted must not take the record of what they did with them. An audit row
  that can be removed by deleting something else is not an audit row.

A write that fails is logged at error level and never raised into the caller:
losing an audit row is bad, losing the user's work because the audit row could
not be written is worse.

## The task receipt

```
Task / User / Request / Models used / Tools used / Tools denied /
Documents consulted / Artifacts / Approvals / External calls / Sovereignty
```

No new subsystem — it is a query over the ledger. Every line is derived from
records written *as the work happened*, rather than summarised afterwards by
the thing being audited, which is what makes it worth showing.

Readable by the task's own owner as well as by oversight roles: it is the
evidence that *their* work stayed on the machine, and withholding it from them
would defeat its purpose.

## Sovereignty: proof, not a label

The problem statement asks for proof "through logs or a visible network
monitor, that no external calls are made at any point". Three layers, each
covering what the others cannot:

| layer | covers |
|---|---|
| in-process audit hook | what this application tried to do |
| Docker network / loopback binding | what any container is able to do |
| sandbox with no NIC | what model-written code is able to do |

The first is the interesting one. `sys.addaudithook` receives every
`socket.connect` and `socket.getaddrinfo` **from inside the interpreter** —
below `httpx`, below `requests`, below anything a dependency might reach for.
A library cannot avoid it by using a different HTTP client, because the event
fires at the socket layer. A hook cannot be uninstalled once added, which is
the right property: a monitor that could be switched off mid-task would prove
nothing about the rest of the task.

What is *not* claimed: it observes this process. Another process on the host
is outside its view — that is what the network-level controls are for.

### Verifying it

```bash
python scripts/verify_sovereignty.py
```

Runs the real workflow with the monitor active, reports what it observed, and
then **deliberately makes one outbound connection to prove the monitor catches
it**. That second half is the part that matters: a monitor reporting zero is
only evidence if it can be shown to be watching, otherwise it is
indistinguishable from one that is switched off.

Two traps that check fell into, both worth knowing:

- The first version used `198.51.100.7` (RFC 5737 TEST-NET-2) as the "external"
  address. Python's `ipaddress` reports documentation ranges as
  `is_private=True`, so a *correct* monitor classified it as local and the
  check failed. It now uses `192.88.99.1` — the deprecated 6to4 relay range,
  which Python calls global while being effectively unrouted.
- The same shape of mistake as the sandbox check: "the bad thing did not
  happen" needs a matching proof that the attempt was really made.

## The placeholder now denies everything

While Part 05 was unbuilt, `PermissivePolicy` in `app/integrations/stubs.py`
carried a working copy of the rules. Now that the real engine exists a second
copy would be a second source of truth for security decisions — and the copy
that drifts is always the one nobody is looking at.

So it is `UninstalledPolicy`, and it denies everything. If those reasons appear
in a log, the policy engine did not start, and denying every request is the
correct way for that to be noticed rather than a quiet downgrade to
placeholder security. The one method that cannot refuse is classification —
ingestion has to label a document as something — and it answers
`HIGHLY_CONFIDENTIAL`.

## Layout

```
app/security/                    app/audit/
├── classification.py            ├── events.py
├── acl.py                       └── ledger.py
├── policy_engine.py
├── network.py                   app/api/security.py
└── port.py
```
