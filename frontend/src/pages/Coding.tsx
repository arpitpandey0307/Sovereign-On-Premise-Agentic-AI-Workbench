/**
 * The Coding Workspace.
 *
 * A coding task runs generated code in a container with no network interface.
 * That confinement is a verified property — `scripts/verify_sandbox.py` proves
 * each line — so this screen reports it as fact, reading `/internal/sandbox/status`
 * for the values the runner actually enforces. A role without oversight gets a
 * 403 there; that renders as "available to administrators", still stating what
 * the sandbox does, rather than as an error.
 *
 * Generation and execution themselves happen as a task: the composer here hands
 * off to the Workbench with `task_type: "coding"`, where the plan, the code,
 * its stdout/stderr and any artifact appear in the thread. A sandbox that could
 * not start is shown there distinctly from code that ran and failed — they mean
 * different things.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Ban, HardDriveDownload, Loader2, ShieldCheck, Timer } from "lucide-react";
import { ApiError, describeError } from "@/lib/api";
import { useCreateConversation, useCreateTask, useSandboxStatus } from "@/lib/queries";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ErrorState } from "@/components/states/ErrorState";
import { CodeExecution } from "@/components/workbench/CodeExecution";
import { Citations, Outputs } from "@/components/workbench/Sources";
import { api } from "@/lib/api";
import {
  emptyPipeline,
  mergeExecution,
  type PipelineState,
  type TaskExecution,
} from "@/lib/pipeline";
import { formatRelative } from "@/lib/format";
import type { Page, SandboxStatus, Task } from "@/lib/types";

export function Coding() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const openConversationId = params.get("conversation");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createConversation = useCreateConversation();
  const createTask = useCreateTask();
  const busy = createConversation.isPending || createTask.isPending;

  async function run(event: FormEvent) {
    event.preventDefault();
    const request = text.trim();
    if (!request || busy) return;
    setError(null);
    try {
      const conversation = await createConversation.mutateAsync(
        request.split(/\s+/).slice(0, 6).join(" ") || "Coding task",
      );
      const task = await createTask.mutateAsync({
        conversation_id: conversation.id,
        request_text: request,
        task_type: "coding",
      });
      navigate(`/workbench?task=${task.task_id}`);
    } catch (caught) {
      setError(describeError(caught).detail);
    }
  }

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Coding workspace</h2>
        <div className="sub">
          Generated code runs in a container with no network and an isolated
          filesystem. Everything below is what the runner enforces, not what it
          aims for.
        </div>
      </div>

      <SandboxPanel />

      {openConversationId && <CodingTranscript conversationId={openConversationId} />}

      <form onSubmit={run} className="mt-6">
        <div className="card" style={{ padding: "14px" }}>
          <span className="field-label" style={{ margin: 0 }}>
            Describe the coding task
          </span>
          <textarea
            className="textarea mono"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Parse the attached CSV, compute the rolling 7-day mean per tag, and flag any point more than 3σ from it."
            style={{ marginTop: "6px", fontSize: "13px" }}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="hint">
              The live run streams in the Workbench — the plan, the code, its
              output and any artifact appear in the thread. The session is
              filed here, under Coding sessions.
            </span>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={busy || !text.trim()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Start coding task
            </button>
          </div>
        </div>
        {error && (
          <p className="error-note" style={{ marginTop: "10px" }}>
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * A past coding session, reopened from the history list.
 *
 * Rebuilt from the tasks it produced rather than from the event stream: the
 * stream's backlog is held in memory and is gone after a restart, while the
 * tasks and their execution records are kept. What matters when someone comes
 * back to a script is what was asked, what the sandbox printed, and whether
 * anything came out of it -- so that is what this shows.
 */
