import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "@/components/shell/Sidebar";
import { SovereigntyBadge } from "@/components/shell/SovereigntyBadge";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";
import type { Role, Sovereignty, User } from "@/lib/types";

/** Stand up the shell with a given role, mocking only the network. */
function renderWithRole(roles: Role[], at = "/dashboard") {
  const user: User = {
    id: "u1",
    email: "a@b.local",
    name: "Arpit Pandey",
    roles,
  };
  const perms = permissionsFor(roles);

  tokenStore.set("test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return new Response(JSON.stringify(user), { status: 200 });
      }
      if (url.includes("/security/permissions")) {
        return new Response(JSON.stringify(perms), { status: 200 });
      }
      if (url.includes("/conversations") || url.includes("/api/v1/tasks")) {
        return new Response(
          JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[at]}>
        <AuthProvider>
          <Sidebar collapsed={false} onToggle={() => {}} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the sidebar", () => {
  // The boundaries here are `front`'s, mapped through `lib/access`: the four
  // ranks (employee, manager, security, admin) with the backend's five roles
  // folded onto them. A security administrator outranks a manager and still
  // has no chat and no corpus -- oversight and production work are different
  // jobs, not different amounts of the same one.

  it("gives an engineer their own dashboard, workbench and documents", async () => {
    renderWithRole(["ENGINEER"]);

    expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("My Documents")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
    expect(screen.getByText("Artifacts")).toBeInTheDocument();
  });

  it("keeps an engineer out of every surface above their rank", async () => {
    renderWithRole(["ENGINEER"]);

    await screen.findByText("AI Workbench");
    // Manager and above.
    expect(screen.queryByText("Approval Requests")).not.toBeInTheDocument();
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    // Oversight.
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
    // Running generated code is an administrator's tool.
    expect(screen.queryByText("Coding Workspace")).not.toBeInTheDocument();
  });

  it("does not show an engineer the security centre at all", async () => {
    // Not visible-but-locked. In a plant a door you are shown and refused is
    // worse than one you are not shown -- the sovereignty badge in the header
    // already tells everyone the oversight exists.
    renderWithRole(["ENGINEER"]);

    await screen.findByText("AI Workbench");
    expect(screen.queryByText("Security Center")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Security Center/i)).not.toBeInTheDocument();
  });

  it("gives an analyst exactly what an engineer gets", async () => {
    // The two differ in clearance, not in navigation.
    renderWithRole(["ANALYST"]);

    expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
    expect(screen.getByText("My Documents")).toBeInTheDocument();
    expect(screen.queryByText("Approval Requests")).not.toBeInTheDocument();
  });

  it("adds approvals and tasks for a manager, and nothing more", async () => {
    renderWithRole(["MANAGER"]);

    expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
    expect(screen.getByText("Approval Requests")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    // Oversight is still not theirs, and is not shown at all.
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
    expect(screen.queryByText("Security Center")).not.toBeInTheDocument();
  });

  it("hides the corpus and the chat from a security administrator", async () => {
    // SECURITY_ADMIN oversees the system without reading its contents or
    // using it to work. That is `front`'s boundary and the navigation has to
    // reflect it.
    renderWithRole(["SECURITY_ADMIN"]);

    await screen.findByRole("link", { name: /Security Center/i });
    expect(screen.queryByText("My Documents")).not.toBeInTheDocument();
    expect(screen.queryByText("Knowledge Base")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Workbench")).not.toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("Artifacts")).not.toBeInTheDocument();
  });

  it("gives a security administrator oversight and the audit trail", async () => {
    renderWithRole(["SECURITY_ADMIN"]);

    expect(
      await screen.findByRole("link", { name: /Security Center/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Approval Requests")).toBeInTheDocument();
  });

  it("gives an administrator both the work surface and oversight", async () => {
    // ADMIN is the only role holding both halves, which makes it the one that
    // would hide a regression in either.
    renderWithRole(["ADMIN"]);

    expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
    expect(screen.getByText("My Documents")).toBeInTheDocument();
    expect(screen.getByText("Coding Workspace")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Security Center/i }),
    ).toBeInTheDocument();
  });

  it("shows workbench sessions only while standing in the workbench", async () => {
    const { unmount } = renderWithRole(["ENGINEER"], "/workbench");
    expect(await screen.findByText("Workbench sessions")).toBeInTheDocument();
    expect(screen.queryByText("Coding sessions")).not.toBeInTheDocument();
    unmount();

    // On the dashboard there is no session list at all -- history belongs to
    // the surface that produced it.
    renderWithRole(["ENGINEER"], "/dashboard");
    await screen.findByText("AI Workbench");
    expect(screen.queryByText("Workbench sessions")).not.toBeInTheDocument();
  });

  it("shows coding sessions in the coding workspace, and only there", async () => {
    renderWithRole(["ADMIN"], "/coding");

    expect(await screen.findByText("Coding sessions")).toBeInTheDocument();
    expect(screen.queryByText("Workbench sessions")).not.toBeInTheDocument();
  });

  it("gives a security administrator no session list, since they have none", async () => {
    // The panel is absent rather than empty: an empty list reads as broken
    // rather than as the boundary working.
    renderWithRole(["SECURITY_ADMIN"], "/security");

    await screen.findByRole("link", { name: /Security Center/i });
    expect(screen.queryByText("Workbench sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Coding sessions")).not.toBeInTheDocument();
  });

  it("labels every role, and never leaves one unnamed", async () => {
    for (const role of [
      "ENGINEER",
      "ANALYST",
      "MANAGER",
      "ADMIN",
      "SECURITY_ADMIN",
    ] as const) {
      const { unmount } = renderWithRole([role]);
      expect(await screen.findByText("Settings")).toBeInTheDocument();
      // No role may end up labelled "No role assigned", which is what a
      // missing case in `roleLabel` would produce.
      expect(screen.queryByText("No role assigned")).not.toBeInTheDocument();
      unmount();
    }
  });
});

/** Render the badge against one sovereignty payload. */
function renderBadge(payload: Partial<Sovereignty>, status = 200) {
  const body: Sovereignty = {
    external_requests: 0,
    external_connections: 0,
    external_dns_queries: 0,
    local_connections: 12,
    local_dns_queries: 3,
    network_egress: "BLOCKED",
    monitoring: true,
    monitoring_since: new Date().toISOString(),
    recent_external: [],
    ...payload,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(status === 200 ? body : { error: { code: "permission_denied", message: "no", details: {} } }), { status })),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <SovereigntyBadge />
    </QueryClientProvider>,
  );
}

