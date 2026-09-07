import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, Cpu } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { keys, useTasks } from "@/lib/queries";
import type { Task, TaskReceipt } from "@/lib/types";

/**
 * What the workbench has actually been doing.
 *
 * Two questions an operator asks at a glance: which models are being called,
 * and how much work is going through. Both are answered from records the
 * backend already keeps — the task list, and each task's receipt, which is
 * where `models_used` is written as the run happens.
 *
 * It refreshes on a timer rather than a socket. There is no push channel for
 * aggregate activity, and inventing one for a chart would be the wrong trade;
 * a fifteen-second refresh is live enough for a screen nobody stares at.
 *
 * Every chart has its numbers written beside it. A chart is a summary, and on
 * a system where the point is that you can check the claim, the figure has to
 * be readable without measuring a bar against an axis.
 */

/** Recharts reads CSS variables poorly, so the palette is resolved once. */
function token(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

const STATUS_ORDER = [
  "completed",
  "running",
  "planning",
  "waiting_approval",
  "pending",
  "failed",
  "cancelled",
] as const;

export function ActivityCharts() {
  // Refetched on a timer: this is a live picture of a shared machine.
  const tasks = useTasks({ limit: 100 }, { refetchInterval: 15_000 });

  const items = useMemo(() => tasks.data?.items ?? [], [tasks.data]);

  // Which model each finished task used. The receipt is the only place that
  // records it, so one request per completed task -- capped, because a
  // dashboard must not fire a hundred requests to draw a bar chart.
  const finished = useMemo(
    () => items.filter((task) => task.status === "completed").slice(0, 25),
    [items],
  );

  const receipts = useQueries({
    queries: finished.map((task) => ({
      queryKey: [...keys.task(task.task_id), "receipt"],
      queryFn: () => api.get<TaskReceipt>(`/api/v1/tasks/${task.task_id}/receipt`),
      staleTime: 60_000,
      retry: false,
    })),
  });

  const models = useMemo(() => {
    const counts = new Map<string, number>();
    for (const query of receipts) {
      for (const model of query.data?.models_used ?? []) {
        counts.set(model, (counts.get(model) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls);
  }, [receipts]);

  const statuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of items) {
      counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    }
    return STATUS_ORDER.filter((status) => counts.has(status)).map((status) => ({
      name: status.replace(/_/g, " "),
      status,
      tasks: counts.get(status) ?? 0,
    }));
  }, [items]);

  const accent = token("--accent", "#3b82f6");
  const ok = token("--ok-text", "#4ade80");
  const danger = token("--danger-text", "#f87171");
  const warn = token("--warn-text", "#fbbf24");
  const grid = token("--border", "#2a2e35");
  const faint = token("--text-faint", "#6b7280");

  const colourFor = (status: string) =>
    status === "completed"
      ? ok
      : status === "failed" || status === "cancelled"
        ? danger
        : status === "waiting_approval"
          ? warn
          : accent;

  if (tasks.isLoading) {
    return <p className="loading-note">Reading activity…</p>;
  }

  if (items.length === 0) {
    return (
      <p className="hint" style={{ marginTop: "10px" }}>
        No tasks yet. Run something in the workbench and the activity appears
        here.
      </p>
    );
  }

  const axis = { stroke: faint, fontSize: 11, fontFamily: "var(--font-mono)" };

  return (
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      {/* --- model calls --- */}
      <div className="card">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-accent" aria-hidden />
          <span className="section-title">Models being called</span>
        </div>

        {models.length === 0 ? (
          <p className="hint" style={{ marginTop: "10px" }}>
            {receipts.some((query) => query.isLoading)
              ? "Reading receipts…"
              : "No completed run has recorded a model yet."}
          </p>
        ) : (
          <>
            <div style={{ height: 190, marginTop: "10px" }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={models}
                  layout="vertical"
                  margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
                >
                  <CartesianGrid horizontal={false} stroke={grid} />
                  <XAxis type="number" allowDecimals={false} {...axis} />
                  <YAxis type="category" dataKey="name" width={140} {...axis} />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,.04)" }}
                    contentStyle={{
                      background: "var(--panel-2)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="calls" fill={accent} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* The same figures, readable without the chart. */}
            <ul className="mt-2 space-y-1">
              {models.map((model) => (
                <li
                  key={model.name}
                  className="mono flex items-center justify-between text-[11.5px]"
                  style={{ color: "var(--text-mute)" }}
                >
                  <span className="truncate">{model.name}</span>
                  <span style={{ color: "var(--text-dim)" }}>
                    {model.calls} call{model.calls === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* --- task activity --- */}
      <div className="card">
        <div className="flex items-center gap-2">
          <Activity className="size-4 text-accent" aria-hidden />
          <span className="section-title">Task activity</span>
          <span className="pill" style={{ marginLeft: "auto", fontSize: "10px" }}>
            {items.length} recent
          </span>
        </div>

        <div style={{ height: 190, marginTop: "10px" }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={statuses}
              margin={{ top: 4, right: 8, bottom: 4, left: -14 }}
            >
              <CartesianGrid vertical={false} stroke={grid} />
              <XAxis dataKey="name" {...axis} interval={0} angle={-18} dy={8} height={44} />
              <YAxis allowDecimals={false} {...axis} />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,.04)" }}
                contentStyle={{
                  background: "var(--panel-2)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Bar dataKey="tasks" radius={[4, 4, 0, 0]}>
                {statuses.map((entry) => (
                  <Cell key={entry.status} fill={colourFor(entry.status)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {statuses.map((entry) => (
            <li
              key={entry.status}
              className="mono text-[11.5px]"
              style={{ color: "var(--text-mute)" }}
            >
              <span style={{ color: colourFor(entry.status) }}>●</span> {entry.name}{" "}
              <span style={{ color: "var(--text-dim)" }}>{entry.tasks}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Everything a dashboard needs to say about how busy the machine is. */
export function activitySummary(items: Task[]) {
  return {
    total: items.length,
    running: items.filter((task) =>
      ["running", "planning", "pending"].includes(task.status),
    ).length,
  };
}
