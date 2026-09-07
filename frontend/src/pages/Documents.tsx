/**
 * My Documents.
 *
 * The list of documents the user has put into the workbench, each with its
 * ingestion state visible — indexing, indexed, or errored with a Reingest for
 * a document processed while OCR or the model runtime was down. A row opens the
 * viewer. `SECURITY_ADMIN` sees the deliberate oversight note instead: that
 * role monitors the corpus without reading it.
 */

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { describeError } from "@/lib/api";
import { useRole } from "@/lib/auth";
import {
  useDeleteFile,
  useDocuments,
  useReingest,
  useUploadFile,
} from "@/lib/queries";
import type { DocumentSummary } from "@/lib/types";
import { ClassificationBadge, StatusPill } from "@/components/ui/StatusPill";
import { Table, type Column } from "@/components/ui/Table";
import { ErrorState } from "@/components/states/ErrorState";
import { SecurityOversightNote } from "@/components/states/SecurityOversightNote";


function IngestionPill({ doc }: { doc: DocumentSummary }) {
  if (doc.ingest_error) return <StatusPill tone="danger">Ingest failed</StatusPill>;
  const s = doc.status?.toLowerCase() ?? "";
  if (s.includes("index") && doc.chunk_count > 0) {
    return <StatusPill tone="positive">Indexed</StatusPill>;
  }
  if (s.includes("process") || s.includes("pending") || doc.chunk_count === 0) {
    return (
      <StatusPill tone="info" spin>
        Indexing
      </StatusPill>
    );
  }
  return <StatusPill tone="inactive">{doc.status || "Unknown"}</StatusPill>;
}

export function Documents() {
  const navigate = useNavigate();
  const { isSecurityOnly } = useRole();
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const documents = useDocuments(0, 100, {
    // Keep polling while anything is still being ingested.
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some(
        (d) => !d.ingest_error && (d.chunk_count === 0 || /process|pending/i.test(d.status)),
      )
        ? 4000
        : false,
  });
  const upload = useUploadFile();
  const reingest = useReingest();
  const remove = useDeleteFile();

  if (isSecurityOnly) {
    return (
      <div className="view-pad">
        <div className="view-head">
          <h2>My Documents</h2>
        </div>
        <SecurityOversightNote surface="The document corpus" />
      </div>
    );
  }

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    try {
      await upload.mutateAsync(file);
    } catch (caught) {
      setError(describeError(caught).detail);
    }
  }

  const columns: Column<DocumentSummary>[] = [
    {
      key: "name",
      header: "Document",
      cell: (doc) => (
        <button
          type="button"
          className="text-accent-text hover:underline"
          onClick={() => navigate(`/documents/${doc.id}`)}
        >
          {doc.filename}
        </button>
      ),
    },
    {
      key: "class",
      header: "Classification",
      cell: (doc) => (
        <span title={doc.classification_reason || undefined}>
          <ClassificationBadge level={doc.classification} />
          {doc.classification_reason ? (
            <span
              className="block text-[11px]"
              style={{ color: "var(--text-faint)", maxWidth: "22ch" }}
            >
              {doc.classification_reason}
            </span>
          ) : null}
        </span>
      ),
    },
    { key: "status", header: "Ingestion", cell: (doc) => <IngestionPill doc={doc} /> },
    { key: "pages", header: "Pages", cell: (doc) => doc.page_count || "—", numeric: true },
    { key: "chunks", header: "Chunks", cell: (doc) => doc.chunk_count || "—", numeric: true },
    {
      key: "graph",
      header: "Graph",
      cell: (doc) =>
        doc.indexed_in_graph ? (
          <span className="pill ok">in graph</span>
        ) : (
          <span className="pill" title="Searchable, but not linked into the knowledge graph">
            text only
          </span>
        ),
    },
    {
      key: "actions",
      header: "",
      cell: (doc) => (
        <div className="flex justify-end gap-1.5">
          {(doc.ingest_error || doc.chunk_count === 0) && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={reingest.isPending}
              onClick={() => reingest.mutate(doc.file_id)}
              title="Re-run ingestion"
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete "${doc.filename}"? This cannot be undone.`)) {
                remove.mutate(doc.file_id);
              }
            }}
            title="Delete"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>My Documents</h2>
        <div className="sub">
          Cleared documents available to ground your questions. Ingestion runs in
          the background after upload.
        </div>
      </div>

      <div className="card" style={{ marginBottom: "18px" }}>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            {upload.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
            Upload document
          </button>
          <input ref={fileInput} type="file" hidden onChange={onPick} />
          {/* The classification is not the uploader's to choose. The ingester
              reads the document's own markings and says what it concluded, per
              document, in the table below -- a dropdown here would let someone
              mislabel a document and would be believed. */}
          <span className="hint" style={{ margin: 0 }}>
            Classification is read from the document's own markings during
            ingestion, and the reason is recorded against each one.
          </span>
        </div>
        {error && (
          <p className="error-note" style={{ marginTop: "10px" }}>
            {error}
          </p>
        )}
      </div>

      {documents.isError ? (
        <ErrorState error={documents.error} onRetry={() => documents.refetch()} />
      ) : (
        <Table
          columns={columns}
          rows={documents.data?.items ?? []}
          rowKey={(doc) => doc.id}
          loading={documents.isLoading}
          empty="No documents yet. Upload one to make it available to the workbench."
        />
      )}
    </div>
  );
}
