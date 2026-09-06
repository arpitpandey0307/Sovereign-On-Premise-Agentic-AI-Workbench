import { useQuery } from "@tanstack/react-query";
import { Activity, Cpu, HardDrive, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { greeting } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { LoadingState } from "@/components/states/LoadingState";
import type { SystemStatus } from "@/lib/types";

/**
 * A minimal dashboard for Part 01.
 *
 * The full screen -- task composer, quick actions, recent tasks -- belongs to
 * Part 03. What is here now proves the shell, the API client and the query
 * layer work end to end against the real backend.
 */
export function Dashboard() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["system-status"],
    queryFn: () => api.get<SystemStatus>("/api/v1/system/status"),
    retry: false,
  });

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {greeting()}, {user?.name?.split(" ")[0] ?? "there"}
      </h1>
      <p className="mt-1 text-sm text-secondary">
        What would you like to accomplish today?
      </p>

      <Card className="mt-6 p-4">
        <p className="text-xs text-tertiary">
          The task composer, quick actions and recent tasks arrive with the AI
          Workbench in Part 03.
        </p>
      </Card>

      <h2 className="mt-8 text-sm font-semibold text-primary">System status</h2>
      {isLoading ? (
        <LoadingState rows={2} />
      ) : data ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            Icon={Cpu}
            label="Model runtime"
            value={data.model_runtime.reachable ? "Reachable" : "Unreachable"}
            detail={data.model_runtime.detail}
            tone={data.model_runtime.reachable ? "positive" : "danger"}
          />
          <Metric
            Icon={HardDrive}
            label="Object storage"
            value={data.object_storage}
            detail="Backend actually in use"
            tone="info"
          />
          <Metric
            Icon={ShieldCheck}
            label="External network"
            value={data.external_network_allowed ? "Allowed" : "Blocked"}
            detail="Sovereignty policy"
            tone={data.external_network_allowed ? "danger" : "positive"}
          />
          <Metric
            Icon={Activity}
            label="Backend parts"
            value={`${Object.values(data.parts).filter((v) => v === "live").length}/${Object.keys(data.parts).length} live`}
            // A part reading "stub" means it failed to install at startup --
            // the single most useful diagnostic the system has.
            detail={
              Object.entries(data.parts)
                .filter(([, state]) => state !== "live")
                .map(([name]) => name)
                .join(", ") || "all installed"
            }
            tone={
              Object.values(data.parts).every((v) => v === "live")
                ? "positive"
                : "warning"
            }
          />
        </div>
      ) : (
        <Card className="mt-3 p-4">
          <p className="text-xs text-tertiary">
            System status is available to administrator and security roles.
          </p>
        </Card>
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
  tone: "positive" | "info" | "warning" | "danger";
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <Icon className="size-4 text-tertiary" aria-hidden />
        <StatusPill tone={tone}>{value}</StatusPill>
      </div>
      <p className="mt-3 text-xs font-medium text-primary">{label}</p>
      <p className="mt-0.5 text-[11px] text-tertiary">{detail}</p>
    </Card>
  );
}
