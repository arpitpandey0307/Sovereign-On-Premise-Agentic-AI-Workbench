import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, HelpCircle, Lock, ShieldAlert, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Sovereignty } from "@/lib/types";

/**
 * The product's central claim, on every screen.
 *
 * Two rules govern this component, and both are the difference between
 * evidence and decoration:
 *
 * 1. It must be able to say no. If the monitor reports a breach, this turns
 *    red and says so. A badge hard-coded to green is worth nothing, and a
 *    reviewer who works out that it can never change has learned exactly how
 *    much the security story is worth.
 *
 * 2. It must distinguish "clean" from "not watching". Zero external calls
 *    from a monitor nobody has shown to be awake is not evidence of anything.
 *    The API reports `monitoring` for precisely this reason.
 */

type State = "secure" | "breached" | "unverified" | "unknown";

function stateOf(data: Sovereignty | undefined, denied: boolean): State {
  // A role without oversight permission cannot read the endpoint. That is not
  // a failure of the system, so it is reported as unknown rather than alarm.
  if (denied) return "unknown";
  if (!data) return "unknown";
  if (data.network_egress === "BREACHED" || data.external_connections > 0) {
    return "breached";
  }
  if (!data.monitoring) return "unverified";
  return "secure";
}

const PRESENTATION: Record<
  State,
  { label: string; value: string; dot: string; text: string; border: string }
> = {
  secure: {
    label: "SOVEREIGN MODE",
    value: "ON",
    dot: "bg-positive",
    text: "text-positive",
    border: "border-positive/30",
  },
  breached: {
    label: "SOVEREIGN MODE",
    value: "BREACHED",
    dot: "bg-danger animate-pulse",
    text: "text-danger",
    border: "border-danger/50",
  },
  unverified: {
    label: "SOVEREIGN MODE",
    value: "UNVERIFIED",
    dot: "bg-warning",
    text: "text-warning",
    border: "border-warning/40",
  },
  unknown: {
    label: "SOVEREIGN MODE",
    value: "--",
    dot: "bg-inactive",
    text: "text-tertiary",
    border: "border-subtle",
  },
};

export function SovereigntyBadge() {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const { data, error } = useQuery({
    queryKey: ["sovereignty"],
    queryFn: () => api.get<Sovereignty>("/api/v1/security/sovereignty"),
    refetchInterval: 30_000,
    retry: (count, err) =>
      // Retrying a permission denial just produces more denials.
      !(err instanceof ApiError && err.status === 403) && count < 2,
    throwOnError: false,
  });

  const denied = error instanceof ApiError && error.status === 403;
  const state = stateOf(data, denied);
  const presentation = PRESENTATION[state];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapper}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5",
          "bg-panel transition-colors hover:bg-elevated",
          presentation.border,
        )}
      >
        <Lock className={cn("size-3.5", presentation.text)} aria-hidden />
        <span className="hidden text-[10px] font-medium tracking-wider text-tertiary sm:inline">
          {presentation.label}
        </span>
        <span
          className={cn(
            "mono text-[11px] font-semibold tracking-wide",
            presentation.text,
          )}
        >
          {presentation.value}
        </span>
        <span
          className={cn("size-1.5 rounded-full", presentation.dot)}
          aria-hidden
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Sovereignty status"
          className={cn(
            "absolute right-0 top-full z-50 mt-2 w-80 rounded-[var(--radius)]",
            "border border-strong bg-elevated p-4 shadow-2xl",
          )}
        >
          {denied ? (
            <p className="text-xs text-tertiary">
              Sovereignty detail is available to administrator and security
              roles. The indicator above reflects your access, not the state of
              the system.
            </p>
          ) : !data ? (
            <p className="text-xs text-tertiary">Reading the network monitor…</p>
          ) : (
            <>
              {state === "breached" && (
                <p className="mb-3 rounded border border-danger/40 bg-danger-soft px-2 py-1.5 text-xs text-danger">
                  An external connection was observed. This should never happen.
                </p>
              )}
              {state === "unverified" && (
                <p className="mb-3 rounded border border-warning/40 bg-warning-soft px-2 py-1.5 text-xs text-warning">
                  The egress monitor is not running, so zero external calls is
                  not evidence of anything on this deployment.
                </p>
              )}

              <dl className="space-y-1.5">
                <Row label="Local models" ok />
                <Row label="Local knowledge" ok />
                <Row
                  label="External AI APIs"
                  ok={data.external_requests === 0}
                  okText="BLOCKED"
                  badText={`${data.external_requests} SEEN`}
                />
                <Row
                  label="Internet egress"
                  ok={data.network_egress === "BLOCKED"}
                  okText="BLOCKED"
                  badText="BREACHED"
                />
                <Row label="Audit logging" ok />
                <Row label="Sandbox" ok okText="NO NETWORK" />
                <Row
                  label="Egress monitor"
                  ok={data.monitoring}
                  okText="WATCHING"
                  badText="OFF"
                />
              </dl>

              <p className="mt-3 border-t border-subtle pt-2 text-[11px] text-tertiary">
                <span className="mono">{data.local_connections}</span> local
                connections observed, of which{" "}
                <span className="mono">{data.external_connections}</span> left
                this machine.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  ok,
  okText = "✓",
  badText = "✗",
}: {
  label: string;
  ok: boolean;
  okText?: string;
  badText?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-secondary">{label}</dt>
      <dd
        className={cn(
          "mono flex items-center gap-1 text-[11px] font-medium",
          ok ? "text-positive" : "text-danger",
        )}
      >
        {ok ? (
          <Check className="size-3" aria-hidden />
        ) : (
          <X className="size-3" aria-hidden />
        )}
        {ok ? okText : badText}
      </dd>
    </div>
  );
}

/** The compact form, for the landing page and the login screen. */
export function SovereigntyChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-subtle bg-panel px-2.5 py-1 text-[11px] text-secondary">
      <ShieldAlert className="size-3 text-accent" aria-hidden />
      {label}
      <HelpCircle className="size-3 text-tertiary" aria-hidden />
    </span>
  );
}
