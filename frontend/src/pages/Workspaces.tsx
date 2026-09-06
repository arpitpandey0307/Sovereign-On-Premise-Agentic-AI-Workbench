import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  ClipboardList,
  Cpu,
  HardHat,
  Lock,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { roleLabel, useAuth, useRole } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import type { Role } from "@/lib/types";

/**
 * The workspace selector.
 *
 * A shortcut into the right area of the product -- explicitly *not* a way to
 * grant yourself permissions. Workspaces the role cannot enter are shown
 * locked with the reason, rather than hidden: a selector that appeared to let
 * someone pick "Security / Admin" would suggest privilege is self-service,
 * which is the opposite of what this product argues.
 */

/**
 * The remembered workspace, stored by id rather than by path.
 *
 * The id is resolved against the current role on every visit, so a preference
 * saved while someone held a role they have since lost cannot route them into
 * a screen they may no longer use. localStorage rather than sessionStorage
 * because this is a convenience with no security value, and it is meant to
 * survive the sign-outs a shared workstation produces all day.
 */
const SKIP_KEY = "sovereign.workspace.skip";

function readRemembered(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

function forgetRemembered(): void {
  try {
    localStorage.removeItem(SKIP_KEY);
  } catch {
    /* nothing to forget */
  }
}

type Workspace = {
  id: string;
  name: string;
  Icon: typeof HardHat;
  blurb: string[];
  roles: Role[];
  to: string;
};

const WORKSPACES: Workspace[] = [
  {
    id: "engineering",
    name: "Engineering",
    Icon: HardHat,
    blurb: ["Technical documentation", "P&IDs", "Inspection", "Engineering analysis"],
    roles: ["ENGINEER", "ANALYST", "MANAGER", "ADMIN"],
    to: "/workbench",
  },
  {
    id: "operations",
    name: "Operations",
    Icon: Wrench,
    blurb: ["Maintenance", "Operational reports", "Asset information"],
    roles: ["ENGINEER", "ANALYST", "MANAGER", "ADMIN"],
    to: "/workbench",
  },
  {
    id: "management",
    name: "Management",
    Icon: ClipboardList,
    blurb: ["Reports", "Analytics", "Presentations", "Decision support"],
    roles: ["MANAGER", "ADMIN"],
    to: "/dashboard",
  },
  {
    id: "security",
    name: "Security / Admin",
    Icon: Cpu,
    blurb: ["Models", "Policies", "Audit", "Network", "System controls"],
    roles: ["ADMIN", "SECURITY_ADMIN"],
    to: "/security",
  },
];

export function Workspaces() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const { roles, clearance } = useRole();
  const [params] = useSearchParams();
  // Ticked already if a preference is stored, so arriving here deliberately
  // shows the current state and unticking it is how it gets cleared.
  const [remember, setRemember] = useState(() => readRemembered() !== null);

  // `?choose=1` is how someone gets back to this screen after remembering a
  // choice. Without it the preference would be a one-way door.
  const forced = params.get("choose") === "1";
  const remembered = WORKSPACES.find((w) => w.id === readRemembered());
  const stillPermitted =
    remembered?.roles.some((role) => roles.includes(role)) ?? false;

  // A remembered workspace the role can no longer enter is dropped rather
  // than silently ignored, so the screen does not keep offering to forget a
  // preference that is already inert.
  //
  // Guarded on `loading`, because permissions arrive asynchronously and an
  // unguarded check runs once against an empty role list -- which looks
  // exactly like "no longer permitted" and would delete a valid preference
  // every time the page was opened.
  useEffect(() => {
    if (!loading && remembered && !stillPermitted) forgetRemembered();
  }, [loading, remembered, stillPermitted]);

  if (loading) return null;

  if (!forced && remembered && stillPermitted) {
    return <Navigate to={remembered.to} replace />;
  }

  const enter = (workspace: Workspace) => {
    if (remember) {
      try {
        localStorage.setItem(SKIP_KEY, workspace.id);
      } catch {
        /* the preference simply will not persist */
      }
    } else {
      // Unticking it on a later visit is how the preference is cleared.
      forgetRemembered();
    }
    navigate(workspace.to, { replace: true });
  };

  return (
    <div className="min-h-screen bg-canvas px-6 py-16">
      <div className="mx-auto max-w-4xl">
        <header className="mb-2 flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded bg-accent-soft">
            <Lock className="size-4 text-accent" aria-hidden />
          </div>
          <p className="text-sm font-semibold tracking-tight">SOVEREIGN AI</p>
        </header>

        <h1 className="mt-8 text-2xl font-semibold tracking-tight">
          Choose your workspace
        </h1>
        <p className="mt-1.5 text-sm text-secondary">
          Your available workspaces depend on your organizational permissions.
        </p>

        <div className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius)] border border-subtle bg-panel px-3 py-1.5">
          <ShieldCheck className="size-3.5 text-accent" aria-hidden />
          <span className="text-xs text-secondary">
            Signed in as{" "}
            <span className="font-medium text-primary">{user?.name}</span> &mdash;{" "}
            {roleLabel(roles)}
          </span>
          <span className="mono rounded bg-elevated px-1.5 py-0.5 text-[10px] text-tertiary">
            {clearance}
          </span>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {WORKSPACES.map((workspace) => {
            const permitted = workspace.roles.some((role) => roles.includes(role));
            return (
              <WorkspaceCard
                key={workspace.id}
                workspace={workspace}
                permitted={permitted}
                onEnter={() => enter(workspace)}
              />
            );
          })}
        </div>

        <label className="mt-5 flex w-fit cursor-pointer items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            className="size-3.5 accent-[var(--color-accent)]"
          />
          Remember my choice and go straight there next time
        </label>

        <p className="mt-8 text-[11px] text-tertiary">
          Selecting a workspace changes what this application shows you. It
          does not change what you are permitted to access &mdash; permissions are
          assigned by your administrator and enforced by the server.
        </p>

        <div className="mt-6">
          <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>
            Skip to dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceCard({
  workspace,
  permitted,
  onEnter,
}: {
  workspace: Workspace;
  permitted: boolean;
  onEnter: () => void;
}) {
  const { Icon, name, blurb } = workspace;

  return (
    <button
      type="button"
      onClick={permitted ? onEnter : undefined}
      disabled={!permitted}
      aria-label={
        permitted ? `Enter ${name} workspace` : `${name} — not available to your role`
      }
      className={cn(
        "group rounded-[var(--radius)] border p-4 text-left transition-colors",
        permitted
          ? "border-subtle bg-panel hover:border-accent/50 hover:bg-elevated"
          : "cursor-not-allowed border-subtle/60 bg-panel/50",
      )}
    >
      <div className="flex items-start justify-between">
        <div
          className={cn(
            "grid size-8 place-items-center rounded",
            permitted ? "bg-accent-soft" : "bg-inactive-soft",
          )}
        >
          <Icon
            className={cn("size-4", permitted ? "text-accent" : "text-inactive")}
            aria-hidden
          />
        </div>
        {!permitted && <Lock className="size-3.5 text-tertiary" aria-hidden />}
      </div>

      <p
        className={cn(
          "mt-3 text-sm font-medium",
          permitted ? "text-primary" : "text-tertiary",
        )}
      >
        {name}
      </p>

      <ul className="mt-1.5 space-y-0.5">
        {blurb.map((line) => (
          <li key={line} className="text-[11px] text-tertiary">
            {line}
          </li>
        ))}
      </ul>

      {!permitted && (
        <p className="mt-3 border-t border-subtle pt-2 text-[10px] text-tertiary">
          Requires {workspace.roles.map((role) => role.replace(/_/g, " ")).join(" or ")}
        </p>
      )}
    </button>
  );
}
