/**
 * The task list.
 *
 * A compact table rather than a grid of cards — this is an instrument panel,
 * and an engineer should see the state of their work without scrolling.
 * Filterable by status; the row opens the forensic trace.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatRelative } from "@/lib/format";
import { useTasks } from "@/lib/queries";
import type { Task, TaskStatus } from "@/lib/types";
import { TaskStatusPill } from "@/components/ui/StatusPill";
import { Table, type Column } from "@/components/ui/Table";
import { ErrorState } from "@/components/states/ErrorState";

const FILTERS: Array<{ value: TaskStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "waiting_approval", label: "Needs approval" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export function Tasks() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<TaskStatus | "all">("all");

  const { data, isLoading, isError, error, refetch } = useTasks({
    status: status === "all" ? undefined : status,
    limit: 50,
  });

  const columns: Column<Task>[] = [
    {
      key: "request",
      header: "Task",
      cell: (task) =>
        task.request_text.length > 90
          ? `${task.request_text.slice(0, 90)}…`
          : task.request_text,
    },
    { key: "type", header: "Type", cell: (task) => task.task_type || "—" },
    {
      key: "status",
      header: "Status",
      cell: (task) => <TaskStatusPill status={task.status} />,
    },
    {
      key: "created",
      header: "Created",
      cell: (task) => formatRelative(task.created_at),
      numeric: true,
    },
  ];

  return (
    <div className="view-pad">
      <div className="view-head">
        <h2>Tasks</h2>
        <div className="sub">Everything you have asked the workbench to do.</div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            className={
              "btn btn-sm" + (status === filter.value ? " btn-accent" : "")
            }
            onClick={() => setStatus(filter.value)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <Table
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(task) => task.task_id}
          loading={isLoading}
          empty={
            status === "all"
              ? "No tasks yet. Start one from the dashboard or the workbench."
              : "No tasks with this status."
          }
          onRowClick={(task) => navigate(`/tasks/${task.task_id}`)}
        />
      )}
    </div>
  );
}
