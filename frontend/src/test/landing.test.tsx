/**
 * The landing page.
 *
 * Three things are worth holding still here. The page has to be complete with
 * every animation disabled -- a reader with reduced motion must get the
 * argument, not a set of empty boxes. "Enter Workbench" is the only real logic
 * on the page and sending a signed-in visitor back to a login form would
 * suggest their session was never real. And the metric counters have to land
 * on their stated values: a sovereignty panel reading 99% because an easing
 * curve ran out of time is worse than no animation at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Landing from "@/pages/landing/Landing";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";
import type { Role } from "@/lib/types";

/** Answer the media queries the page asks about. */
function stubMedia({ reducedMotion = false, narrow = false } = {}) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion")
        ? reducedMotion
        : query.includes("max-width")
          ? narrow
          : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }),
  });
}

function renderLanding({ signedIn = false }: { signedIn?: boolean } = {}) {
  const roles: Role[] = ["ENGINEER"];
  if (signedIn) {
    tokenStore.set("token", new Date(Date.now() + 3_600_000).toISOString());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/auth/me")) {
          return new Response(
            JSON.stringify({ id: "u1", email: "a@b.local", name: "A", roles }),
            { status: 200 },
          );
        }
        if (url.includes("/security/permissions")) {
          return new Response(JSON.stringify(permissionsFor(roles)), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
  } else {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  }

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<p>Sign-in screen</p>} />
            <Route path="/dashboard" element={<p>Dashboard screen</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the landing page", () => {
  beforeEach(() => {
    tokenStore.clear();
    stubMedia();
  });

  it("is complete with every animation disabled", async () => {
    // The requirement is not "the animations are skipped" but "the page still
    // makes its argument". Every section heading has to be readable.
    stubMedia({ reducedMotion: true });
    renderLanding();

    expect(
      await screen.findByText(
        /Private intelligence for confidential industrial work/i,
      ),
    ).toBeInTheDocument();

    for (const heading of [
      "Why Sovereign AI?",
      "One Workbench. Multiple AI Capabilities.",
      "How It Works",
      "Built for Industrial Work",
      "Sovereignty by Design",
      "From AI Assistant to AI Workbench",
      "Enter the Sovereign Workbench",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }

    // The trust chips and the pipeline's text equivalent are part of the
    // argument, not decoration.
    expect(screen.getByText("ZERO EGRESS")).toBeInTheDocument();
    expect(
      screen.getByText(/How the workbench handles a document, in 5 stages/i),
    ).toBeInTheDocument();
  });

  it("sends a signed-out visitor to sign in", async () => {
    renderLanding();

    await userEvent.click(
      await screen.findByRole("button", { name: /Enter Secure Workbench/i }),
    );

    expect(await screen.findByText("Sign-in screen")).toBeInTheDocument();
  });

  it("sends a visitor with a live session straight to the workbench", async () => {
    // Bouncing someone who is already signed in back to a login form reads as
    // the session not having been real.
    renderLanding({ signedIn: true });
    await screen.findByText(/Private intelligence/i);

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /Enter Workbench/i }).length,
      ).toBeGreaterThan(0),
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /Enter Workbench/i })[0],
    );

    expect(await screen.findByText("Dashboard screen")).toBeInTheDocument();
  });

  it("lands the metric counters on their stated values", async () => {
    renderLanding();

    // 100% is the one that counts up; the zeros and BLOCKED are stated
    // outright. All four have to be exact -- they are the product's claims.
    expect(await screen.findByText("100%")).toBeInTheDocument();
    expect(screen.getByText("BLOCKED")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(2);
  });

  it("states plainly that the installer is not published", async () => {
    // A download button that 404s in front of a reviewer costs more than the
    // button gains, so it has to explain itself instead of linking anywhere.
    renderLanding();

    await userEvent.click(
      await screen.findByRole("button", { name: /Download for on-premise/i }),
    );

    expect(
      await screen.findByText(/on-premise installer is still being packaged/i),
    ).toBeInTheDocument();
  });

  it("links nowhere broken", async () => {
    renderLanding();
    await screen.findByText(/Private intelligence/i);

    for (const link of screen.getAllByRole("link")) {
      const href = link.getAttribute("href") ?? "";
      expect(href).not.toBe("");
      expect(href).not.toBe("#");
      // Every in-page anchor must point at a section that exists.
      if (href.startsWith("#") && href !== "#top") {
        expect(document.getElementById(href.slice(1))).not.toBeNull();
      }
    }
  });

  it("simplifies the pipeline rather than shrinking it on a phone", async () => {
    // Five labels at phone width are a grey smear, so the diagram drops to
    // three stages instead.
    stubMedia({ narrow: true });
    renderLanding();

    expect(
      await screen.findByText(/How the workbench handles a document, in 3 stages/i),
    ).toBeInTheDocument();
  });
});
