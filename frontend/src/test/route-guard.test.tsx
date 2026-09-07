/**
 * The guard, exercised through the real router.
 *
 * `access.test.tsx` pins the table; this pins that the router actually consults
 * it. The failure it prevents is specific and was real: the sidebar hid
 * `/security` from an engineer while the route still rendered the Security
 * Center, so anyone who typed the URL got the screen and a scatter of failed
 * requests inside it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "@/App";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";
import type { Role } from "@/lib/types";

function renderAt(path: string, roles: Role[]) {
  const user = { id: "u1", email: "a@b.local", name: "Arpit Pandey", roles };
  tokenStore.set("test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return new Response(JSON.stringify(user), { status: 200 });
      }
      if (url.includes("/security/permissions")) {
        return new Response(JSON.stringify(permissionsFor(roles)), { status: 200 });
      }
      if (url.includes("/api/v1/tasks") || url.includes("/conversations")) {
        return new Response(
          JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("typing a URL above your role", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("refuses the Security Center to an engineer, and explains", async () => {
    renderAt("/security", ["ENGINEER"]);

    expect(
      await screen.findByText(/not part of your workspace/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Refused, not redirected: a silent bounce hides the reason and makes a
    // governed system feel broken.
    expect(screen.getByText("/security")).toBeInTheDocument();
    // The shell's header still names the URL that was asked for, which is
    // useful. What must not appear is the screen itself.
    expect(screen.queryByText(/Policy in force/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Audit ledger|Network egress/i)).not.toBeInTheDocument();
  });

  it("names the workspace the refused person actually holds", async () => {
    renderAt("/models", ["ENGINEER"]);

    expect(
      await screen.findByText(/not part of your workspace/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Engineering & Operations/i }),
    ).toBeInTheDocument();
  });

  it("refuses the corpus to a security administrator", async () => {
    // The boundary that runs the other way: outranking a manager does not buy
    // access to what the plant is working on.
    renderAt("/documents", ["SECURITY_ADMIN"]);

    expect(
      await screen.findByText(/not part of your workspace/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Security & Audit/i }),
    ).toBeInTheDocument();
  });

  it("refuses the code sandbox to a manager", async () => {
    renderAt("/coding", ["MANAGER"]);

    expect(
      await screen.findByText(/not part of your workspace/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it("lets an engineer into their own workbench", async () => {
    renderAt("/workbench", ["ENGINEER"]);

    expect(
      await screen.findByText(
        /What would you like the workbench to do/i,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not part of your workspace/i)).not.toBeInTheDocument();
  });

  it("lets an administrator into everything it refuses the others", async () => {
    renderAt("/coding", ["ADMIN"]);

    expect(
      await screen.findByText(/Sandbox confinement/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });
});
