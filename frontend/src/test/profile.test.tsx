/**
 * Profile.
 *
 * Both halves of the access split have to be there: showing what a role
 * *cannot* do is how the boundary becomes legible, and it is the screen a user
 * checks when something is refused elsewhere. The memory panel must read as
 * "awaiting a service", not as an empty list of retained facts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profile } from "@/pages/Profile";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";
import type { Role } from "@/lib/types";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mount(roles: Role[]) {
  tokenStore.set("t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "eng@b.local", name: "Arpit Pandey", roles });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor(roles));
      if (url.includes("/users/me/memory")) {
        return json({ error: { code: "not_found", message: "no", details: {} } }, 404);
      }
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Profile />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Profile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  /** The .card that contains a given field-label heading. */
  function cardFor(label: string): HTMLElement {
    const heading = screen.getByText(label);
    const card = heading.closest("div.card");
    if (!card) throw new Error(`no card for "${label}"`);
    return card as HTMLElement;
  }

  it("shows an engineer what they can and cannot do", async () => {
    mount(["ENGINEER"]);
    await screen.findByText(/Run workbench tasks/i);

    expect(within(cardFor("Granted")).getByText(/Run workbench tasks/i)).toBeInTheDocument();
    // The Security Center and model admin are not theirs — under Restricted.
    expect(
      within(cardFor("Restricted")).getByText(/Open the Security Center/i),
    ).toBeInTheDocument();
    expect(
      within(cardFor("Restricted")).getByText(/Administer models/i),
    ).toBeInTheDocument();
    expect(
      within(cardFor("Granted")).queryByText(/Open the Security Center/i),
    ).not.toBeInTheDocument();
  });

  it("gives an admin the security centre as granted, not restricted", async () => {
    mount(["ADMIN"]);
    await screen.findByText(/Open the Security Center/i);

    expect(
      within(cardFor("Granted")).getByText(/Open the Security Center/i),
    ).toBeInTheDocument();
    expect(
      within(cardFor("Restricted")).queryByText(/Open the Security Center/i),
    ).not.toBeInTheDocument();
  });

  it("presents assistant memory as awaiting its service", async () => {
    mount(["ENGINEER"]);

    expect(
      await screen.findByText(/No memory service on this deployment/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear all memory/i })).toBeDisabled();
  });
});
