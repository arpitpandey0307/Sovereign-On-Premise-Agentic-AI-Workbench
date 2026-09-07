/**
 * The dashboard — the landing pad after sign-in.
 *
 * The thing that matters is the task input: a large field whose placeholder
 * doubles as a worked example of what the product can do. Submitting it creates
 * the task and goes straight to the Workbench with the stream already
 * attaching. Below it: quick actions that prefill the field, the recent-task
 * list, and a system-status panel showing real data rather than six dashes.
 */

import { Suspense, lazy } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  Cpu,
  FlaskConical,
  HardDrive,
  ShieldCheck,
} from "lucide-react";

const ActivityCharts = lazy(() =>
  import("@/components/dashboard/ActivityCharts").then((m) => ({
    default: m.ActivityCharts,
  })),
);
import { greeting, formatRelative } from "@/lib/format";
import { useAuth, useRole } from "@/lib/auth";
import {
  useKnowledgeStatus,
  useModelHealth,
  useSystemStatus,
  useTasks,
} from "@/lib/queries";
import { TaskStatusPill } from "@/components/ui/StatusPill";
import { Table, type Column } from "@/components/ui/Table";
import { ErrorState } from "@/components/states/ErrorState";
import type { Task } from "@/lib/types";


export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const recent = useTasks({ limit: 8 });

  const columns: Column<Task>[] = [
    {
      key: "request",
      header: "Task",
      cell: (task) => (
        <Link to={`/tasks/${task.task_id}`} className="text-accent-text hover:underline">
          {task.request_text.length > 80
            ? `${task.request_text.slice(0, 80)}…`
            : task.request_text}
        </Link>
      ),
    },
    { key: "type", header: "Type", cell: (task) => task.task_type || "—" },
    { key: "status", header: "Status", cell: (task) => <TaskStatusPill status={task.status} /> },
    {
      key: "created",
      header: "Created",
      cell: (task) => formatRelative(task.created_at),
      numeric: true,
    },
  ];

  return (
    <div className="view-pad">
      <h1 className="text-[22px] font-semibold tracking-tight text-primary">
        {greeting()}, {user?.name?.split(" ")[0] ?? "there"}
      </h1>
      <p className="mt-1 text-[13px]" style={{ color: "var(--text-dim)" }}>
        Your recent work, and the state of the machine it ran on.
      </p>

      {/* The place to start a task is the workbench, which is where the
          attachments, the effort control and the thread already are. A second
          composer here meant two half-featured entry points instead of one
          complete one. */}
      <div className="mt-5">
        <Link to="/workbench" className="btn btn-accent">
          <FlaskConical className="size-4" aria-hidden />
          Open the AI Workbench
        </Link>
      </div>

      <h2 className="mt-8 section-title">Recent tasks</h2>
      <div className="mt-3">
        {recent.isError ? (
          <ErrorState error={recent.error} onRetry={() => recent.refetch()} />
        ) : (
          <Table
            columns={columns}
            rows={recent.data?.items ?? []}
            rowKey={(task) => task.task_id}
            loading={recent.isLoading}
            empty="No tasks yet. Start one in the AI Workbench."
            onRowClick={(task) => navigate(`/tasks/${task.task_id}`)}
          />
        )}
      </div>

      {/* What the machine is actually doing, from the task list and the
          receipts. Lazily loaded: the charting library is the second-heaviest
          thing in the app and only two screens use it. */}
      <h2 className="mt-8 section-title">Activity</h2>
      <Suspense fallback={<p className="loading-note">Reading activity…</p>}>
        <ActivityCharts />
      </Suspense>

      <h2 className="mt-8 section-title">System status</h2>
      <SystemStatusPanel />
    </div>
  );
}

/**
 * Read the first present numeric field, for the loosely-typed /internal bags.
 *
 * A key may be a dotted path: the knowledge status nests its counts under
 * `corpus`, and looking only at the top level found nothing, so the two
 * knowledge figures never appeared.
 */
