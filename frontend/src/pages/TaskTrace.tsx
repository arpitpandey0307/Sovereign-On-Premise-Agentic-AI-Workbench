/**
 * The forensic trace: what the agent actually did.
 *
 * The timeline is rebuilt from the task's own event stream — the server
 * replays the whole buffer for a finished task — so it is the same nine stages
 * the Workbench showed live, now with each stage's rationale exposed as an
 * expandable "Why?". Beneath it sits the receipt: every line derived from the
 * audit ledger as the work happened, with `external_calls` and `sovereignty`
 * given the prominence they earn against a real completed task.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { formatRelative, formatTimestamp } from "@/lib/format";
import { useTask, useTaskExecution, useTaskReceipt } from "@/lib/queries";
import {
  emptyPipeline,
  applyEvent,
  type PipelineState,
  type TaskExecution,
} from "@/lib/pipeline";
import { streamTaskEvents } from "@/lib/sse";
import { TaskStatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import type { TaskReceipt } from "@/lib/types";

export function TaskTrace() {
  const { id = "" } = useParams();
  const task = useTask(id);
  const receipt = useTaskReceipt(id);
  // The event stream's backlog is held in memory and does not survive a
  // restart, so a trace opened later replays nothing. The orchestrator's own
  // record does survive, and is what carries the plan and its rationale.
  const execution = useTaskExecution(id);

  const [pipeline, setPipeline] = useState<PipelineState>(emptyPipeline);
  const [replaying, setReplaying] = useState(true);

  useEffect(() => {
    if (!id) return;
    setPipeline(emptyPipeline());
    setReplaying(true);
    const stop = streamTaskEvents(id, {
      onEvent: (event) => setPipeline((state) => applyEvent(state, event)),
      onClose: () => setReplaying(false),
      onError: () => setReplaying(false),
    });
    return stop;
  }, [id]);

  if (task.isError) return <ErrorState error={task.error} onRetry={() => task.refetch()} />;
  if (task.isLoading || !task.data) {
    return (
      <div className="view-pad">
        <LoadingState rows={3} label="Loading the trace" />
      </div>
    );
  }

  const t = task.data;
  // Whether the replay actually produced anything beyond the terminal event.
  const anyStageReported = pipeline.stages.some((stage) => Boolean(stage.detail));

  return (
    <div className="view-pad">
      <Link
        to="/tasks"
        className="mb-4 inline-flex items-center gap-1.5 text-[12px]"
        style={{ color: "var(--text-mute)" }}
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All tasks
      </Link>

      <div className="view-head">
        <div className="flex flex-wrap items-center gap-3">
          <h2>{t.request_text.length > 90 ? `${t.request_text.slice(0, 90)}…` : t.request_text}</h2>
          <TaskStatusPill status={t.status} />
        </div>
        <div className="sub mono">
          {t.task_id} · {t.task_type || "task"} · created {formatRelative(t.created_at)}
        </div>
      </div>

      <h3 className="section-title">Execution</h3>
      <div className="timeline mt-3" style={{ borderTop: "none", padding: 0 }}>
        {pipeline.stages.map((stage, index) => (
          <details
            key={stage.id}
            className="tl-step"
            style={{ display: "block" }}
            open={stage.status === "failed"}
          >
            <summary
              className="flex cursor-pointer list-none items-center gap-3"
              style={{ padding: "2px 0" }}
            >
              <span
                className={
                  "tl-node" +
                  (stage.status === "done"
                    ? " "
                    : "")
                }
                style={{
                  borderColor:
                    stage.status === "done"
                      ? "var(--ok-line)"
                      : stage.status === "active"
                        ? "var(--accent)"
                        : stage.status === "failed"
                          ? "var(--danger-line)"
                          : "var(--border-strong)",
                  color:
                    stage.status === "done"
                      ? "var(--ok-text)"
                      : stage.status === "failed"
                        ? "var(--danger-text)"
                        : "var(--text-mute)",
                }}
              >
                {stage.status === "done" ? "✓" : stage.status === "failed" ? "✗" : String(index + 1)}
              </span>
              <span className="tl-name">{stage.name}</span>
              {stage.detail && (
                <span className="mono" style={{ color: "var(--text-faint)", fontSize: "11px" }}>
                  Why?
                </span>
              )}
            </summary>
            {stage.detail && (
              <p
                className="tl-detail"
                style={{ marginLeft: "34px", marginTop: "2px", marginBottom: "6px" }}
              >
                {stage.detail}
              </p>
            )}
          </details>
        ))}
      </div>
      {replaying && <p className="loading-note">Replaying the event log…</p>}
      {pipeline.error && <div className="risk-callout danger mt-2">{pipeline.error}</div>}

      <OrchestratorRecord
        execution={execution.data}
        loading={execution.isLoading}
        replayedNothing={!replaying && !anyStageReported}
      />

      <h3 className="section-title mt-8">Receipt</h3>
      {receipt.isError ? (
        <p className="hint mt-2">
          The receipt is not available for this task yet.
        </p>
      ) : receipt.isLoading || !receipt.data ? (
        <p className="loading-note">Reading the receipt…</p>
      ) : (
        <ReceiptPanel receipt={receipt.data} />
      )}
    </div>
  );
}

/**
 * The orchestrator's own record of the run.
 *
 * The nine-stage timeline above is derived from the event stream, whose
 * backlog is held in memory: reopen a trace after a restart and it replays
 * nothing, leaving the "Why?" on every stage empty. This section reads the
 * persisted execution record instead, so the plan and the reason for each step
 * are there whenever the task itself is.
 */
