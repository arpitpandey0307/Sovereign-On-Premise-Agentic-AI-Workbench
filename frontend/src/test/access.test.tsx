/**
 * The route boundary.
 *
 * Before this existed the sidebar hid links the router still served: typing
 * `/security` as an engineer rendered the Security Center and left the API to
 * refuse each request piecemeal, which looks like a broken screen rather than
 * a boundary. Hiding a link is presentation; this is the interface agreeing
 * with the server instead of contradicting it.
 *
 * It is still not *the* security boundary — the server is, and it re-checks
 * every request. These tests pin that the interface does not offer what the
 * server would refuse.
 */

import { describe, expect, it } from "vitest";
import {
  canOpen,
  homeFor,
  workspaceRole,
  workspacesFor,
  WORKSPACES,
} from "@/lib/access";
import type { Role } from "@/lib/types";

describe("role resolution", () => {
  it("maps the backend's five roles onto front's four ranks", () => {
    expect(workspaceRole(["ENGINEER"])).toBe("employee");
    expect(workspaceRole(["ANALYST"])).toBe("employee");
    expect(workspaceRole(["MANAGER"])).toBe("manager");
    expect(workspaceRole(["SECURITY_ADMIN"])).toBe("security");
    expect(workspaceRole(["ADMIN"])).toBe("admin");
  });

  it("takes the highest rank when someone holds several", () => {
    // The seeded demo account is exactly this shape.
    expect(workspaceRole(["ADMIN", "ENGINEER"])).toBe("admin");
    expect(workspaceRole(["ENGINEER", "MANAGER"])).toBe("manager");
  });

  it("resolves an empty role list to the least privileged answer", () => {
    // Permissions arrive asynchronously. A default that widened the interface
    // for the moment before they land would flash screens the person cannot
    // actually open.
    expect(workspaceRole([])).toBe("employee");
    expect(workspaceRole(["NONSENSE" as Role])).toBe("employee");
  });
});

describe("what each role may open", () => {
  it("gives an employee their own dashboard and the workbench", () => {
    for (const path of [
      "/dashboard",
      "/workbench",
      "/documents",
      "/documents/abc",
      "/knowledge",
      "/artifacts",
      "/settings",
      "/profile",
    ]) {
      expect(canOpen("employee", path), path).toBe(true);
    }
  });

  it("keeps an employee out of oversight and out of the sandbox", () => {
    for (const path of [
      "/security",
      "/models",
      "/coding",
      "/approvals",
      "/tasks",
      "/tasks/abc",
    ]) {
      expect(canOpen("employee", path), path).toBe(false);
    }
  });

  it("adds approvals and tasks for a manager, and nothing above", () => {
    expect(canOpen("manager", "/approvals")).toBe(true);
    expect(canOpen("manager", "/tasks")).toBe(true);
    expect(canOpen("manager", "/workbench")).toBe(true);
    expect(canOpen("manager", "/security")).toBe(false);
    expect(canOpen("manager", "/models")).toBe(false);
    expect(canOpen("manager", "/coding")).toBe(false);
  });

  it("keeps a security administrator out of the corpus and the chat", () => {
    // front's boundary, and the one most likely to be softened by accident:
    // security outranks manager and still does no production work.
    expect(canOpen("security", "/security")).toBe(true);
    expect(canOpen("security", "/models")).toBe(true);
    expect(canOpen("security", "/tasks/abc")).toBe(true);
    expect(canOpen("security", "/workbench")).toBe(false);
    expect(canOpen("security", "/documents")).toBe(false);
    expect(canOpen("security", "/knowledge")).toBe(false);
    expect(canOpen("security", "/artifacts")).toBe(false);
    expect(canOpen("security", "/dashboard")).toBe(false);
  });

  it("gives an administrator every route", () => {
    for (const path of [
      "/dashboard",
      "/workbench",
      "/coding",
      "/tasks",
      "/approvals",
      "/documents",
      "/knowledge",
      "/artifacts",
      "/models",
      "/security",
      "/settings",
      "/profile",
    ]) {
      expect(canOpen("admin", path), path).toBe(true);
    }
  });

  it("refuses a path nobody listed, for every role", () => {
    // Failing closed is the safe direction: a new screen is invisible until it
    // is placed in the table, rather than exposed to everyone by omission.
    for (const role of ["employee", "manager", "security", "admin"] as const) {
      expect(canOpen(role, "/not-a-real-route")).toBe(false);
      expect(canOpen(role, "/")).toBe(false);
    }
  });

  it("governs a nested route by its parent, not by accident", () => {
    // `/documents/:id` must not be reachable by a role denied `/documents`.
    expect(canOpen("security", "/documents/abc")).toBe(false);
    expect(canOpen("employee", "/documents/abc")).toBe(true);
  });
});

describe("workspaces", () => {
  it("gives every role at least one workspace, and a home inside it", () => {
    for (const role of ["employee", "manager", "security", "admin"] as const) {
      const mine = workspacesFor(role);
      expect(mine.length, role).toBeGreaterThan(0);
      // The home a role lands on must be one they may actually open.
      expect(canOpen(role, homeFor(role)), role).toBe(true);
    }
  });

  it("never lands a security administrator on a dashboard they have no data for", () => {
    expect(homeFor("security")).toBe("/security");
  });

  it("only ever routes a workspace to somewhere its roles can open", () => {
    for (const workspace of WORKSPACES) {
      for (const role of workspace.roles) {
        expect(canOpen(role, workspace.home), `${workspace.id}/${role}`).toBe(
          true,
        );
      }
    }
  });
});
