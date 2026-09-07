/**
 * Who may reach what.
 *
 * One table, used by three things that must never disagree: the workspace
 * chooser, the sidebar, and the route guard. When they are separate lists the
 * sidebar eventually hides a link the router still serves, and typing the URL
 * walks straight past the boundary.
 *
 * The role model is the one in `front/js/components.js` — four ranks, with the
 * backend's five roles mapped onto them. That mapping and those ranks are
 * copied deliberately rather than reinvented; `front` is the design authority
 * for what each kind of person is allowed to see.
 *
 * This decides what the *interface offers*. It is not the security boundary —
 * the server is, and it re-checks every request. A guard here that the server
 * did not also enforce would be decoration.
 */

import type { Role } from "@/lib/types";

/** The four kinds of person the product is designed around. */
export type WorkspaceRole = "employee" | "manager" | "security" | "admin";

/** Higher wins when someone holds several roles. From `front`'s ROLE_RANK. */
const RANK: Record<WorkspaceRole, number> = {
  employee: 1,
  manager: 2,
  security: 3,
  admin: 4,
};

/** Backend role → workspace role. From `front`'s ROLE_MAP. */
const ROLE_MAP: Record<Role, WorkspaceRole> = {
  ENGINEER: "employee",
  ANALYST: "employee",
  MANAGER: "manager",
  ADMIN: "admin",
  SECURITY_ADMIN: "security",
};

/**
 * The single workspace role a person acts as.
 *
 * Someone holding several roles gets the highest, which is how `front` reads
 * it. An empty list resolves to `employee` — the least privileged answer, so a
 * permissions response that has not arrived yet cannot briefly widen the
 * interface.
 */
export function workspaceRole(roles: readonly Role[]): WorkspaceRole {
  let best: WorkspaceRole = "employee";
  for (const role of roles) {
    const mapped = ROLE_MAP[role];
    if (mapped && RANK[mapped] > RANK[best]) best = mapped;
  }
  return best;
}

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  employee: "Engineering",
  manager: "Management",
  security: "Security & Audit",
  admin: "Administration",
};

/**
 * Every route inside the shell, and who may reach it.
 *
 * Listed explicitly rather than derived from a rank, because the boundaries in
 * `front` are not a simple ladder: a security administrator outranks a manager
 * but has *no* access to the chat or the document corpus, by design. Oversight
 * and production work are different jobs, not different amounts of the same
 * one.
 */
const ROUTE_ACCESS: Array<{ path: string; roles: WorkspaceRole[] }> = [
  // The employee's own area.
  { path: "/dashboard", roles: ["employee", "manager", "admin"] },
  { path: "/workbench", roles: ["employee", "manager", "admin"] },
  { path: "/documents", roles: ["employee", "manager", "admin"] },
  { path: "/knowledge", roles: ["employee", "manager", "admin"] },
  { path: "/artifacts", roles: ["employee", "manager", "admin"] },

  // Manager and above.
  { path: "/tasks", roles: ["manager", "security", "admin"] },
  { path: "/approvals", roles: ["manager", "security", "admin"] },

  // Oversight.
  { path: "/security", roles: ["security", "admin"] },
  { path: "/models", roles: ["security", "admin"] },

  // Running generated code is an administrator's tool.
  { path: "/coding", roles: ["admin"] },

  // Everyone has an account.
  { path: "/settings", roles: ["employee", "manager", "security", "admin"] },
  { path: "/profile", roles: ["employee", "manager", "security", "admin"] },
];

/**
 * Which access rule covers a path.
 *
 * Longest prefix wins, so `/documents/:id` is governed by `/documents` and a
 * new nested route cannot slip through by not being listed.
 */
function ruleFor(pathname: string) {
  let match: (typeof ROUTE_ACCESS)[number] | undefined;
  for (const rule of ROUTE_ACCESS) {
    if (pathname === rule.path || pathname.startsWith(`${rule.path}/`)) {
      if (!match || rule.path.length > match.path.length) match = rule;
    }
  }
  return match;
}

/**
 * May this role open this path?
 *
 * An unlisted path is refused. A new screen is invisible until it is placed in
 * the table above, which is the safe direction to fail: forgetting to add a
 * route hides it, rather than exposing it to everyone.
 */
export function canOpen(role: WorkspaceRole, pathname: string): boolean {
  return ruleFor(pathname)?.roles.includes(role) ?? false;
}

/** A workspace on the chooser: a place in the product, and who works there. */
export type Workspace = {
  id: string;
  name: string;
  blurb: string[];
  /** Who is admitted. Checked after sign-in, never before. */
  roles: WorkspaceRole[];
  /** Where entering it lands. */
  home: string;
};

export const WORKSPACES: Workspace[] = [
  {
    id: "engineering",
    name: "Engineering & Operations",
    blurb: [
      "Ask the workbench, with your documents",
      "Upload drawings, reports and PDFs",
      "Your own dashboard and chat history",
    ],
    roles: ["employee", "manager", "admin"],
    home: "/dashboard",
  },
  {
    id: "management",
    name: "Management",
    blurb: [
      "Approval requests awaiting a decision",
      "Task activity across the team",
      "Reports and decision support",
    ],
    roles: ["manager", "admin"],
    home: "/approvals",
  },
  {
    id: "security",
    name: "Security & Audit",
    blurb: [
      "Sovereignty monitor and network events",
      "The audit ledger",
      "Policy in force, model status",
    ],
    roles: ["security", "admin"],
    home: "/security",
  },
  {
    id: "administration",
    name: "Administration",
    blurb: [
      "The whole system",
      "Model registry and the code sandbox",
      "Every oversight surface",
    ],
    roles: ["admin"],
    home: "/dashboard",
  },
];

export function workspaceById(id: string | null): Workspace | undefined {
  return id ? WORKSPACES.find((workspace) => workspace.id === id) : undefined;
}

/** The workspaces a role may actually enter. Never empty: everyone has one. */
export function workspacesFor(role: WorkspaceRole): Workspace[] {
  return WORKSPACES.filter((workspace) => workspace.roles.includes(role));
}

/**
 * Where a role lands with no workspace chosen.
 *
 * A security administrator's home is the Security Center, not a dashboard they
 * have no data for — landing somewhere empty reads as broken.
 */
export function homeFor(role: WorkspaceRole): string {
  return workspacesFor(role)[0]?.home ?? "/settings";
}

/**
 * The workspace someone picked before signing in.
 *
 * sessionStorage, matching the token: an intent left behind on a shared
 * workstation should not greet the next person who sits down. It carries no
 * privilege — the role decides on arrival — so losing it costs one click.
 */
const INTENT_KEY = "sovereign.workspace.intent";

export const workspaceIntent = {
  get(): string | null {
    try {
      return sessionStorage.getItem(INTENT_KEY);
    } catch {
      return null;
    }
  },
  set(id: string): void {
    try {
      sessionStorage.setItem(INTENT_KEY, id);
    } catch {
      /* the chooser still works; it just will not survive a reload */
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(INTENT_KEY);
    } catch {
      /* nothing to clear */
    }
  },
};
