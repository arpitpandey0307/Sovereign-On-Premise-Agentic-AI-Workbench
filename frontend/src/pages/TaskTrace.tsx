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
import { useTask, useTaskReceipt } from "@/lib/queries";
import {
  emptyPipeline,
  applyEvent,
  type PipelineState,
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
        <ReceiptList
          label="Sources"
          items={receipt.sources?.map(
            (s) => `${s.document_name}${s.page != null ? ` — p.${s.page}` : ""}`,
          )}
        />
        <ReceiptList
          label="Artifacts"
          items={receipt.artifacts?.map((a) => a.filename)}
        />
      </div>

      {receipt.security_events && receipt.security_events.length > 0 && (
        <div>
          <div className="field-label">Security events</div>
          <ul className="mt-1 space-y-1">
            {receipt.security_events.map((event, index) => (
              <li key={index} className="mono text-[12px]" style={{ color: "var(--text-dim)" }}>
                {event.at ? `${formatTimestamp(event.at)} · ` : ""}
                {event.kind}: {event.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReceiptList({ label, items }: { label: string; items?: string[] }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      {items && items.length > 0 ? (
        <ul className="mt-1 space-y-1">
          {items.map((item, index) => (
            <li key={index} className="mono text-[12px]" style={{ color: "var(--text-dim)" }}>
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
