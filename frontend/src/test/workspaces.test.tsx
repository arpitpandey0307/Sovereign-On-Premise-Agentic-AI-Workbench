/**
 * The workspace selector.
 *
 * Two things matter here. The remembered choice has to actually be read back
 * -- writing a preference nothing consults is worse than not offering it. And
 * the selector must never be a route to privilege: a remembered workspace the
 * current role cannot enter has to be discarded, not followed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { Workspaces } from "@/pages/Workspaces";
import { permissionsFor } from "@/test/roles";
import type { Role } from "@/lib/types";

const SKIP_KEY = "sovereign.workspace.skip";

function renderSelector(roles: Role[], entry = "/workspaces") {
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
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <Routes>
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="/workbench" element={<p>Workbench screen</p>} />
            <Route path="/security" element={<p>Security screen</p>} />
            <Route path="/dashboard" element={<p>Dashboard screen</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the workspace selector", () => {
  beforeEach(() => {
    localStorage.clear();
    tokenStore.clear();
  });

  it("remembers the choice only when asked to", async () => {
    renderSelector(["ENGINEER"]);
    await screen.findByText("Choose your workspace");

    await userEvent.click(
      screen.getByRole("button", { name: /Enter Engineering workspace/i }),
    );

    expect(localStorage.getItem(SKIP_KEY)).toBeNull();
    expect(await screen.findByText("Workbench screen")).toBeInTheDocument();
  });

  it("stores the choice when the box is ticked, and skips the screen next time", async () => {
    const first = renderSelector(["ENGINEER"]);
    await screen.findByText("Choose your workspace");

    await userEvent.click(screen.getByRole("checkbox", { name: /Remember my choice/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /Enter Engineering workspace/i }),
    );
    expect(localStorage.getItem(SKIP_KEY)).toBe("engineering");
    first.unmount();

    renderSelector(["ENGINEER"]);

    expect(await screen.findByText("Workbench screen")).toBeInTheDocument();
    expect(screen.queryByText("Choose your workspace")).not.toBeInTheDocument();
  });

  it("still shows the selector when it is asked for explicitly", async () => {
    // Otherwise the preference is a one-way door.
    localStorage.setItem(SKIP_KEY, "engineering");

    renderSelector(["ENGINEER"], "/workspaces?choose=1");

    expect(await screen.findByText("Choose your workspace")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Remember my choice/i })).toBeChecked();
  });

  it("clears the preference when the box is unticked", async () => {
    localStorage.setItem(SKIP_KEY, "engineering");
    renderSelector(["ENGINEER"], "/workspaces?choose=1");
    await screen.findByText("Choose your workspace");

    await userEvent.click(screen.getByRole("checkbox", { name: /Remember my choice/i }));
    await userEvent.click(
      screen.getByRole("button", { name: /Enter Engineering workspace/i }),
    );

    expect(localStorage.getItem(SKIP_KEY)).toBeNull();
  });

  it("refuses to follow a remembered workspace the role can no longer enter", async () => {
    // The stored id is resolved against the current role every time. A
    // preference saved under a role since revoked must not route anyone into
    // a screen they may no longer use.
    localStorage.setItem(SKIP_KEY, "security");

    renderSelector(["ENGINEER"]);

    expect(await screen.findByText("Choose your workspace")).toBeInTheDocument();
    expect(screen.queryByText("Security screen")).not.toBeInTheDocument();
    expect(localStorage.getItem(SKIP_KEY)).toBeNull();
  });

  it("locks a workspace the role may not enter, with the reason", async () => {
    renderSelector(["ENGINEER"]);
    await screen.findByText("Choose your workspace");

    const locked = screen.getByRole("button", {
      name: /Security \/ Admin — not available to your role/i,
    });
    expect(locked).toBeDisabled();
    expect(screen.getByText(/Requires ADMIN or SECURITY ADMIN/i)).toBeInTheDocument();
  });
});
