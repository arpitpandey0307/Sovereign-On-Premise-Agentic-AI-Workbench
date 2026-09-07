/**
 * The Security & Sovereignty Center.
 *
 * Admin and security roles. Four areas: the sovereignty status (real counts,
 * red on a breach, unverified when the monitor is off), resource usage
 * (charts with their numbers beside them), the audit log (denials made
 * prominent — a ledger that only shows what succeeded is half a ledger), and
 * the policy in force, rendered as a read-only editor because policy lives in
 * configuration on this deployment, not a store.
 */

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertOctagon, Lock, ShieldCheck, ShieldX } from "lucide-react";
import { formatTimestamp } from "@/lib/format";
import { useRole } from "@/lib/auth";
import {
  useAudit,
  useModelHealth,
  useNetworkEvents,
  useSecurityStatus,
  useSovereignty,
} from "@/lib/queries";
import type {
  AuditEvent,
  Classification,
  PolicyRule,
  Role,
  Sovereignty,
} from "@/lib/types";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";

const DENIAL_EVENTS = new Set([
  "PERMISSION_DENIED",
  "TOOL_DENIED",
  "EXTERNAL_CALL_ATTEMPTED",
]);

export function Security() {
  const { isOversight } = useRole();

  if (!isOversight) {
    return (
      <div className="view-pad">
        <EmptyState
          icon={<Lock />}
          title="The Security Center is for oversight roles"
          description="It is available to administrators and security administrators. Your role does not hold security:read."
        />
      </div>
    );
  }

  return (
    <div className="view-pad" style={{ maxWidth: "1180px" }}>
      <div className="view-head">
        <h2>Security &amp; Sovereignty Center</h2>
        <div className="sub">
          The controls that make this product's central claim checkable, and the
          record of them working.
        </div>
      </div>

      <SovereigntyPanel />
      <ResourcePanel />
      <AuditPanel />
      <PolicyPanel />
    </div>
  );
}

// --- 2.1 Sovereignty ---------------------------------------------------------

function sovereignState(data: Sovereignty | undefined): "secure" | "breached" | "unverified" | "unknown" {
  if (!data) return "unknown";
  if (data.network_egress === "BREACHED" || data.external_connections > 0) return "breached";
  if (!data.monitoring) return "unverified";
  return "secure";
}