function OrchestratorRecord({
  execution,
  loading,
  replayedNothing,
}: {
  execution?: TaskExecution;
  loading: boolean;
  replayedNothing: boolean;
}) {
  const plan = execution?.plan ?? [];
  const steps = execution?.steps ?? [];

  if (loading) return <p className="loading-note">Reading the execution record…</p>;
  if (plan.length === 0 && steps.length === 0) return null;

  return (
    <>
      <h3 className="section-title mt-8">Plan and steps</h3>
      {replayedNothing && (
        <p className="hint" style={{ marginTop: "6px" }}>
          The live event log for this run is no longer buffered. What follows is
          the orchestrator's recorded execution, which is kept with the task.
        </p>
      )}

      {plan.length > 0 && (
        <ol className="mt-3 space-y-1">
          {plan.map((entry, index) => (
            <li key={index} className="list-row">
              <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="grow">
                <p className="mono text-[13px] text-primary">{entry.step}</p>
                {entry.why ? (
                  <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
                    {entry.why}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {steps.length > 0 && (
        <div className="table-wrap mt-4">
          <table className="data-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Result</th>
                <th>What was recorded</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step, index) => (
                <tr key={index}>
                  <td className="mono">{step.step}</td>
                  <td>
                    <span className={"pill " + (step.ok === false ? "danger" : "ok")}>
                      {step.ok === false ? "failed" : "ok"}
                    </span>
                  </td>
                  <td className="mono" style={{ color: "var(--text-mute)", fontSize: "11px" }}>
                    {describeStep(step)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * The fields an orchestrator step carries vary by step, so they are rendered
 * as they come rather than mapped to a fixed set that would silently drop
 * whatever a new step records.
 */
function describeStep(step: Record<string, unknown>): string {
  const skip = new Set(["step", "ok", "at"]);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(step)) {
    if (skip.has(key) || value === null || value === undefined || value === "") continue;
    parts.push(`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  }
  return parts.join(" · ") || "—";
}

function ReceiptPanel({ receipt }: { receipt: TaskReceipt }) {
  const external = receipt.external_calls ?? 0;
  const sovereign = (receipt.sovereignty ?? "INTACT").toUpperCase();
  const clean = external === 0 && sovereign === "INTACT";

  return (
    <div className="mt-3 space-y-4">
      <div className={"sov" + (clean ? "" : " breach")} style={{ padding: "16px 20px" }}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="field-label" style={{ margin: 0 }}>
              External calls
            </div>
            <div
              className="mono"
              style={{
                fontSize: "40px",
                fontWeight: 700,
                color: clean ? "var(--ok-text)" : "var(--danger-text)",
              }}
            >
              {external}
            </div>
          </div>
          <div className="text-right">
            <div className="field-label" style={{ margin: 0 }}>
              Sovereignty
            </div>
            <div
              className="mono"
              style={{
                fontSize: "22px",
                fontWeight: 700,
                color: clean ? "var(--ok-text)" : "var(--danger-text)",
              }}
            >
              {sovereign}
            </div>
          </div>
        </div>
        <p className="mt-3 text-[12px]" style={{ color: "var(--text-mute)" }}>
          Counted by an audit hook as the task ran, not summarised afterwards.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ReceiptList label="Models used" items={receipt.models_used} />
        <ReceiptList label="Tools used" items={receipt.tools_used} />
        <ReceiptList label="Documents consulted" items={receipt.documents_consulted} />
        <ReceiptList label="Input files" items={receipt.input_files} />
        <ReceiptList label="Artifacts produced" items={receipt.artifacts} mono />
      </div>

      {/* A refusal is the ledger proving the controls are live, so it is
          stated rather than left to be inferred from an absence. */}
      {receipt.tools_denied && receipt.tools_denied.length > 0 && (
        <div>
          <div className="field-label">Tools denied by policy</div>
          <ul className="mt-1 space-y-1">
            {receipt.tools_denied.map((tool, index) => (
              <li
                key={index}
                className="mono text-[12px]"
                style={{ color: "var(--danger-text)" }}
              >
                {tool}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="hint">
        {receipt.events_recorded ?? 0} ledger entr
        {(receipt.events_recorded ?? 0) === 1 ? "y" : "ies"} recorded
        {receipt.started_at && receipt.finished_at
          ? ` · ${formatTimestamp(receipt.started_at)} → ${formatTimestamp(receipt.finished_at)}`
          : ""}
        .
      </p>
    </div>
  );
}

function ReceiptList({
  label,
  items,
  mono = false,
}: {
  label: string;
  items?: string[];
  mono?: boolean;
}) {
  return (
    <div>
      <div className="field-label">{label}</div>
      {items && items.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {items.map((item, index) => (
            <li
              key={index}
              className={"mono text-[12px]" + (mono ? " break-all" : "")}
              style={{ color: "var(--text-dim)" }}
            >
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint" style={{ marginTop: "4px" }}>
          None
        </p>
      )}
    </div>
  );
}
