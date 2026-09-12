/**
 * Approval Requests.
 *
 * Every task here has genuinely paused — the backend is holding state and
 * waiting for a person. The screen presents each as a decision that needs an
 * answer, not a notification to dismiss. `Approve` and `Reject` post the
 * literal `approved` value; nothing computes it, because inverting it would let
 * a rejection resume a task.
 *
 * Nothing here calls the AI's output final. The language is "draft",
 * "proposed", "for review" — the gate is the product admitting its own limits.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { describeError } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useResumeTask, useTasks } from "@/lib/queries";
import type { Task } from "@/lib/types";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import { AccessQueue } from "@/components/access/AccessQueue";

export function Approvals() {
  const { data, isLoading, isError, error, refetch } = useTasks({
    status: "waiting_approval",
    limit: 50,
  });

  const items = data?.items ?? [];

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Approval requests</h2>
        <div className="sub">
          Tasks that have paused before a consequential step and need a person to
          decide.
        </div>
      </div>

      {/*
        * Access requests sit on the same screen as paused tasks because they
        * are the same job: somebody is waiting on a person, and the queue is
        * only useful if there is one place to look.
        */}
      <AccessQueue />

      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <LoadingState rows={3} label="Loading approvals" />
      ) : items.length === 0 ? (
        <div className="empty-state">
          <CheckCircle2
            className="mx-auto mb-2 size-6"
            style={{ color: "var(--ok-text)" }}
            aria-hidden
          />
          Nothing is waiting for your approval.
        </div>
      ) : (
        <div>
          {items.map((task) => (
            <ApprovalCard key={task.task_id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ task }: { task: Task }) {
  const resume = useResumeTask(task.task_id);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<"approved" | "rejected" | null>(null);

  async function answer(approved: boolean) {
    setError(null);
    try {
      await resume.mutateAsync({ approved, note: note.trim() || undefined });
      setAnswered(approved ? "approved" : "rejected");
    } catch (caught) {
      setError(describeError(caught).detail);
    }
  }

  if (answered) {
    return (
      <div className="approval-card">
        <div className="grow">
          <div className="a-title">
            {answered === "approved" ? "Approved" : "Rejected"} —{" "}
            {truncate(task.request_text)}
          </div>
          <p className="a-meta">
            The task has been {answered === "approved" ? "resumed" : "closed"}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="approval-card risk-medium">
      <div className="grow">
        <div className="a-head">
          <span className="a-title">{truncate(task.request_text)}</span>
          <span className="pill warn">DRAFT — NOT A DECISION</span>
        </div>
        <p className="a-meta">
          {task.task_id} · {task.task_type || "task"} · paused{" "}
          {formatRelative(task.updated_at)}
        </p>

        <Link
          to={`/workbench?task=${task.task_id}`}
          className="mt-2 inline-flex items-center gap-1.5 text-[12px]"
          style={{ color: "var(--accent-bright)" }}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Review the draft in the Workbench
        </Link>

        <textarea
          className="textarea mono"
          rows={2}
          placeholder="Optional note for the record…"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          style={{ marginTop: "10px", fontSize: "13px" }}
        />
        {error && (
          <p className="error-note" style={{ marginTop: "8px" }}>
            {error}
          </p>
        )}
      </div>

      <div className="a-actions">
        <button
          type="button"
          className="btn btn-sm btn-ok"
          disabled={resume.isPending}
          onClick={() => answer(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={resume.isPending}
          onClick={() => answer(false)}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function truncate(text: string, at = 96) {
  return text.length > at ? `${text.slice(0, at)}…` : text;
}
