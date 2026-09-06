/**
 * The session lifecycle: signing in, signing out, resuming a stored session,
 * and what happens when the stored one has expired.
 *
 * These run against the real `AuthProvider` with only `fetch` mocked, because
 * the failure that matters here is not "does the reducer work" but "does a
 * dead token put someone on the login screen instead of inside a shell full
 * of failing requests".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";
import type { Role } from "@/lib/types";

const USER = {
  id: "u1",
  email: "engineer@mrpl.local",
  name: "Arpit Pandey",
  roles: ["ENGINEER"] as Role[],
};

/**
 * A backend that answers /auth/me only for a token it considers live.
 * Returns the mock so a test can assert which calls were actually made --
 * "the expired token was not sent" needs the attempt to have been possible.
 */
function mockBackend({
  liveTokens = ["good-token"],
  expiresAt,
}: {
  liveTokens?: string[];
  expiresAt?: string;
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    const token = auth?.replace("Bearer ", "") ?? "";

    if (url.includes("/auth/login")) {
      return new Response(
        JSON.stringify({
          access_token: "good-token",
          token_type: "bearer",
          expires_at:
            expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
        { status: 200 },
      );
    }
    if (url.includes("/auth/logout")) return new Response(null, { status: 204 });

    if (!liveTokens.includes(token)) {
      return new Response(
        JSON.stringify({
          error: { code: "unauthenticated", message: "expired", details: {} },
        }),
        { status: 401 },
      );
    }
    if (url.includes("/auth/me")) {
      return new Response(JSON.stringify(USER), { status: 200 });
    }
    if (url.includes("/security/permissions")) {
      return new Response(JSON.stringify(permissionsFor(USER.roles)), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A probe that renders the auth state as text. */
function Probe() {
  const { user, loading, endedReason, expiringSoon, signIn, signOut } = useAuth();
  return (
    <div>
      <span data-testid="state">
        {loading ? "loading" : user ? `signed-in:${user.name}` : "signed-out"}
      </span>
      <span data-testid="ended">{endedReason ?? ""}</span>
      <span data-testid="warning">{expiringSoon ? "expiring" : ""}</span>
      <button onClick={() => signIn("engineer@mrpl.local", "pw")}>sign in</button>
      <button onClick={() => void signOut()}>sign out</button>
    </div>
  );
}

function renderAuth() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe("the session", () => {
  beforeEach(() => {
    tokenStore.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("signs in and stores the token with its expiry", async () => {
    mockBackend();
    renderAuth();
    await screen.findByText("signed-out");

    await userEvent.click(screen.getByRole("button", { name: "sign in" }));

    await screen.findByText(`signed-in:${USER.name}`);
    expect(tokenStore.get()).toBe("good-token");
    expect(tokenStore.expiresAt()).toBeInstanceOf(Date);
  });

  it("signs out locally even when the server call fails", async () => {
    // A failed round trip cannot be a reason to leave someone signed in on a
    // shared workstation.
    mockBackend();
    renderAuth();
    await screen.findByText("signed-out");
    await userEvent.click(screen.getByRole("button", { name: "sign in" }));
    await screen.findByText(`signed-in:${USER.name}`);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("refused")));
    await userEvent.click(screen.getByRole("button", { name: "sign out" }));

    await screen.findByText("signed-out");
    expect(tokenStore.get()).toBeNull();
  });

  it("resumes a stored session that is still valid", async () => {
    tokenStore.set("good-token", new Date(Date.now() + 3_600_000).toISOString());
    mockBackend();

    renderAuth();

    expect(await screen.findByText(`signed-in:${USER.name}`)).toBeInTheDocument();
  });

  it("discards a stored token whose stated lifetime has passed", async () => {
    // Checked locally so the reason shown is "your session expired" rather
    // than a pair of failed requests. The proof that it was not sent is that
    // the backend saw no call at all.
    tokenStore.set("good-token", new Date(Date.now() - 1000).toISOString());
    const fetchMock = mockBackend();

    renderAuth();

    await screen.findByText("signed-out");
    expect(screen.getByTestId("ended")).toHaveTextContent(/session expired/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenStore.get()).toBeNull();
  });

  it("lands on signed-out when the server rejects a stored token", async () => {
    // The clock said the token was fine; the server disagreed. The server is
    // the authority, and the outcome has to be the same.
    tokenStore.set("stale-token", new Date(Date.now() + 3_600_000).toISOString());
    const fetchMock = mockBackend({ liveTokens: ["good-token"] });

    renderAuth();

    await screen.findByText("signed-out");
    expect(fetchMock).toHaveBeenCalled();
    expect(tokenStore.get()).toBeNull();
  });

  it("warns before the session ends, then ends it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Six minutes: past the five-minute warning threshold, so the warning is
    // scheduled rather than raised immediately.
    mockBackend({ expiresAt: new Date(Date.now() + 6 * 60_000).toISOString() });

    renderAuth();
    await vi.waitFor(() => screen.getByText("signed-out"));

    await act(async () => {
      screen.getByRole("button", { name: "sign in" }).click();
    });
    await vi.waitFor(() => screen.getByText(`signed-in:${USER.name}`));
    expect(screen.getByTestId("warning")).toHaveTextContent("");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90 * 1000);
    });
    expect(screen.getByTestId("warning")).toHaveTextContent("expiring");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveTextContent("signed-out");
    });
    expect(screen.getByTestId("ended")).toHaveTextContent(/session expired/i);
  });
});
