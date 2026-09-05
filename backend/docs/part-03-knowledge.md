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

Then a lexical rerank breaks the one tie this corpus reliably produces:
`V-103` and `V-104` are near-identical to an embedding model, so an exact
identifier match has to win. A cross-encoder reranker is Phase 2 — it would be
a second model resident in VRAM next to the reasoner on an 8 GB card, for
precision the demo does not yet need. `reranker.rerank` is a pure function, so
that swap touches nothing else.

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
