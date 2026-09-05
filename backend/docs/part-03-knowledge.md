# Document Intelligence & Knowledge (Part 03)

This part turns an uploaded file into something the agent can reason over and
cite: extracted text, OCR'd scans, page-aware chunks, embeddings, and a graph
of the equipment those documents talk about.

## The pipeline

```
uploaded file  (Part 01 hands over the file id)
  → detect type            parser.detect_kind
  → extract text           PyMuPDF / openpyxl / python-docx / plain
  → render + OCR           only pages with no usable text layer
  → flag for vision        drawings, photos, thin-text pages with graphics
  → chunk                  page-aware, section-tagged, overlapping
  → classify               Part 05 decides the level, this part supplies text
  → embed                  Part 02 routes to an embedding model
  → index                  Neo4j chunks + equipment graph
  → record                 documents / pages / chunks / entities in SQL
```

Ingestion runs in the background threadpool, off the upload response: OCR of a
scanned P&ID takes seconds and the upload must not wait for it.

## Why chunks live in two places

The spec puts chunks in Neo4j. They are written to the relational store as
well, and the split is deliberate:

- **the SQL row is the record** of what was ingested,
- **Neo4j is the index** over it — the vector index and the equipment graph.

On an air-gapped machine there is nobody to restart a container mid-demo. If
the graph is unreachable, the document still ingests and search still answers,
using an O(n) cosine scan over the stored vectors instead of an indexed
lookup. Every response says which path it took, so a slow answer is visibly a
slow answer rather than a silent one.

## Hybrid retrieval

Two independent searches run and their **rankings** are fused:

| arm | asks | backed by |
|---|---|---|
| vector | what does this passage *mean* | Neo4j vector index, else local cosine |
| keyword | which identifiers does it literally contain | Neo4j full-text, else term scan |

Fusion is Reciprocal Rank Fusion (`k=60`). Rankings rather than scores,
because Neo4j's cosine similarity and its Lucene score are on unrelated
scales — averaging them would let whichever produced larger numbers dominate.

### Reranking

Three tiers, each falling through to the next, and the diagnostics say which
one actually ran:

| tier | how | when |
|---|---|---|
| `cross_encoder` | vLLM's rerank endpoint | a reranking model is served |
| `model_scored` | one structured-output call scoring the whole shortlist | a reasoning model is ready |
| `lexical` | term coverage plus exact-tag agreement | always |

The model tiers score only the top 8 candidates, in a *single* call rather
than one per passage: N calls would put a reranker's latency on the critical
path of every search on a laptop already holding a model in VRAM.

The lexical signal is blended into every tier, never replaced by it. `V-103`
and `V-104` are near-identical to an embedding model, and a reranking model
that has not been told which identifier matters can still prefer a fluent
passage about the wrong vessel — so exact-identifier agreement keeps its
weight even when a model has an opinion.

Ollama has no rerank endpoint at all (`/api/rerank` returns 404), which is why
the cross-encoder tier is a vLLM-provider entry in the catalogue. It becomes
live by itself the day the lab box serves it.

A fallback always records *why* a better tier did not run, in
`diagnostics.notes`. That is not politeness: a fallback that answers without
explaining itself is precisely how the graph client hid a broken query for as
long as it did.

**On an 8 GB card the vision pass and the model rerank compete for VRAM.**
Observed directly: with `gemma3:4b` resident after describing a drawing, only
2.1 GB was usable, and the router correctly refused to load the 6.5 GB
reasoner — so the rerank fell back to lexical and said so. This is the router
doing its job, not a fault, but it means back-to-back vision and reasoning work
on this hardware will serialise. `ollama stop` on the vision model frees it, and
the lab GPU box makes the question moot.

## Clearance filtering

Retrieval never takes a classification from its caller. `KnowledgeService`
resolves the caller's roles through Part 05's `readable_classifications`, and
the resulting levels go into the SQL `WHERE` clause — a chunk above the
caller's clearance is never loaded into the process that answers them.

An unrecognised role reads nothing, and an unmarked document classifies as
`INTERNAL`, never `PUBLIC`: an unmarked document is one nobody has reviewed
yet.

## Evidence

