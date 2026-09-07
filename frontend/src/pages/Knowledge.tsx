/**
 * The Knowledge Base.
 *
 * A search across the corpus, plus the equipment graph. Two things make this
 * more than a ranked list. It shows *how* the answer was found — which
 * retrieval arm answered, which reranker ran, how many chunks it weighed — in
 * a "How this was searched" panel, because a system explaining its own
 * retrieval is what a technical audience trusts. And an empty result says
 * *which* kind of empty it is: nothing indexed, nothing matched, or matches
 * withheld by clearance — the last without revealing what was withheld.
 */

import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { GitBranch, Search, Upload } from "lucide-react";
import { describeError } from "@/lib/api";
import { useRole } from "@/lib/auth";
import { useDocuments, useEquipment, useKnowledgeSearch } from "@/lib/queries";
import type { Evidence, SearchResponse } from "@/lib/types";
import { ClassificationBadge } from "@/components/ui/StatusPill";
import { SecurityOversightNote } from "@/components/states/SecurityOversightNote";

export function Knowledge() {
  const { isSecurityOnly } = useRole();
  const [query, setQuery] = useState("");
  const search = useKnowledgeSearch();
  // The shared corpus, not this user's uploads: retrieval already searches
  // across all of it, filtered by clearance, so the browse list beside the
  // results has to be the same set.
  const documents = useDocuments(0, 100, undefined, "corpus");

  if (isSecurityOnly) {
    return (
      <div className="view-pad">
        <div className="view-head">
          <h2>Knowledge Base</h2>
        </div>
        <SecurityOversightNote surface="The knowledge base" />
      </div>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q || search.isPending) return;
    search.mutate({ query: q, limit: 20 });
  }

  const result = search.data;
  const nothingIndexed = (documents.data?.items.length ?? 0) === 0;

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Knowledge Base</h2>
        <div className="sub">
          Search the cleared corpus. Retrieval is filtered to your clearance
          before it reaches you.
        </div>
      </div>

      <form onSubmit={submit} className="mb-4 flex gap-2">
        <div className="input flex items-center gap-2" style={{ padding: "0 12px" }}>
          <Search className="size-4 shrink-0" style={{ color: "var(--text-mute)" }} aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="A question, or an exact identifier like SOP-204 or V-103"
            style={{
              border: "none",
              background: "transparent",
              outline: "none",
              width: "100%",
              padding: "13px 0",
              fontSize: "15px",
              color: "var(--text)",
            }}
          />
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!query.trim() || search.isPending}
        >
          {search.isPending ? "Searching…" : "Search"}
        </button>
      </form>

      {search.isError && (
        <p className="error-note">{describeError(search.error).detail}</p>
      )}

      {result ? (
        <SearchResults result={result} nothingIndexed={nothingIndexed} />
      ) : (
        <BrowseCorpus documents={documents} />
      )}

      <EquipmentPanel />
    </div>
  );
}

function SearchResults({
  result,
  nothingIndexed,
}: {
  result: SearchResponse;
  nothingIndexed: boolean;
}) {
  const { evidence, diagnostics } = result;

  if (evidence.length === 0) {
    // Which kind of empty is this?
    const notes = (diagnostics.notes ?? []).join(" ").toLowerCase();
    const withheld =
      /clearance|withheld|filtered|redact/.test(notes) ||
      (result as Record<string, unknown>).withheld_by_clearance === true;

    if (nothingIndexed) {
      return (
        <EmptyResult
          title="Nothing is indexed yet"
          body="Upload a document to make the corpus searchable."
          action={
            <Link to="/documents" className="btn btn-sm btn-primary">
              <Upload className="size-3.5" aria-hidden />
              Upload a document
            </Link>
          }
        />
      );
    }
    if (withheld) {
      return (
        <EmptyResult
          title="Some results were withheld"
          body="Matches exist above your clearance and were filtered out server-side. Nothing about them is shown here — including whether the filter changed the outcome."
        />
      );
    }
    return (
      <EmptyResult
        title="No match"
        body={`Nothing in the ${diagnostics.chunks_considered} chunks considered matched. An exact identifier — SOP-204, PSV-107, V-103 — is what the keyword arm is best at.`}
      />
    );
  }

  return (
    <div className="space-y-3">
      {evidence.map((item, index) => (
        <EvidenceRow key={`${item.document_id}-${item.page}-${index}`} item={item} />
      ))}
      <SearchDiagnostics diagnostics={diagnostics} query={result.query} />
    </div>
  );
}

function EvidenceRow({ item }: { item: Evidence }) {
  const href = `/documents/${item.document_id}?page=${item.page}${
    item.text ? `&q=${encodeURIComponent(item.text.slice(0, 240))}` : ""
  }`;
  return (
    <div className="list-row">
      <div className="grow">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-primary">
            {item.document_name}
          </span>
          <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
            Page {item.page}
            {item.section ? ` · ${item.section}` : ""}
          </span>
          {item.score != null && (
            <span className="pill">{item.score.toFixed(2)}</span>
          )}
        </div>
        <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-dim)" }}>
          {item.text}
        </p>
      </div>
      <Link to={href} className="btn btn-sm btn-accent">
        View source
      </Link>
    </div>
  );
}

