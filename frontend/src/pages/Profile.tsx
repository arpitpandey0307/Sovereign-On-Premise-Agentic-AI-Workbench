/**
 * Profile.
 *
 * Built entirely from `/auth/me` and `/api/v1/security/permissions`. The access
 * section is split into granted and restricted on purpose: showing what a role
 * *cannot* do is how the boundary becomes legible, and this is the screen a
 * user comes to when something is refused elsewhere.
 *
 * The model-memory panel is designed but not wired — nothing in the backend
 * retains per-user context yet. It is shown as awaiting its service rather than
 * as an empty list, with the design constraints recorded for whoever builds it.
 */

import { useQuery } from "@tanstack/react-query";
import { Cpu, KeyRound, MonitorSmartphone, Trash2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { roleLabel, useAuth } from "@/lib/auth";

/** The capabilities a full working role holds, for the granted/restricted split. */
const CAPABILITIES: Array<{ perm: string; label: string }> = [
  { perm: "document:read", label: "Read cleared documents" },
  { perm: "document:search", label: "Search the knowledge base" },
  { perm: "file:upload", label: "Upload documents" },
  { perm: "task:create", label: "Run workbench tasks" },
  { perm: "task:read", label: "See task history and traces" },
  { perm: "artifact:download", label: "Download generated artifacts" },
  { perm: "model:read", label: "View the model registry" },
  { perm: "model:admin", label: "Administer models" },
  { perm: "audit:read", label: "Read the audit ledger" },
  { perm: "security:read", label: "Open the Security Center" },
  { perm: "system:read", label: "Read system status" },
];

function readWorkspace(): string | null {
  try {
    return localStorage.getItem("sovereign.workspace.skip");
  } catch {
    return null;
  }
}

export function Profile() {
  const { user, permissions, expiresAt, expiringSoon } = useAuth();
  const clearance = permissions?.clearance ?? "none";
  const readable = permissions?.readable_classifications ?? [];
  const granted = new Set(permissions?.permissions ?? []);

  const held = CAPABILITIES.filter((c) => granted.has(c.perm));
  const withheld = CAPABILITIES.filter((c) => !granted.has(c.perm));

  return (
    <div className="view-pad" style={{ maxWidth: "980px" }}>
      <div className="view-head">
        <h2>Profile</h2>
      </div>

      <div className="card">
        <div className="flex items-center gap-4">
          <div className="avatar" style={{ width: "48px", height: "48px", fontSize: "18px" }}>
            {(user?.name ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-primary">{user?.name}</p>
            <p className="mono text-[12px]" style={{ color: "var(--text-mute)" }}>
              {user?.email}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="pill accent">{roleLabel(user?.roles ?? [])}</span>
              <span className="pill">clearance {clearance}</span>
              {readWorkspace() && <span className="pill">workspace: {readWorkspace()}</span>}
            </div>
          </div>
        </div>
      </div>

      <h3 className="section-title mt-8">Access</h3>
      <p className="mt-1 text-[12px]" style={{ color: "var(--text-mute)" }}>
        Readable classifications: {readable.join(", ") || "none"}
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="card">
          <div className="field-label" style={{ color: "var(--ok-text)" }}>
            Granted
          </div>
          <ul className="mt-2 space-y-1.5">
            {held.map((c) => (
              <li key={c.perm} className="text-[13px]" style={{ color: "var(--text-dim)" }}>
                ✓ {c.label}
              </li>
            ))}
            {held.length === 0 && <li className="hint">No working permissions.</li>}
          </ul>
        </div>
        <div className="card">
          <div className="field-label" style={{ color: "var(--text-faint)" }}>
            Restricted
          </div>
          <ul className="mt-2 space-y-1.5">
            {withheld.map((c) => (
              <li key={c.perm} className="text-[13px]" style={{ color: "var(--text-faint)" }}>
                ✗ {c.label}
              </li>
            ))}
            {withheld.length === 0 && <li className="hint">Nothing withheld.</li>}
          </ul>
        </div>
      </div>

      <h3 className="section-title mt-8">Security</h3>
      <div className="mt-3 card">
        <div className="setting-row">
          <span className="k">
            <KeyRound className="mr-1.5 inline size-3.5" aria-hidden />
            Authentication
          </span>
          <span className="v mono">On-premise · local · no external IdP</span>
        </div>
        <div className="setting-row">
          <span className="k">
            <MonitorSmartphone className="mr-1.5 inline size-3.5" aria-hidden />
            Workstation
          </span>
          <span className="v mono">This browser session</span>
        </div>
        <div className="setting-row">
          <span className="k">Session</span>
          <span className="v mono">
            {expiresAt
              ? expiringSoon
                ? "expiring soon"
                : `active until ${expiresAt.toLocaleTimeString()}`
              : "active"}
          </span>
        </div>
      </div>

      <MemoryPanel />
    </div>
  );
}

function MemoryPanel() {
  const memory = useQuery({
    queryKey: ["user", "memory"],
    queryFn: () => api.get<{ items: unknown[] }>("/api/v1/users/me/memory"),
    retry: false,
    throwOnError: false,
  });

  const notImplemented =
    memory.isError && memory.error instanceof ApiError && [404, 501].includes(memory.error.status);

  return (
    <>
      <h3 className="section-title mt-8">Assistant memory</h3>
      <div className="mt-3 card">
        {notImplemented || (!memory.isLoading && !memory.data) ? (
          <>
            <p
              className="flex items-start gap-2 rounded-[var(--radius)] px-3 py-2 text-[12.5px]"
              style={{
                background: "var(--warn-bg)",
                border: "1px solid var(--warn-line)",
                color: "var(--warn-text)",
              }}
            >
              <Cpu className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              No memory service on this deployment. When one lands, this panel
              lists what the assistant has retained about how you work — each
              item removable, plus a clear-all.
            </p>
            <ul className="mt-3 space-y-1 text-[12px]" style={{ color: "var(--text-mute)" }}>
              <li>· Inspectable and deletable by you — no invisible store of inferred facts.</li>
              <li>· Per-user and never shared, so one person's context cannot leak into another's answers.</li>
              <li>· Respects clearance — a memory from a HIGHLY_CONFIDENTIAL document does not surface once that clearance no longer applies.</li>
              <li>· Preferences only ("prefers concise answers"), never document content.</li>
            </ul>
            <button type="button" className="btn btn-sm btn-danger mt-3" disabled>
              <Trash2 className="size-3.5" aria-hidden />
              Clear all memory
            </button>
          </>
        ) : memory.isLoading ? (
          <p className="loading-note">Reading memory…</p>
        ) : (
          <ul className="space-y-2">
            {(memory.data?.items ?? []).map((item, index) => (
              <li key={index} className="text-[13px]" style={{ color: "var(--text-dim)" }}>
                {JSON.stringify(item)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
