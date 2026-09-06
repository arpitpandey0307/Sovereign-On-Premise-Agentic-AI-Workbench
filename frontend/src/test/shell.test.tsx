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
function renderWithRole(roles: Role[]) {
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
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Sidebar collapsed={false} onToggle={() => {}} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the sidebar", () => {
  it("shows the workbench and documents to an engineer", async () => {
    renderWithRole(["ENGINEER"]);

    expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
  });

  it("locks the security centre for an engineer rather than hiding it", async () => {
    // Knowing the system *has* oversight is part of what the product argues,
    // so the item stays visible and disabled.
    renderWithRole(["ENGINEER"]);

    const item = await screen.findByTitle(/Security Center/i);
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("hides the corpus from a security administrator", async () => {
    // SECURITY_ADMIN oversees the system without reading its contents. That
    // is deliberate, and the navigation has to reflect it.
    renderWithRole(["SECURITY_ADMIN"]);

    await screen.findByText("Dashboard");
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();
    expect(screen.queryByText("Knowledge Base")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Workbench")).not.toBeInTheDocument();
  });

  it("gives a security administrator the security centre unlocked", async () => {
    renderWithRole(["SECURITY_ADMIN"]);

    const link = await screen.findByRole("link", { name: /Security Center/i });
    expect(link).toBeInTheDocument();
  });

  // An analyst and a manager differ from an engineer in clearance, not in
  // navigation. Asserting that keeps a future permission change from quietly
  // removing a screen from a role that is supposed to have it.
  it.each([["ANALYST"], ["MANAGER"]] as const)(
    "gives %s the same working surface as an engineer",
    async (role) => {
      renderWithRole([role]);

      expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
      expect(screen.getByText("Documents")).toBeInTheDocument();
      expect(screen.getByText("Tasks")).toBeInTheDocument();
      expect(screen.getByText("Artifacts")).toBeInTheDocument();
      // Neither role oversees the system, so the centre stays locked.
      expect(screen.getByTitle(/Security Center/i)).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    },
  );

  it("gives an administrator both the work surface and oversight", async () => {
    // ADMIN is the only role holding both halves, which makes it the one that
    // would hide a regression in either.
    renderWithRole(["ADMIN"]);

    expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Security Center/i }),
    ).toBeInTheDocument();
  });

  it("shows every role its own label and the dashboard", async () => {
    for (const role of [
      "ENGINEER",
      "ANALYST",
      "MANAGER",
      "ADMIN",
      "SECURITY_ADMIN",
    ] as const) {
      const { unmount } = renderWithRole([role]);
      expect(await screen.findByText("Dashboard")).toBeInTheDocument();
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