function SearchDiagnostics({
  diagnostics,
  query,
}: {
  diagnostics: SearchResponse["diagnostics"];
  query: string;
}) {
  const fellBack = /local_scan|scan/i.test(diagnostics.vector_backend);
  return (
    <details className="reasoning">
      <summary>
        <span className="chev mono">▸</span>
        How this was searched
      </summary>
      <div className="timeline" style={{ display: "block" }}>
        <dl className="space-y-1.5 text-[12px]">
          <DiagRow label="Query" value={query} />
          <DiagRow
            label="Retrieval"
            value={
              fellBack
                ? `${diagnostics.vector_backend} (graph unavailable — fell back to a local scan)`
                : diagnostics.vector_backend
            }
          />
          <DiagRow label="Keyword arm" value={diagnostics.keyword_backend} />
          <DiagRow label="Reranker" value={diagnostics.rerank_method} />
          <DiagRow
            label="Considered"
            value={`${diagnostics.chunks_considered} chunks · ${diagnostics.vector_hits} vector + ${diagnostics.keyword_hits} keyword hits`}
          />
          <DiagRow
            label="Readable to you"
            value={diagnostics.classifications_allowed.join(", ") || "—"}
          />
        </dl>
        {diagnostics.notes?.length > 0 && (
          <ul className="mt-2 space-y-1">
            {diagnostics.notes.map((note, index) => (
              <li key={index} className="text-[12px]" style={{ color: "var(--text-mute)" }}>
                {note}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt style={{ color: "var(--text-mute)" }}>{label}</dt>
      <dd className="mono text-right" style={{ color: "var(--text-dim)" }}>
        {value}
      </dd>
    </div>
  );
}

function BrowseCorpus({
  documents,
}: {
  documents: ReturnType<typeof useDocuments>;
}) {
  if (documents.isLoading) {
    return <p className="loading-note">Loading the corpus…</p>;
  }
  const items = documents.data?.items ?? [];
  if (items.length === 0) {
    return (
      <EmptyResult
        title="Nothing is indexed yet"
        body="Upload a document to make the corpus searchable."
        action={
          <Link to="/documents" className="btn btn-sm btn-primary">
            <Upload className="size-3.5" aria-hidden />
            Upload a document
          </Link>
        }
      />
    );
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Document</th>
            <th>Type</th>
            <th>Classification</th>
            <th>Version</th>
            <th>Pages</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((doc) => (
            <tr key={doc.id}>
              <td>
                <Link to={`/documents/${doc.id}`} className="text-accent-text hover:underline">
                  {doc.filename}
                </Link>
              </td>
              <td>{doc.kind || doc.mime_type}</td>
              <td>
                <ClassificationBadge level={doc.classification} />
              </td>
              <td className="mono">v{doc.version}</td>
              <td className="mono">{doc.page_count || "—"}</td>
              <td>{doc.indexed_in_graph ? "in graph" : "text only"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EquipmentPanel() {
  const [tag, setTag] = useState("");
  const [active, setActive] = useState("");
  const graph = useEquipment(active);

  return (
    <div className="card mt-8">
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 text-accent" aria-hidden />
        <span className="section-title">Equipment graph</span>
      </div>
      <p className="mt-1 text-[12px]" style={{ color: "var(--text-mute)" }}>
        What relates to a tag — P-103, V-201 — traversed across the corpus. This
        is the feature a generic local-AI tool does not have.
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setActive(tag.trim().toUpperCase());
        }}
      >
        <input
          className="input"
          style={{ maxWidth: "220px" }}
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          placeholder="Equipment tag"
        />
        <button type="submit" className="btn btn-sm" disabled={!tag.trim()}>
          Trace
        </button>
      </form>

      {active && graph.isLoading && <p className="loading-note">Traversing…</p>}
      {active && graph.isError && (
        <p className="hint" style={{ marginTop: "8px" }}>
          Nothing found for {active}, or the graph is unavailable.
        </p>
      )}
      {graph.data && (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <span className="mono text-[13px]" style={{ color: "var(--accent-bright)" }}>
              {graph.data.tag}
            </span>
            {graph.data.type && <span className="pill">{graph.data.type}</span>}
            {/* Co-occurrence is a weaker claim than a modelled relationship, and
                must not be presented as the stronger one. */}
            <span
              className={
                "pill " + (graph.data.source === "graph_traversal" ? "ok" : "warn")
              }
            >
              {graph.data.source === "graph_traversal"
                ? "graph relationship"
                : "same-page co-occurrence"}
            </span>
          </div>
          {graph.data.source !== "graph_traversal" && (
            <p className="mt-1.5 text-[12px]" style={{ color: "var(--warn-text)" }}>
              These tags appear on the same page. That is not the same as them
              being connected.
            </p>
          )}
          <ul className="mt-2 space-y-1.5">
            {(graph.data.neighbours ?? []).map((n) => (
              <li key={n.tag} className="text-[13px]" style={{ color: "var(--text-dim)" }}>
                <span className="mono" style={{ color: "var(--text)" }}>
                  {n.tag}
                </span>
                {n.type ? ` (${n.type})` : ""}
                {n.relation ? ` — ${n.relation}` : ""}
                {n.documents?.length
                  ? ` · ${n.documents.map((d) => d.name).join(", ")}`
                  : ""}
              </li>
            ))}
            {(graph.data.neighbours ?? []).length === 0 && (
              <li className="hint">No neighbours recorded.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function EmptyResult({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state" style={{ textAlign: "left" }}>
      <p style={{ color: "var(--text-dim)", fontWeight: 500, fontSize: "14px" }}>
        {title}
      </p>
      <p style={{ marginTop: "6px" }}>{body}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