function pluckNumber(
  bag: Record<string, unknown> | undefined,
  keys: string[],
): number | null {
  if (!bag) return null;
  for (const key of keys) {
    let value: unknown = bag;
    for (const segment of key.split(".")) {
      if (value === null || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[segment];
    }
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

/** How many models the runtime actually has resident, if it says. */
function residentModels(bag: Record<string, unknown> | undefined): number | null {
  if (!bag) return null;
  const resident = bag.resident_models;
  if (Array.isArray(resident)) return resident.length;
  return pluckNumber(bag, ["loaded", "models_loaded", "ready"]);
}

function SystemStatusPanel() {
  const { isOversight } = useRole();
  // `/api/v1/system/status` needs `system:read`, which only the oversight roles
  // hold. Asking for it as an engineer is a request that can only ever be
  // refused, and the panel then renders a permission error on the busiest
  // screen in the product. Say what the screen is instead of failing at it.
  const { data, isLoading, isError, error, refetch } = useSystemStatus({
    enabled: isOversight,
    retry: false,
  });
  const modelHealth = useModelHealth({ enabled: isOversight, retry: false });
  const knowledge = useKnowledgeStatus({ enabled: isOversight, retry: false });

  if (!isOversight) {
    return (
      <p className="hint" style={{ marginTop: "10px" }}>
        System status is reported to administrators and security
        administrators. Your work is unaffected by what it shows.
      </p>
    );
  }

  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (isLoading || !data) {
    return <p className="loading-note">Reading system status…</p>;
  }

  const liveParts = Object.values(data.parts).filter((v) => v === "live").length;
  const stubbed = Object.entries(data.parts)
    .filter(([, state]) => state !== "live")
    .map(([name]) => name);

  const loadedModels = residentModels(modelHealth.data);
  // The counts live under `corpus` on the real response.
  const indexedDocs = pluckNumber(knowledge.data, [
    "corpus.documents",
    "documents",
    "document_count",
    "docs",
  ]);
  const chunks = pluckNumber(knowledge.data, [
    "corpus.chunks",
    "chunks",
    "chunk_count",
  ]);

  return (
    <div className="mt-3 stat-grid">
      <Metric
        Icon={Cpu}
        label="Model runtime"
        value={data.model_runtime.reachable ? "Reachable" : "Unreachable"}
        detail={data.model_runtime.detail}
        tone={data.model_runtime.reachable ? "var(--ok-text)" : "var(--danger-text)"}
      />
      <Metric
        Icon={HardDrive}
        label="Object storage"
        value={data.object_storage}
        detail="Backend in use"
        tone="var(--accent-bright)"
      />
      <Metric
        Icon={ShieldCheck}
        label="External network"
        value={data.external_network_allowed ? "Allowed" : "Blocked"}
        detail="Sovereignty policy"
        tone={data.external_network_allowed ? "var(--danger-text)" : "var(--ok-text)"}
      />
      <Metric
        Icon={Activity}
        label="Backend parts"
        value={`${liveParts}/${Object.keys(data.parts).length} live`}
        detail={stubbed.length ? `stub: ${stubbed.join(", ")}` : "all installed"}
        tone={stubbed.length ? "var(--warn-text)" : "var(--ok-text)"}
      />

      {loadedModels != null && (
        <Metric
          Icon={Cpu}
          label="Models loaded"
          value={String(loadedModels)}
          detail="On the local runtime"
          tone="var(--text)"
        />
      )}
      {indexedDocs != null && (
        <Metric
          Icon={HardDrive}
          label="Knowledge"
          value={`${indexedDocs} docs`}
          detail={chunks != null ? `${chunks} chunks indexed` : "indexed"}
          tone="var(--text)"
        />
      )}
    </div>
  );
}

function Metric({
  Icon,
  label,
  value,
  detail,
  tone,
}: {
  Icon: typeof Cpu;
  label: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <div className="stat">
      <Icon className="size-4" style={{ color: "var(--text-mute)" }} aria-hidden />
      <div className="s-label" style={{ marginTop: "8px" }}>
        {label}
      </div>
      <div className="s-value mono" style={{ color: tone, fontSize: "16px" }}>
        {value}
      </div>
      <div className="s-sub">{detail}</div>
    </div>
  );
}
