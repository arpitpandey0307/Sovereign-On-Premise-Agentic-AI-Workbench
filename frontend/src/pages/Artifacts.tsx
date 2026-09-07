/**
 * The Artifacts library.
 *
 * Deliverables the Workbench produced, gathered from the user's recent tasks
 * (there is no list-all endpoint — artifacts belong to a task). Each card
 * carries its validation status, and a failed artifact is *kept and shown*,
 * not filtered out: the operator needs to see what the validator objected to,
 * in plain language. An agent that catches its own invented citation and
 * refuses to ship it is a stronger story than one that never appears to fail.
 *
 * Download proxies the endpoint with the auth header — a plain link would not
 * carry the token. Preview is a faithful structural rendering, not a slow
 * office-suite approximation.
 */

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Download, FileText, Loader2 } from "lucide-react";
import { api, describeError } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useRole } from "@/lib/auth";
import { keys, useTasks } from "@/lib/queries";
import type { Artifact } from "@/lib/types";
import { StatusPill } from "@/components/ui/StatusPill";
import { Dialog } from "@/components/ui/Dialog";
import { LoadingState } from "@/components/states/LoadingState";
import { SecurityOversightNote } from "@/components/states/SecurityOversightNote";

type Row = Artifact & { task_id: string };

export function Artifacts() {
  const { isSecurityOnly } = useRole();
  const tasks = useTasks({ limit: 25 });
  const [type, setType] = useState<string>("all");
  const [preview, setPreview] = useState<Row | null>(null);

  // The completed tasks are the ones that produced anything.
  const taskIds = (tasks.data?.items ?? [])
    .filter((t) => t.status === "completed")
    .map((t) => t.task_id);

  const artifactQueries = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: keys.taskArtifacts(id),
      queryFn: () => api.get<{ artifacts: Artifact[] }>(`/api/v1/tasks/${id}/artifacts`),
      staleTime: 30_000,
    })),
  });

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    artifactQueries.forEach((query, index) => {
      const id = taskIds[index];
      for (const artifact of query.data?.artifacts ?? []) {
        out.push({ ...artifact, task_id: artifact.task_id ?? id });
      }
    });
    return out;
  }, [artifactQueries, taskIds]);

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) set.add(extension(row.filename));
    return ["all", ...[...set].sort()];
  }, [rows]);

  const shown = type === "all" ? rows : rows.filter((r) => extension(r.filename) === type);

  if (isSecurityOnly) {
    return (
      <div className="view-pad">
        <div className="view-head">
          <h2>Artifacts</h2>
        </div>
        <SecurityOversightNote surface="Generated deliverables" />
      </div>
    );
  }

  const loading = tasks.isLoading || artifactQueries.some((q) => q.isLoading);

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Artifacts</h2>
        <div className="sub">
          Files the workbench produced — reports, notes, spreadsheets — with the
          validator's verdict on each.
        </div>
      </div>

      {types.length > 2 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {types.map((value) => (
            <button
              key={value}
              type="button"
              className={"btn btn-sm" + (type === value ? " btn-accent" : "")}
              onClick={() => setType(value)}
            >
              {value === "all" ? "All" : `.${value}`}
            </button>
          ))}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <LoadingState rows={3} label="Gathering artifacts" />
      ) : shown.length === 0 ? (
        <div className="empty-state">
          No artifacts yet. Completed tasks that produce a file will list it
          here.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map((row) => (
            <ArtifactCard key={row.id} row={row} onPreview={() => setPreview(row)} />
          ))}
        </div>
      )}

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.filename ?? ""}
        description="Structural preview — download for the formatted file."
      >
        {preview && <ArtifactPreview row={preview} />}
      </Dialog>
    </div>
  );
}

