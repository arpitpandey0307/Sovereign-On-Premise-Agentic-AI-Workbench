"""Neo4j: the vector index and the equipment graph.

Neo4j was chosen over a dedicated vector database because this project needs
both halves of what it offers. The vector index answers "what does this
document say about isolation procedure", and the same store answers "which
valves are connected to pump P-103" as a graph traversal -- a question a
vector database cannot express at all.

The client is written to be *absent-tolerant*. On an air-gapped machine there
is nobody to restart a container mid-demo, so every method reports failure
rather than raising, and the caller degrades to the relational path. Connection
is lazy for the same reason: the API must start with Neo4j down.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from app.core.config import settings

logger = logging.getLogger("workbench.neo4j")

CHUNK_VECTOR_INDEX = "chunk_embedding_index"
CHUNK_FULLTEXT_INDEX = "chunk_text_index"

# How long to wait for the driver to prove it can reach the server. Short on
# purpose: an unreachable graph must not add seconds to every upload.
PROBE_TIMEOUT_S = 3.0


@dataclass
class GraphHit:
    chunk_id: str
    document_id: str
    score: float


class Neo4jClient:
    """Thin, failure-tolerant wrapper around the Bolt driver."""

    def __init__(self) -> None:
        self._driver: Any = None
        self._lock = threading.Lock()
        self._last_error = ""
        self._indexed_dimensions: int | None = None

    # --- connection -------------------------------------------------------

    def _connect(self) -> Any:
        """Open the driver once, under a lock. Returns ``None`` if it fails."""
        if self._driver is not None:
            return self._driver
        with self._lock:
            if self._driver is not None:
                return self._driver
            if not settings.neo4j_password:
                # An unauthenticated graph holding confidential chunks is not
                # something to fall back to silently.
                self._last_error = "NEO4J_PASSWORD is not set"
                return None
            try:
                from neo4j import GraphDatabase

                driver = GraphDatabase.driver(
                    settings.neo4j_uri,
                    auth=(settings.neo4j_user, settings.neo4j_password),
                    connection_timeout=PROBE_TIMEOUT_S,
                )
                driver.verify_connectivity()
            except Exception as exc:
                self._last_error = f"{type(exc).__name__}: {exc}"
                logger.info("Neo4j unavailable (%s)", self._last_error)
                return None
            self._driver = driver
            self._last_error = ""
            return driver

    def available(self) -> bool:
        return self._connect() is not None

    def status(self) -> dict:
        reachable = self.available()
        return {
            "reachable": reachable,
            "uri": settings.neo4j_uri,
            "database": settings.neo4j_database,
            "detail": "connected" if reachable else self._last_error,
        }

    def close(self) -> None:
        with self._lock:
            if self._driver is not None:
                self._driver.close()
                self._driver = None

    def _run(self, cypher: str, **params: Any) -> list[dict] | None:
        driver = self._connect()
        if driver is None:
            return None
        try:
            with driver.session(database=settings.neo4j_database) as session:
                # Parameters go in as a dict, never as **kwargs. The driver's
                # own signature is run(query, parameters=None, **kw), so a
                # Cypher parameter named "query" -- which the full-text search
                # uses -- would bind to the driver's first argument instead and
                # raise, and this method would report it as the graph being
                # down.
                return [record.data() for record in session.run(cypher, params)]
        except Exception as exc:
            self._last_error = f"{type(exc).__name__}: {exc}"
            logger.warning("Cypher failed: %s", self._last_error)
            return None

    # --- schema -----------------------------------------------------------

    def ensure_schema(self, dimensions: int) -> bool:
        """Create the constraints and indexes, sized to the embedding model.

        The vector index is dimension-bound, so it is created on first write
        once the actual embedding width is known rather than guessed at
        startup from a hard-coded number.
        """
        if self._indexed_dimensions == dimensions:
            return True

        statements = [
            "CREATE CONSTRAINT document_id IF NOT EXISTS "
            "FOR (d:Document) REQUIRE d.id IS UNIQUE",
            "CREATE CONSTRAINT chunk_id IF NOT EXISTS "
            "FOR (c:Chunk) REQUIRE c.id IS UNIQUE",
            "CREATE CONSTRAINT equipment_tag IF NOT EXISTS "
            "FOR (e:Equipment) REQUIRE e.tag IS UNIQUE",
            f"CREATE FULLTEXT INDEX {CHUNK_FULLTEXT_INDEX} IF NOT EXISTS "
            "FOR (c:Chunk) ON EACH [c.text]",
        ]
        if dimensions > 0:
            statements.append(
                f"CREATE VECTOR INDEX {CHUNK_VECTOR_INDEX} IF NOT EXISTS "
                "FOR (c:Chunk) ON (c.embedding) OPTIONS {indexConfig: {"
                f"`vector.dimensions`: {int(dimensions)}, "
                "`vector.similarity_function`: 'cosine'}}"
            )

        for statement in statements:
            if self._run(statement) is None:
                return False

        self._indexed_dimensions = dimensions
        return True

    # --- writes -----------------------------------------------------------

    def upsert_document(
        self,
        *,
        document_id: UUID,
        name: str,
        classification: str,
        version: int,
        chunks: list[dict],
        dimensions: int,
    ) -> bool:
        """Replace a document's chunks in the graph. Idempotent per document.

        Old chunks are detached first: re-ingesting a corrected scan must not
        leave the previous version's text retrievable, or a citation could
        quote a superseded document.
        """
        if not self.ensure_schema(dimensions):
            return False

        if self.delete_document(document_id) is False:
            return False

        merged = self._run(
            "MERGE (d:Document {id: $id}) "
            "SET d.name = $name, d.classification = $classification, "
            "    d.version = $version",
            id=str(document_id),
            name=name,
            classification=classification,
            version=version,
        )
        if merged is None:
            return False

        # One UNWIND rather than a statement per chunk: a 300-page SOP would
        # otherwise be 300 round trips.
        written = self._run(
            "MATCH (d:Document {id: $id}) "
            "UNWIND $chunks AS chunk "
            "CREATE (c:Chunk {id: chunk.id}) "
            "SET c.text = chunk.text, c.page = chunk.page, "
            "    c.section = chunk.section, c.embedding = chunk.embedding, "
            "    c.classification = chunk.classification, "
            "    c.document_id = $id "
            "CREATE (d)-[:HAS_CHUNK]->(c)",
            id=str(document_id),
            chunks=chunks,
        )
        return written is not None

    def upsert_equipment(
        self,
        *,
        document_id: UUID,
        tags: list[dict],
        connections: list[dict],
    ) -> bool:
        """Write the P&ID equipment graph for one document.

        ``RELATED_TO`` rather than ``CONNECTED_TO`` while the evidence is page
        co-occurrence: claiming a physical connection the drawing does not
        show would be worse than claiming nothing.
        """
        if not tags:
            return True

        written = self._run(
            "MATCH (d:Document {id: $id}) "
            "UNWIND $tags AS tag "
            "MERGE (e:Equipment {tag: tag.tag}) "
            "SET e.type = tag.entity_type "
            "MERGE (e)-[appears:APPEARS_IN]->(d) "
            "SET appears.page = tag.page, appears.occurrences = tag.occurrences",
            id=str(document_id),
            tags=tags,
        )
        if written is None:
            return False

        if not connections:
            return True

        linked = self._run(
            "UNWIND $pairs AS pair "
            "MATCH (a:Equipment {tag: pair.source}) "
            "MATCH (b:Equipment {tag: pair.target}) "
            "MERGE (a)-[rel:RELATED_TO]-(b) "
            "SET rel.weight = coalesce(rel.weight, 0) + pair.weight, "
            "    rel.basis = 'page_co_occurrence'",
            pairs=connections,
        )
        return linked is not None

    def delete_document(self, document_id: UUID) -> bool | None:
        """Remove a document and its chunks. ``None`` means the graph is down."""
        return (
            self._run(
                "MATCH (d:Document {id: $id}) "
                "OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk) "
                "DETACH DELETE c, d",
                id=str(document_id),
            )
            is not None
        )

    # --- reads ------------------------------------------------------------

    def vector_search(
        self, embedding: list[float], *, limit: int, classifications: list[str]
    ) -> list[GraphHit] | None:
        """Approximate nearest neighbours, filtered to readable chunks.

        The index is queried for more than ``limit`` because the clearance
        filter is applied after retrieval: asking for exactly ``limit`` would
        return fewer results to a lower-cleared caller for no good reason.
        """
        rows = self._run(
            f"CALL db.index.vector.queryNodes('{CHUNK_VECTOR_INDEX}', $k, $embedding) "
            "YIELD node, score "
            "WHERE node.classification IN $classifications "
            "RETURN node.id AS chunk_id, node.document_id AS document_id, "
            "       score AS score "
            "ORDER BY score DESC LIMIT $limit",
            k=max(limit * 4, 20),
            embedding=embedding,
            classifications=classifications,
            limit=limit,
        )
        return None if rows is None else [GraphHit(**row) for row in rows]

    def fulltext_search(
        self, query: str, *, limit: int, classifications: list[str]
    ) -> list[GraphHit] | None:
        rows = self._run(
            f"CALL db.index.fulltext.queryNodes('{CHUNK_FULLTEXT_INDEX}', $query, "
            "{limit: $k}) YIELD node, score "
            "WHERE node.classification IN $classifications "
            "RETURN node.id AS chunk_id, node.document_id AS document_id, "
            "       score AS score "
            "ORDER BY score DESC LIMIT $limit",
            query=query,
            k=max(limit * 4, 20),
            classifications=classifications,
            limit=limit,
        )
        return None if rows is None else [GraphHit(**row) for row in rows]

    def equipment_neighbours(
        self, tag: str, *, depth: int = 1, classifications: list[str]
    ) -> list[dict] | None:
        """Traverse the equipment graph outwards from one tag.

        This is the query that a vector store cannot answer: it walks real
        relationships rather than ranking text by similarity.
        """
        rows = self._run(
            "MATCH (start:Equipment {tag: $tag}) "
            f"MATCH path = (start)-[:RELATED_TO*1..{max(1, min(depth, 3))}]-"
            "(other:Equipment) "
            "WITH other, min(length(path)) AS hops "
            "OPTIONAL MATCH (other)-[:APPEARS_IN]->(d:Document) "
            "WHERE d.classification IN $classifications "
            "RETURN other.tag AS tag, other.type AS type, hops AS hops, "
            "       collect(DISTINCT {id: d.id, name: d.name}) AS documents "
            "ORDER BY hops, tag",
            tag=tag.upper(),
            classifications=classifications,
        )
        return rows


neo4j_client = Neo4jClient()