function SovereigntyPanel() {
  const sov = useSovereignty();
  const net = useNetworkEvents({ enabled: true });
  const state = sovereignState(sov.data);

  if (sov.isError) {
    return (
      <section className="mt-4">
        <ErrorState error={sov.error} onRetry={() => sov.refetch()} />
      </section>
    );
  }

  const d = sov.data;
  const breached = state === "breached";
  const events = net.data?.items ?? d?.recent_external ?? [];

  return (
    <section
      className={"sov mt-4" + (breached ? " breach" : "")}
      aria-label="Sovereignty status"
    >
      <div className="flex items-center gap-2">
        {breached ? (
          <ShieldX className="size-4" style={{ color: "var(--danger-text)" }} aria-hidden />
        ) : state === "unverified" ? (
          <AlertOctagon className="size-4" style={{ color: "var(--warn-text)" }} aria-hidden />
        ) : (
          <ShieldCheck className="size-4" style={{ color: "var(--ok-text)" }} aria-hidden />
        )}
        <span className="section-title">Sovereignty monitor</span>
        <span
          className={
            "pill " + (breached ? "danger" : state === "unverified" ? "warn" : "ok")
          }
          style={{ marginLeft: "auto" }}
        >
          {breached ? "BREACHED" : state === "unverified" ? "UNVERIFIED" : state === "secure" ? "SOVEREIGN MODE ON" : "—"}
        </span>
      </div>

      {state === "unverified" && (
        <p className="mt-2 text-[13px]" style={{ color: "var(--warn-text)" }}>
          The egress monitor is not running. Zero external calls from a monitor
          nobody has shown to be awake proves nothing.
        </p>
      )}
      {breached && (
        <p className="mt-2 text-[13px]" style={{ color: "var(--danger-text)" }}>
          An external connection was observed. This should never happen.
        </p>
      )}

      {d && (
        <div className="mt-4 stat-grid">
          <Count label="External AI calls" value={d.external_requests} bad={d.external_requests > 0} />
          <Count label="External connections" value={d.external_connections} bad={d.external_connections > 0} />
          <Count label="External DNS" value={d.external_dns_queries} bad={d.external_dns_queries > 0} />
          <Count label="Local model calls" value={d.local_connections} />
          <Count label="Network egress" value={d.network_egress} bad={d.network_egress === "BREACHED"} />
          <Count label="Egress monitor" value={d.monitoring ? "WATCHING" : "OFF"} bad={!d.monitoring} />
        </div>
      )}

      {events.length > 0 && (
        <div className="mt-4">
          <div className="field-label">Observed outbound attempts</div>
          <div className="table-wrap" style={{ marginTop: "6px" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Host</th>
                  <th>Port</th>
                  <th>Task</th>
                  <th>At</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, index) => (
                  <tr key={index}>
                    <td className="mono">{event.kind}</td>
                    <td className="mono">{event.host}</td>
                    <td className="mono">{event.port}</td>
                    <td className="mono">{event.task_id ?? "—"}</td>
                    <td className="mono">{formatTimestamp(event.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {d?.how_it_is_enforced && d.how_it_is_enforced.length > 0 && (
        <div className="mt-4">
          <div className="field-label">How it is enforced</div>
          <ul className="mt-1 space-y-1">
            {d.how_it_is_enforced.map((line, index) => (
              <li key={index} className="text-[12px]" style={{ color: "var(--text-dim)" }}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Count({
  label,
  value,
  bad,
}: {
  label: string;
  value: number | string;
  bad?: boolean;
}) {
  return (
    <div className="stat">
      <div className="s-label">{label}</div>
      <div
        className="s-value mono"
        style={{ color: bad ? "var(--danger-text)" : "var(--ok-text)", fontSize: "18px" }}
      >
        {value}
      </div>
    </div>
  );
}

// --- 2.2 Resource usage ----------------------------------------------------

const AXIS = { stroke: "var(--text-faint)", fontSize: 11 };

function ResourcePanel() {
  const health = useModelHealth();

  const vramSeries = useMemo(() => extractSeries(health.data, ["vram", "gpu", "memory"]), [health.data]);
  const modelStats = useMemo(() => extractModelStats(health.data), [health.data]);

  return (
    <section className="card mt-4">
      <span className="section-title">Resource usage</span>

      {health.isError ? (
        <p className="hint mt-2">
          Resource figures come from /internal/models/health, which your role may
          not read.
        </p>
      ) : health.isLoading ? (
        <p className="loading-note">Reading the runtime…</p>
      ) : (
        <div className="mt-3 grid gap-6 lg:grid-cols-2">
          <div>
            <div className="field-label">GPU VRAM over time (GB)</div>
            {vramSeries.length >= 2 ? (
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={vramSeries}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="t" {...AXIS} tickLine={false} />
                  <YAxis {...AXIS} tickLine={false} width={28} />
                  <Tooltip
                    contentStyle={{
                      background: "var(--panel-2)",
                      border: "1px solid var(--border-strong)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="var(--accent)"
                    fill="var(--accent-weak)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="hint">No time series in the response on this deployment.</p>
            )}
            {vramSeries.length > 0 && (
              <p className="mono mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
                {vramSeries.map((p) => `${p.t}: ${p.v}`).join("  ·  ")}
              </p>
            )}
          </div>

          <div>
            <div className="field-label">Per-model average latency (ms)</div>
            {modelStats.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={modelStats}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="model" {...AXIS} tickLine={false} />
                    <YAxis {...AXIS} tickLine={false} width={40} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--panel-2)",
                        border: "1px solid var(--border-strong)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="latency" fill="var(--accent)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <table className="data-table mt-1">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Latency</th>
                      <th>Success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelStats.map((m) => (
                      <tr key={m.model}>
                        <td className="mono">{m.model}</td>
                        <td className="mono">{m.latency} ms</td>
                        <td className="mono">
                          {m.success != null ? `${m.success}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="hint">No per-model statistics in the response.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Pull a {t,v} series out of a loosely-typed health payload, if one is there. */
function extractSeries(
  data: Record<string, unknown> | undefined,
  keys: string[],
): Array<{ t: string; v: number }> {
  if (!data) return [];
  for (const key of Object.keys(data)) {
    if (!keys.some((k) => key.toLowerCase().includes(k))) continue;
    const value = data[key];
    if (Array.isArray(value)) {
      const points = value
        .map((point, index) => {
          const p = (point ?? {}) as Record<string, unknown>;
          const v = Number(p.used ?? p.value ?? p.v ?? p.vram_used ?? point);
          const t = String(p.time ?? p.t ?? p.at ?? index);
          return Number.isFinite(v) ? { t: t.slice(11, 16) || t, v: Math.round(v * 10) / 10 } : null;
        })
        .filter((p): p is { t: string; v: number } => p !== null);
      if (points.length >= 2) return points;
    }
  }
  return [];
}

function extractModelStats(
  data: Record<string, unknown> | undefined,
): Array<{ model: string; latency: number; success: number | null }> {
  if (!data) return [];
  const models = data.models ?? data.model_stats ?? data.per_model;
  if (!Array.isArray(models)) return [];
  return models
    .map((entry) => {
      const m = (entry ?? {}) as Record<string, unknown>;
      const latency = Number(m.avg_latency_ms ?? m.latency_ms ?? m.latency);
      const success = Number(m.success_rate ?? m.success);
      return {
        model: String(m.model_id ?? m.name ?? m.model ?? "model"),
        latency: Number.isFinite(latency) ? Math.round(latency) : 0,
        success: Number.isFinite(success) ? Math.round(success <= 1 ? success * 100 : success) : null,
      };
    })
    .filter((m) => m.latency > 0);
}

// --- 2.3 Audit log -------------------------------------------------------------

function AuditPanel() {
  const [eventType, setEventType] = useState("");
  const [user, setUser] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const audit = useAudit({
    event_type: eventType || undefined,
    user: user || undefined,
    limit: 50,
  });

  // The filter menu comes from the response, so it can never list an event type
  // the ledger does not actually write.
  const types = audit.data?.known_event_types ?? [];

  return (
    <section className="card mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="section-title">Audit log</span>
        <select
          className="select"
          style={{ maxWidth: "220px", marginLeft: "auto" }}
          value={eventType}
          onChange={(event) => setEventType(event.target.value)}
        >
          <option value="">All event types</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <input
          className="input"
          style={{ maxWidth: "200px" }}
          placeholder="Filter by user"
          value={user}
          onChange={(event) => setUser(event.target.value)}
        />
      </div>

      {audit.isError ? (
        <div className="mt-3">
          <ErrorState error={audit.error} onRetry={() => audit.refetch()} />
        </div>
      ) : (
        <div className="table-wrap mt-3">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Event</th>
                <th>Component</th>
                <th>Action</th>
                <th>User</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody>
              {audit.isLoading && (
                <tr>
                  <td colSpan={6} className="loading-note">
                    Loading the ledger…
                  </td>
                </tr>
              )}
              {!audit.isLoading && (audit.data?.items.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--text-mute)" }}>
                    No entries for this filter.
                  </td>
                </tr>
              )}
              {(audit.data?.items ?? []).map((entry, index) => {
                // Ledger entries carry no id of their own, so the row is
                // identified by what does distinguish it. Keying on the absent
                // `id` made every row compare equal, which expanded all of
                // them at once.
                const rowKey = `${entry.timestamp}-${entry.event_type}-${index}`;
                return (
                  <AuditRow
                    key={rowKey}
                    entry={entry}
                    open={expanded === rowKey}
                    onToggle={() =>
                      setExpanded((current) => (current === rowKey ? null : rowKey))
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AuditRow({
  entry,
  open,
  onToggle,
}: {
  entry: AuditEvent;
  open: boolean;
  onToggle: () => void;
}) {
  const denial = DENIAL_EVENTS.has(entry.event_type);
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer"
        style={
          denial
            ? { background: "var(--danger-bg)", borderLeft: "3px solid var(--danger)" }
            : undefined
        }
      >
        <td className="mono">{formatTimestamp(entry.timestamp)}</td>
        <td>
          <span className={"pill " + (denial ? "danger" : "")}>{entry.event_type}</span>
        </td>
        <td className="mono">{entry.component}</td>
        <td>{entry.action}</td>
        <td className="mono">{entry.user_email ?? entry.user_id ?? "system"}</td>
        <td className="mono">{entry.task_id ?? "—"}</td>
      </tr>
      {open && entry.metadata && (
        <tr>
          <td colSpan={6}>
            <pre className="code-block">{JSON.stringify(entry.metadata, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

// --- 2.4 Policy (read-only) --------------------------------------------------

function PolicyPanel() {
  const status = useSecurityStatus();

  // `policy` and `roles` arrive keyed by name, not as arrays. The order of
  // classification levels is meaningful (least to most sensitive) and the API
  // states it in `classification_levels`, so it is used rather than the
  // arbitrary order of the object's own keys.
  const policy = status.data?.policy ?? {};
  const order = status.data?.classification_levels ?? [];
  const levels = (
    order.length > 0 ? order : (Object.keys(policy) as Classification[])
  )
    .map((level) => [level, policy[level]] as const)
    .filter((entry): entry is [Classification, PolicyRule] => Boolean(entry[1]));
  const roles = Object.entries(status.data?.roles ?? {}).filter(
    (entry): entry is [Role, { clearance: Classification | "none"; readable_classifications: Classification[] }] =>
      Boolean(entry[1]),
  );

  return (
    <section className="card mt-4">
      <span className="section-title">Policy in force</span>

      <p
        className="mt-2 flex items-start gap-2 rounded-[var(--radius)] px-3 py-2 text-[12.5px]"
        style={{
          background: "var(--warn-bg)",
          border: "1px solid var(--warn-line)",
          color: "var(--warn-text)",
        }}
      >
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Policy is defined in configuration on this deployment. Editing requires
        the policy service, which is not enabled here — the fields below are the
        live policy, shown read-only.
      </p>

      {status.isError ? (
        <div className="mt-3">
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        </div>
      ) : status.isLoading || !status.data ? (
        <p className="loading-note">Reading the policy…</p>
      ) : (
        <div className="mt-3 space-y-4">
          {levels.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Classification</th>
                    <th>Max tool risk</th>
                    <th>Approval required</th>
                    <th>Local models only</th>
                    <th>Restricted storage</th>
                  </tr>
                </thead>
                <tbody>
                  {levels.map(([level, rule]) => (
                    <tr key={level}>
                      <td className="mono">{level}</td>
                      <td className="mono">{rule.max_tool_risk ?? "—"}</td>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!rule.human_approval_required}
                          disabled
                          aria-label={`Approval required at ${level}`}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!rule.local_models_only}
                          disabled
                          aria-label={`Local models only at ${level}`}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={!!rule.restricted_artifact_storage}
                          disabled
                          aria-label={`Restricted artifact storage at ${level}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {roles.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Clearance</th>
                    <th>Readable classifications</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.map(([role, entry]) => (
                    <tr key={role}>
                      <td className="mono">{role}</td>
                      <td className="mono">{entry.clearance}</td>
                      <td className="mono">
                        {(entry.readable_classifications ?? []).join(", ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="hint">
            When the policy service lands it will need{" "}
            <span className="mono">GET/POST /api/v1/security/policies</span>,{" "}
            <span className="mono">PATCH</span> / <span className="mono">DELETE</span> per
            policy, and a <span className="mono">/simulate</span> to preview who a
            change would affect before it is saved.
          </p>
        </div>
      )}
    </section>
  );
}