describe("the sovereignty badge", () => {
  it("reads ON when the monitor is watching and clean", async () => {
    renderBadge({});
    expect(await screen.findByText("ON")).toBeInTheDocument();
  });

  it("reads BREACHED when an external connection was observed", async () => {
    // A badge that can only say green is decoration. This is the case most
    // likely to rot unnoticed, because the happy path looks identical.
    renderBadge({ network_egress: "BREACHED", external_connections: 1 });
    expect(await screen.findByText("BREACHED")).toBeInTheDocument();
  });

  it("reads UNVERIFIED when nothing is watching", async () => {
    // Zero external calls from a monitor that is switched off proves nothing,
    // and must not be presented as though it did.
    renderBadge({ monitoring: false });
    expect(await screen.findByText("UNVERIFIED")).toBeInTheDocument();
  });

  it("explains the unverified state when opened", async () => {
    renderBadge({ monitoring: false });
    await screen.findByText("UNVERIFIED");

    await userEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(
        screen.getByText(/not evidence of anything/i),
      ).toBeInTheDocument(),
    );
  });

  it("does not alarm when the role simply cannot read the endpoint", async () => {
    // A permission denial is not a security incident.
    renderBadge({}, 403);
    expect(await screen.findByText("--")).toBeInTheDocument();
    expect(screen.queryByText("BREACHED")).not.toBeInTheDocument();
  });
});
