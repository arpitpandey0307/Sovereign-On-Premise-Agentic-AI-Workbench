/**
 * Settings.
 *
 * Mostly read-only for the MVP, and honest about which is which. A handful of
 * things are genuinely editable — sidebar state, the remembered workspace,
 * table density. The rest is shown as it is, disabled, rather than as a
 * control that would post nowhere.
 *
 * The parts panel lives here because Settings is where an operator looks: any
 * part reading `stub` failed to install at startup, which is the single most
 * useful diagnostic the system has.
 */

import { useState } from "react";
import { useSovereignty, useSystemStatus } from "@/lib/queries";

type Tab = "workspace" | "security" | "models" | "notifications" | "system";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "workspace", label: "Workspace" },
  { id: "security", label: "Security" },
  { id: "models", label: "Models" },
  { id: "notifications", label: "Notifications" },
  { id: "system", label: "System" },
];

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* the choice will not persist */
  }
}

export function Settings() {
  const [tab, setTab] = useState<Tab>("workspace");

  return (
    <div className="view-pad" style={{ maxWidth: "820px" }}>
      <div className="view-head">
        <h2>Settings</h2>
        <div className="sub">
          What can be changed on this deployment, and what is fixed in
          configuration.
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={"btn btn-sm" + (tab === entry.id ? " btn-accent" : "")}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "workspace" && <WorkspaceTab />}
      {tab === "security" && <SecurityTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "notifications" && <NotificationsTab />}
      {tab === "system" && <SystemTab />}
    </div>
  );
}

function Reads({ k, v }: { k: string; v: string }) {
  return (
    <div className="setting-row">
      <span className="k">{k}</span>
      <span className="v mono">{v}</span>
    </div>
  );
}

function Toggle({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <div className="setting-row">
      <span className="k">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={"toggle" + (on ? " on" : "")}
        onClick={onToggle}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

function WorkspaceTab() {
  const [collapsed, setCollapsed] = useState(
    readPref("sovereign.sidebar.collapsed") === "true",
  );
  const [density, setDensity] = useState(readPref("sovereign.density") ?? "comfortable");
  const [workspace, setWorkspace] = useState(readPref("sovereign.workspace.skip"));

  return (
    <div className="card">
      <div className="field-label">Editable</div>
      <Toggle
        label="Start with the sidebar collapsed"
        on={collapsed}
        onToggle={() => {
          const next = !collapsed;
          setCollapsed(next);
          writePref("sovereign.sidebar.collapsed", String(next));
        }}
      />
      <div className="setting-row">
        <span className="k">Table density</span>
        <select
          className="select"
          style={{ maxWidth: "180px" }}
          value={density}
          onChange={(event) => {
            setDensity(event.target.value);
            writePref("sovereign.density", event.target.value);
          }}
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </div>
      <div className="setting-row">
        <span className="k">Remembered workspace</span>
        <span className="v">
          {workspace ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                writePref("sovereign.workspace.skip", null);
                setWorkspace(null);
              }}
            >
              Clear ({workspace})
            </button>
          ) : (
            <span className="mono">none — the selector shows each sign-in</span>
          )}
        </span>
      </div>

      <div className="field-label" style={{ marginTop: "16px" }}>
        Fixed on this deployment
      </div>
      <Reads k="Theme" v="Single dark theme — this is a control-room instrument panel" />
    </div>
  );
}

function SecurityTab() {
  const sov = useSovereignty();
  const d = sov.data;
  return (
    <div className="card">
      <div className="field-label">Read-only</div>
      <Reads
        k="Sovereign mode"
        v={
          d
            ? d.monitoring
              ? d.network_egress === "BLOCKED"
                ? "ON · monitored"
                : "BREACHED"
              : "unverified — monitor off"
            : "…"
        }
      />
      <Reads
        k="External network"
        v={d ? (d.network_egress === "BLOCKED" ? "Blocked" : "BREACHED") : "…"}
      />
      <Reads k="Session timeout" v="Set by the server; the app warns 5 min before expiry" />
      <p className="hint" style={{ marginTop: "10px" }}>
        These are enforced by the backend. The Security Center has the live
        detail.
      </p>
    </div>
  );
}

function ModelsTab() {
  return (
    <div className="card">
      <div className="field-label">Read-only</div>
      <Reads k="Default model selection" v="Chosen per task by the router — see the Model Center playground" />
      <Reads k="Adding / removing models" v="Defined in the catalogue on this deployment" />
    </div>
  );
}

function NotificationsTab() {
  return (
    <div className="card">
      <p
        className="flex items-start gap-2 rounded-[var(--radius)] px-3 py-2 text-[12.5px]"
        style={{
          background: "var(--warn-bg)",
          border: "1px solid var(--warn-line)",
          color: "var(--warn-text)",
        }}
      >
        Notification preferences need a notifications service, which is not
        enabled on this deployment. Nothing here is wired.
      </p>
    </div>
  );
}

function SystemTab() {
  const status = useSystemStatus();
  const d = status.data;

  return (
    <div className="card">
      <div className="field-label">Deployment</div>
      {d ? (
        <>
          <Reads k="Application" v={`${d.app} ${d.version}`} />
          <Reads k="Object storage" v={d.object_storage} />
          <Reads
            k="External network"
            v={d.external_network_allowed ? "Allowed" : "Blocked"}
          />
          <Reads
            k="Model runtime"
            v={d.model_runtime.reachable ? `Reachable — ${d.model_runtime.detail}` : "Unreachable"}
          />
        </>
      ) : (
        <p className="loading-note">Reading system status…</p>
      )}

      {d && (
        <>
          <div className="field-label" style={{ marginTop: "16px" }}>
            Backend parts
          </div>
          <p className="hint" style={{ marginBottom: "6px" }}>
            A part reading <span className="mono">stub</span> failed to install
            at startup — that is the diagnostic to act on.
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(d.parts).map(([name, state]) => (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td>
                      <span className={"pill " + (state === "live" ? "ok" : "danger")}>
                        {state}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