function CodingTranscript({ conversationId }: { conversationId: string }) {
  const [runs, setRuns] = useState<
    Array<{ task: Task; pipeline: PipelineState }> | null
  >(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRuns(null);
    setFailed(false);

    (async () => {
      try {
        // No server-side filter by conversation, so a recent page is narrowed
        // here.
        const page = await api.get<Page<Task>>("/api/v1/tasks?limit=100");
        const mine = page.items
          .filter((task) => task.conversation_id === conversationId)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));

        const rebuilt = await Promise.all(
          mine.map(async (task) => {
            const execution = await api
              .get<TaskExecution>(`/api/v1/tasks/${task.task_id}/execution`)
              .catch(() => null);
            const pipeline = execution
              ? mergeExecution(emptyPipeline(), execution)
              : emptyPipeline();
            return { task, pipeline };
          }),
        );
        if (!cancelled) setRuns(rebuilt);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (failed) {
    return (
      <p className="hint" style={{ marginTop: "18px" }}>
        This session could not be loaded.
      </p>
    );
  }

  if (runs === null) {
    return <p className="loading-note">Loading the session…</p>;
  }

  if (runs.length === 0) {
    return (
      <p className="hint" style={{ marginTop: "18px" }}>
        This session has no runs yet. Describe a task below to start one.
      </p>
    );
  }

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between">
        <h3 className="section-title">Session</h3>
        <Link to="/coding" className="text-[12px]" style={{ color: "var(--text-mute)" }}>
          Start a new one
        </Link>
      </div>

      <div className="mt-3 space-y-3">
        {runs.map(({ task, pipeline }) => (
          <div key={task.task_id} className="card">
            <p className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
              {formatRelative(task.created_at)} &middot;{" "}
              <Link
                to={`/tasks/${task.task_id}`}
                style={{ color: "var(--accent-bright)" }}
              >
                {task.status}
              </Link>
            </p>
            <p className="mt-1.5 text-[13px] text-primary">{task.request_text}</p>

            {task.error_message && (
              <div className="risk-callout danger mt-2">{task.error_message}</div>
            )}

            {pipeline.sandboxFailed ? (
              <div className="risk-callout danger mt-2">
                The sandbox could not run the code — it did not execute.
                {pipeline.sandboxDetail ? ` ${pipeline.sandboxDetail}` : ""}
              </div>
            ) : pipeline.codeRun ? (
              <CodeExecution run={pipeline.codeRun} />
            ) : null}

            <Citations items={pipeline.citations} />
            <Outputs items={pipeline.artifacts} />
          </div>
        ))}
      </div>
    </section>
  );
}

function SandboxPanel() {
  const { data, isLoading, isError, error, refetch } = useSandboxStatus({
    retry: false,
  });

  const forbidden = error instanceof ApiError && error.status === 403;

  if (isError && !forbidden) {
    return <ErrorState error={error} onRetry={() => refetch()} />;
  }

  const s: SandboxStatus = data ?? {};
  const confinement = s.confinement ?? {};

  // The runner reports these; they are not this screen's claims to make. When
  // the role cannot read them, the panel says so rather than substituting a
  // plausible-looking default, because the whole point of the panel is that
  // the values are measured.
  const network = confinement.network;
  const netBlocked = network === undefined || /none|blocked/i.test(network);

  // `available: false` means the runner did not answer at all. Code cannot run,
  // and that is the first thing an operator needs to know -- it must not be
  // buried under a green confinement grid.
  const unavailable = data !== undefined && s.available === false;

  return (
    <div className="card mt-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-accent" aria-hidden />
        <span className="section-title">Sandbox confinement</span>
        {forbidden && (
          <span className="pill" style={{ marginLeft: "auto" }}>
            values available to administrators
          </span>
        )}
        {!forbidden && data && (
          <span
            className={"pill" + (unavailable ? " danger" : " ok")}
            style={{ marginLeft: "auto" }}
          >
            {s.runner ?? "runner"} {unavailable ? "unreachable" : "ready"}
          </span>
        )}
      </div>

      {unavailable && (
        <p className="risk-callout danger" style={{ marginTop: "10px" }}>
          The {s.runner ?? "sandbox"} runner is not reachable, so no code can be
          executed on this deployment.
          {s.detail ? ` ${s.detail}` : ""}
        </p>
      )}

      {isLoading ? (
        <p className="loading-note">Reading the runner…</p>
      ) : (
        <div className="mt-3 stat-grid">
          <Fact
            Icon={Ban}
            label="Network interface"
            value={network ? network.toUpperCase() : "NONE"}
            tone={netBlocked ? "var(--ok-text)" : "var(--danger-text)"}
          />
          <Fact
            Icon={HardDriveDownload}
            label="Root filesystem"
            value={confinement.root_filesystem ?? "read-only"}
            tone="var(--ok-text)"
          />
          <Fact
            Icon={Timer}
            label="Workspace"
            value={confinement.workspace ?? "discarded after the run"}
            tone="var(--text)"
          />
          <Fact
            Icon={ShieldCheck}
            label="Privileges"
            value={
              [confinement.capabilities, confinement.user]
                .filter(Boolean)
                .join(" · ") || "all dropped"
            }
            tone="var(--text)"
          />
        </div>
      )}

      {!forbidden && s.image && (
        <p className="hint" style={{ marginTop: "10px" }}>
          Image <span className="mono">{s.image}</span>.
        </p>
      )}

      {forbidden && (
        <p className="hint" style={{ marginTop: "10px" }}>
          Your role cannot read the runner's live figures. The confinement above
          is what the sandbox is built to enforce on every deployment.
        </p>
      )}
    </div>
  );
}

function Fact({
  Icon,
  label,
  value,
  tone,
}: {
  Icon: typeof ShieldCheck;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="stat">
      <Icon className="size-4" style={{ color: "var(--text-mute)" }} aria-hidden />
      <div className="s-label" style={{ marginTop: "8px" }}>
        {label}
      </div>
      <div className="s-value mono" style={{ color: tone, fontSize: "15px" }}>
        {value}
      </div>
    </div>
  );
}
