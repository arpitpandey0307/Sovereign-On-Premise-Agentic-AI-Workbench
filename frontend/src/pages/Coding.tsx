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

import { useState, type FormEvent } from "react";
import { Ban, HardDriveDownload, Loader2, ShieldCheck, Timer } from "lucide-react";
import { ApiError, describeError } from "@/lib/api";
import { useCreateConversation, useCreateTask, useSandboxStatus } from "@/lib/queries";
import { useNavigate } from "react-router-dom";
import { ErrorState } from "@/components/states/ErrorState";
import type { SandboxStatus } from "@/lib/types";

export function Coding() {
  const navigate = useNavigate();
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
              Opens in the Workbench — the plan, the code, its output and any
              artifact appear in the thread.
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
