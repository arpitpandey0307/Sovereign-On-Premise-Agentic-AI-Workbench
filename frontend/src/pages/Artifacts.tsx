/**
 * The Artifacts library.
 *
 * Deliverables the Workbench produced, gathered from the user's recent tasks
 * (there is no list-all endpoint - artifacts belong to a task). Each card
 * carries its validation status, and a failed artifact is *kept and shown*,
 * not filtered out: the operator needs to see what the validator objected to,
 * in plain language. An agent that catches its own invented citation and
 * refuses to ship it is a stronger story than one that never appears to fail.
 *
 * Two endpoints are needed per task, because the backend splits them. The
 * artifact record (`/tasks/{id}/artifacts`, a bare array) carries the id, the
 * type and the verdict; the individual checks behind that verdict live on the
 * task's execution trace. Neither carries a filename - the server names the
 * file in `Content-Disposition` at download time, which is what `api.download`
 * uses.
 *
 * Download proxies the endpoint with the auth header - a plain link would not
 * carry the token.
 */

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Download, FileText, Loader2 } from "lucide-react";
import { api, describeError } from "@/lib/api";
import { useRole } from "@/lib/auth";
import { keys, useTasks } from "@/lib/queries";
import type { ArtifactRecord } from "@/lib/types";
import { StatusPill } from "@/components/ui/StatusPill";
import { Dialog } from "@/components/ui/Dialog";
import { LoadingState } from "@/components/states/LoadingState";
import { SecurityOversightNote } from "@/components/states/SecurityOversightNote";

/** One check the artifact validator ran, as the execution trace reports it. */
type ValidationCheck = { check: string; ok: boolean; detail?: string };

type Execution = {
  validation?: { passed?: boolean; checks?: ValidationCheck[]; failures?: unknown[] };
};

type Row = ArtifactRecord & { checks: ValidationCheck[] };

export function Artifacts() {
  const { isSecurityOnly } = useRole();
  const tasks = useTasks({ limit: 25 });
  const [type, setType] = useState<string>("all");
  const [preview, setPreview] = useState<Row | null>(null);

  // The completed tasks are the ones that produced anything.
  const taskIds = (tasks.data?.items ?? [])
    .filter((t) => t.status === "completed")
    .map((t) => t.task_id);

  // The endpoint answers with a bare array, not an envelope.
  const artifactQueries = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: keys.taskArtifacts(id),
      queryFn: () => api.get<ArtifactRecord[]>(`/api/v1/tasks/${id}/artifacts`),
      staleTime: 30_000,
    })),
  });

  // The validator's individual checks are on the execution trace, not the
  // artifact record, so a rejection can be explained rather than just flagged.
  const executionQueries = useQueries({
    queries: taskIds.map((id) => ({
      queryKey: [...keys.taskArtifacts(id), "execution"],
      queryFn: () => api.get<Execution>(`/api/v1/tasks/${id}/execution`),
      staleTime: 30_000,
    })),
  });

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    artifactQueries.forEach((query, index) => {
      const checks = executionQueries[index]?.data?.validation?.checks ?? [];
      for (const artifact of query.data ?? []) {
        out.push({ ...artifact, checks });
      }
    });
    return out;
  }, [artifactQueries, executionQueries]);

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) set.add(row.type);
    return ["all", ...[...set].sort()];
  }, [rows]);

  const shown = type === "all" ? rows : rows.filter((r) => r.type === type);

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

  const loading =
    tasks.isLoading ||
    artifactQueries.some((q) => q.isLoading) ||
    executionQueries.some((q) => q.isLoading);

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Artifacts</h2>
        <div className="sub">
          Files the workbench produced - reports, notes, spreadsheets - with the
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
            <ArtifactCard
              key={row.artifact_id}
              row={row}
              onPreview={() => setPreview(row)}
            />
          ))}
        </div>
      )}

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={
          preview ? `${preview.type.toUpperCase()} - ${preview.artifact_id.slice(0, 8)}` : ""
        }
        description="What the validator checked. Download for the formatted file."
      >
        {preview && <ValidationReport row={preview} />}
      </Dialog>
    </div>
  );
}

function ArtifactCard({ row, onPreview }: { row: Row; onPreview: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = row.validation_status === "failed";
  const failures = row.checks.filter((check) => !check.ok);

  return (
    <div
      className="card"
      style={
        failed
          ? { borderColor: "var(--danger-line)", borderLeft: "3px solid var(--danger)" }
          : undefined
      }
    >
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-primary">
            {row.type.toUpperCase()} deliverable
          </p>
          <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
            from{" "}
            <Link to={`/tasks/${row.task_id}`} className="text-accent-text hover:underline">
              task {row.task_id.slice(0, 8)}
            </Link>
            <span className="mono"> &middot; {row.artifact_id.slice(0, 8)}</span>
          </p>
        </div>
        <ValidationPill status={row.validation_status} />
      </div>

      {failed && failures.length > 0 && (
        <ul className="mt-3 space-y-1">
          {failures.map((check, index) => (
            <li key={index} className="text-[12px]" style={{ color: "var(--danger-text)" }}>
              {check.detail ? `${check.check}: ${check.detail}` : check.check}
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
          Validation
        </button>
        <button
          type="button"
          className="btn btn-sm btn-accent"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              // The server names the file; this is only the fallback.
              await api.download(
                row.download_url || `/api/v1/artifacts/${row.artifact_id}/download`,
                `${row.artifact_id.slice(0, 8)}.${row.type}`,
              );
            } catch (caught) {
              setError(describeError(caught).title);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="size-3.5" aria-hidden />
          )}
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
 * What the validator actually did.
 *
 * Every check it ran, passed and failed alike. The backend has no structural
 * preview of the file's contents and this screen does not invent one - the
 * honest thing to show is the evidence behind the verdict, which it does have.
 */
function ValidationReport({ row }: { row: Row }) {
  if (row.checks.length === 0) {
    return (
      <p className="hint">
        This task's execution trace records no individual checks. The verdict is{" "}
        <span className="mono">{row.validation_status}</span>. Download the file
        for its contents.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {row.checks.map((check, index) => (
        <li key={index} className="list-row">
          <span
            className="mono text-[11px]"
            style={{ color: check.ok ? "var(--ok-text)" : "var(--danger-text)" }}
          >
            {check.ok ? "PASS" : "FAIL"}
          </span>
          <div className="grow">
            <p className="text-[13px] text-primary">{check.check}</p>
            {check.detail ? (
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
                {check.detail}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
