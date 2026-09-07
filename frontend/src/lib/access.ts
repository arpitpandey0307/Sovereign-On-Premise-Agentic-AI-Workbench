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

/**
 * A workspace, which is to say a role.
 *
 * The chooser asks people to say who they are signing in as -- Engineer,
 * Analyst, Manager, Security Administrator, Administrator -- rather than to
 * pick an abstract area. It is the question a person can actually answer about
 * themselves, and it makes the check at sign-in a plain one: the role they
 * claimed either is among the roles the server returns, or it is not.
 *
 * `backendRole` is what that claim is checked against. `role` is the rank it
 * resolves to, which is what decides the navigation.
 */
export type Workspace = {
  id: string;
  name: string;
  /** What this person does, in their own terms. */
  blurb: string[];
  /** The backend role being claimed. */
  backendRole: Role;
  /** The rank it maps to. */
  role: WorkspaceRole;
  /** Where signing in as this lands. */
  home: string;
};

export const WORKSPACES: Workspace[] = [
  {
    id: "engineer",
    name: "Engineer",
    blurb: [
      "Ask the workbench, grounded in your documents",
      "Upload drawings, reports and PDFs",
      "Your own dashboard and chat history",
    ],
    backendRole: "ENGINEER",
    role: "employee",
    home: "/dashboard",
  },
  {
    id: "analyst",
    name: "Analyst",
    blurb: [
      "Search and cross-reference the corpus",
      "Generated reports and artifacts",
      "The same working surface as an engineer",
    ],
    backendRole: "ANALYST",
    role: "employee",
    home: "/dashboard",
  },
  {
    id: "manager",
    name: "Manager",
    blurb: [
      "Approval requests awaiting a decision",
      "Task activity across the team",
      "Everything an engineer can do, as well",
    ],
    backendRole: "MANAGER",
    role: "manager",
    home: "/approvals",
  },
  {
    id: "security",
    name: "Security Administrator",
    blurb: [
      "Sovereignty monitor and network events",
      "The audit ledger and the policy in force",
      "Oversight only — no chat, no corpus",
    ],
    backendRole: "SECURITY_ADMIN",
    role: "security",
    home: "/security",
  },
  {
    id: "admin",
    name: "Administrator",
    blurb: [
      "The whole system",
      "Model registry and the code sandbox",
      "Every working and oversight surface",
    ],
    backendRole: "ADMIN",
    role: "admin",
    home: "/dashboard",
  },
];

export function workspaceById(id: string | null): Workspace | undefined {
  return id ? WORKSPACES.find((workspace) => workspace.id === id) : undefined;
}

/**
 * Whether the credentials bear out the claim that was made.
 *
 * The declared role has to be one the account actually holds. Someone holding
 * ADMIN is not admitted as an Engineer by saying so -- the interface would then
 * be showing them a smaller product than the server will give them, which is a
 * different kind of lie but still a lie.
 */
export function admits(workspace: Workspace, held: readonly Role[]): boolean {
  return held.includes(workspace.backendRole);
}

/** The identities an account can legitimately sign in as. */
export function workspacesFor(held: readonly Role[]): Workspace[] {
  const mine = WORKSPACES.filter((workspace) => admits(workspace, held));
  // An account whose roles are all unrecognised still needs somewhere to be.
  return mine.length > 0 ? mine : [WORKSPACES[0]];
}

/**
 * Where a role lands with nothing chosen.
 *
 * A security administrator's home is the Security Center, not a dashboard they
 * have no data for — landing somewhere empty reads as broken.
 */
export function homeFor(role: WorkspaceRole): string {
  return WORKSPACES.find((workspace) => workspace.role === role)?.home ?? "/settings";
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