function ArtifactCard({ row, onPreview }: { row: Row; onPreview: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = row.validation_status === "failed";
  const failures = (row.validation_detail ?? []).filter(
    (d) => /fail|error|missing|not/i.test(d.result),
  );

  return (
    <div
      className="card"
      style={failed ? { borderColor: "var(--danger-line)", borderLeft: "3px solid var(--danger)" } : undefined}
    >
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-primary">{row.filename}</p>
          <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
            from{" "}
            <Link to={`/tasks/${row.task_id}`} className="text-accent-text hover:underline">
              task {row.task_id.slice(0, 8)}
            </Link>
            {row.created_at ? ` · ${formatRelative(row.created_at)}` : ""}
          </p>
        </div>
        <ValidationPill status={row.validation_status} />
      </div>

      {failed && failures.length > 0 && (
        <ul className="mt-3 space-y-1">
          {failures.map((detail, index) => (
            <li key={index} className="text-[12px]" style={{ color: "var(--danger-text)" }}>
              {detail.message || `${detail.check}: ${detail.result}`}
            </li>
          ))}
        </ul>
      )}
      {failed && failures.length === 0 && (
        <p className="mt-3 text-[12px]" style={{ color: "var(--danger-text)" }}>
          The validator rejected this artifact. It is kept so the objection is
          visible.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={onPreview}>
          Preview
        </button>
        <button
          type="button"
          className="btn btn-sm btn-accent"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.download(`/api/v1/artifacts/${row.id}/download`, row.filename);
            } catch (caught) {
              setError(describeError(caught).title);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
          Download
        </button>
        {error && (
          <span className="mono text-[11px]" style={{ color: "var(--danger-text)" }}>
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

function ValidationPill({ status }: { status?: string }) {
  if (status === "passed") return <StatusPill tone="positive">Validated</StatusPill>;
  if (status === "failed") return <StatusPill tone="danger">Validation failed</StatusPill>;
  return <StatusPill tone="warning">Validation pending</StatusPill>;
}

/**
 * A structural preview. DOCX renders as title / summary / findings with their
 * citations / recommendations; a spreadsheet as a table; slides as a list. No
 * office-rendering library — a faithful outline plus Download beats a slow
 * approximation.
 */
function ArtifactPreview({ row }: { row: Row }) {
  const p = (row.preview ?? {}) as Record<string, unknown>;

  const rows = p.rows;
  if (Array.isArray(rows)) {
    const header = Array.isArray(rows[0]) ? (rows[0] as unknown[]) : [];
    return (
      <div className="table-wrap">
        <table className="data-table">
          {header.length > 0 && (
            <thead>
              <tr>
                {header.map((cell, index) => (
                  <th key={index}>{String(cell)}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {(rows.slice(header.length > 0 ? 1 : 0) as unknown[][]).map((r, i) => (
              <tr key={i}>
                {r.map((cell, j) => (
                  <td key={j}>{String(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const slides = p.slides;
  if (Array.isArray(slides)) {
    return (
      <ol className="space-y-2">
        {slides.map((slide, index) => {
          const s = (slide ?? {}) as Record<string, unknown>;
          return (
            <li key={index} className="list-row">
              <div className="grow">
                <p className="text-[13px] font-semibold text-primary">
                  {String(s.title ?? `Slide ${index + 1}`)}
                </p>
                {s.body ? (
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-dim)" }}>
                    {String(s.body)}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    );
  }

  const findings = Array.isArray(p.findings) ? (p.findings as Record<string, unknown>[]) : [];
  return (
    <div className="space-y-3">
      {p.title ? <h3 className="text-[15px] font-semibold text-primary">{String(p.title)}</h3> : null}
      {p.summary ? (
        <p className="text-[13px]" style={{ color: "var(--text-dim)" }}>
          {String(p.summary)}
        </p>
      ) : null}
      {findings.length > 0 && (
        <div>
          <div className="field-label">Findings</div>
          <ul className="mt-1 space-y-2">
            {findings.map((finding, index) => (
              <li key={index} className="text-[13px]" style={{ color: "var(--text-dim)" }}>
                {String(finding.text ?? finding.finding ?? "")}
                {finding.citation ? (
                  <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {" "}
                    — {String(finding.citation)}
                  </span>
                ) : (
                  <span className="pill warn" style={{ marginLeft: "6px" }}>
                    unsupported
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {Array.isArray(p.recommendations) && p.recommendations.length > 0 && (
        <div>
          <div className="field-label">Recommendations</div>
          <ul className="mt-1 space-y-1">
            {(p.recommendations as unknown[]).map((rec, index) => (
              <li key={index} className="text-[13px]" style={{ color: "var(--text-dim)" }}>
                {String(rec)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!p.title && !p.summary && findings.length === 0 && (
        <p className="hint">
          No structural preview available for this artifact. Download it for the
          full file.
        </p>
      )}
    </div>
  );
}

function extension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "file" : filename.slice(dot + 1).toLowerCase();
}
