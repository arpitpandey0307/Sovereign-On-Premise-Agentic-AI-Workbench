import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "@/components/shell/Sidebar";
import { SovereigntyBadge } from "@/components/shell/SovereigntyBadge";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import type { Permissions, Role, Sovereignty, User } from "@/lib/types";

const ENGINEER_PERMISSIONS = [
  "task:read",
  "task:create",
  "document:read",
  "document:search",
  "artifact:download",
  "model:read",
  "conversation:read",
  "conversation:write",
  "file:read",
  "file:upload",
];

const SECURITY_PERMISSIONS = ["model:read", "system:read", "audit:read", "security:read"];

/** Stand up the shell with a given role, mocking only the network. */
function renderWithRole(roles: Role[], permissions: string[]) {
  const user: User = {
    id: "u1",
    email: "a@b.local",
    name: "Arpit Pandey",
    roles,
  };
  const perms: Permissions = {
    roles,
    clearance: roles.includes("SECURITY_ADMIN") ? "PUBLIC" : "CONFIDENTIAL",
    readable_classifications: [],
    permissions,
  };

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
    renderWithRole(["ENGINEER"], ENGINEER_PERMISSIONS);

    expect(await screen.findByText("AI Workbench")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Base")).toBeInTheDocument();
  });

  it("locks the security centre for an engineer rather than hiding it", async () => {
    // Knowing the system *has* oversight is part of what the product argues,
    // so the item stays visible and disabled.
    renderWithRole(["ENGINEER"], ENGINEER_PERMISSIONS);

    const item = await screen.findByTitle(/Security Center/i);
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("hides the corpus from a security administrator", async () => {
    // SECURITY_ADMIN oversees the system without reading its contents. That
    // is deliberate, and the navigation has to reflect it.
    renderWithRole(["SECURITY_ADMIN"], SECURITY_PERMISSIONS);

    await screen.findByText("Dashboard");
    expect(screen.queryByText("Documents")).not.toBeInTheDocument();
    expect(screen.queryByText("Knowledge Base")).not.toBeInTheDocument();
    expect(screen.queryByText("AI Workbench")).not.toBeInTheDocument();
  });

  it("gives a security administrator the security centre unlocked", async () => {
    renderWithRole(["SECURITY_ADMIN"], SECURITY_PERMISSIONS);

    const link = await screen.findByRole("link", { name: /Security Center/i });
    expect(link).toBeInTheDocument();
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