`search` returns the `Evidence` contract from `app/schemas/shared.py` — document
id and name, page, section, text, score — so the frontend can render
`[Maintenance SOP, p.7, §4.2]` as a link that jumps to the actual page. Chunks
never span a page boundary, because a citation that named two pages would be a
lie.

## The equipment graph

Tags (`P-103`, `PSV-2201`, `SOP-204`) are extracted at ingestion by pattern,
typed by ISA-5.1 prefix, and written as `(:Equipment)-[:APPEARS_IN]->(:Document)`.
Equipment appearing on the same page is linked `RELATED_TO`, weighted by
co-occurrence.

The edge is `RELATED_TO` and not `CONNECTED_TO` on purpose: page co-occurrence
is evidence of relatedness, not of a physical connection. Reading connection
lines off a drawing needs symbol and line detection, which the spec places
after the core pipeline. `GET /api/v1/knowledge/equipment/{tag}` labels its
answer `graph_traversal` or `page_co_occurrence` so the difference is visible.

## Degradation

Every stage may fail without losing the document. What happened is recorded on
the document row and returned by the reingest endpoint.

| missing | effect |
|---|---|
| Tesseract | scanned pages record no text; `ocr_status` says `unavailable` |
| model runtime | chunks stored without vectors; search is keyword-only |
| vision model | drawings keep their OCR text; `vision_status` says `unavailable` |
| reranking model | the lexical rerank runs; `rerank_method` says `lexical` |
| Neo4j | search runs on the local scan; equipment falls back to co-occurrence |

`POST /api/v1/documents/reingest/{file_id}` re-runs the pipeline once the
missing piece is up, without re-uploading a confidential file. It keeps the
same document id — citations already issued keep resolving — and bumps the
version.

## Layout

```
app/documents/          app/knowledge/
├── parser.py           ├── embeddings.py     -- via Part 02's router
├── ocr.py              ├── neo4j_client.py   -- vector index + graph
├── chunker.py          ├── retrieval.py      -- two arms, RRF, filtering
├── entities.py         ├── reranker.py       -- lexical; cross-encoder later
├── ingestion.py        └── service.py        -- the KnowledgePort
└── port.py
```

## Verifying the graph path

`tests/` pins `NEO4J_PASSWORD` empty so the suite always exercises the
relational fallback and never passes or fails on whether a container is
running. That leaves the graph path uncovered by pytest, so it is checked by
`scripts/verify_neo4j.py` against a live server: index creation and state,
both retrieval arms reporting `neo4j` rather than a fallback, the equipment
traversal, reingest replacing rather than duplicating graph state, and the
clearance filter being applied inside the Cypher.

Run it whenever the Cypher changes. It caught a real one: parameters were
forwarded to the driver as `**kwargs`, and since `Session.run` is
`run(query, parameters=None, **kw)`, a Cypher parameter named `query` bound to
the driver's own first argument and raised. The absent-tolerant wrapper
reported that as the graph being unreachable, so every full-text search
silently used the local scan and nothing looked broken. Fallback notes now
distinguish an unreachable graph from a reachable one whose query failed.

## The vision pass

A P&ID is the case that motivates it. OCR of an engineering drawing returns a
bag of tags with no structure — it will give you `V-103`, `P-12` and `FIC-101`
while losing the one thing the drawing exists to convey, which is what
connects to what.

Pages carrying graphics and little text are flagged during extraction, and the
flagged pages are described by a vision model through Part 02's router. What
comes back is stored in `vision_summary`, **never merged into `page.text`**: a
model's description of a drawing is not a quotation from it, and a citation has
to be able to tell a reader which it is looking at. The chunker sees both, with
the boundary marked inline, so a drawing becomes retrievable at all. Equipment
tags are extracted from the description too — on a P&ID that is where most of
them come from.

The pass is capped at `VISION_PASS_MAX_PAGES` per document and describes the
least-textual pages first, because a drawing gains far more from being looked
at than a page of prose with a logo on it does. On an 8 GB card a VLM sits next
to the reasoner, and a 200-page scan that ran a model on every page would stall
ingestion for minutes. `ENABLE_VISION_PASS=false` turns it off entirely.
