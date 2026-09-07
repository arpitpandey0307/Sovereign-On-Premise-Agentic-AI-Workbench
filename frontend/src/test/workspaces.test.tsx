/**
 * "Who are you signing in as?", and the sign-in that settles the answer.
 *
 * The flow the product runs: the landing page sends everyone here, someone
 * states the role they hold, and only then do they sign in. Three things
 * matter and none of them is cosmetic.
 *
 * Stating a role must never be a route to privilege. Before sign-in this
 * screen has no idea who is looking at it, so it offers every role —
 * disabling any would both leak the shape of the organisation and be a lie.
 * The claim is settled at sign-in, against the roles the server returns.
 *
 * A refusal has to say so. Someone who says Security Administrator and signs
 * in as an engineer must land back here with the reason and their real
 * identities, not be dropped silently somewhere they did not ask for.
 *
 * And an account holding one role is not making a choice, so it does not get a
 * screen with one button on it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { Workspaces } from "@/pages/Workspaces";
import { Login } from "@/pages/Login";
import { workspaceIntent } from "@/lib/access";
import { permissionsFor } from "@/test/roles";
import type { Role } from "@/lib/types";

/** Shows where the router ended up, so a redirect is assertable. */
function Where() {
  const location = useLocation();
  return (
    <p data-testid="where">{location.pathname + location.search}</p>
  );
}

/**
 * @param roles  what the server will say when credentials are presented
 * @param signedIn  whether a session already exists when the screen opens
 */
function renderFlow(
  roles: Role[],
  { signedIn = false, entry = "/workspaces" } = {},
) {
  const user = { id: "u1", email: "a@b.local", name: "Arpit Pandey", roles };
  if (signedIn) tokenStore.set("test-token");

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/login")) {
        return new Response(
          JSON.stringify({
            access_token: "test-token",
            token_type: "bearer",
            expires_at: "2030-01-01T00:00:00Z",
          }),
          { status: 200 },
        );
      }
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
          <Where />
          <Routes>
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="/login" element={<Login />} />
            <Route path="/workbench" element={<p>Workbench screen</p>} />
            <Route path="/security" element={<p>Security screen</p>} />
            <Route path="/approvals" element={<p>Approvals screen</p>} />
            <Route path="/dashboard" element={<p>Dashboard screen</p>} />
            <Route path="/" element={<p>Landing screen</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function signIn() {
  await userEvent.type(
    await screen.findByLabelText(/Corporate ID/i),
    "a@b.local",
  );
  await userEvent.type(screen.getByLabelText(/Password/i), "hunter2");
  await userEvent.click(screen.getByRole("button", { name: /Sign In/i }));
}

describe("signing in as a role", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
    workspaceIntent.clear();
  });

  it("offers every role to an anonymous visitor, none of them disabled", async () => {
    renderFlow(["ENGINEER"]);

    const card = await screen.findByRole("button", {
      name: /Sign in as Security Administrator/i,
    });
    // It cannot know who this is yet, so it must not pretend to.
    expect(card).toBeEnabled();
    expect(screen.getByRole("button", { name: /Sign in as Engineer/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Sign in as Analyst/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Sign in as Administrator/i })).toBeEnabled();
  });

  it("carries the stated role to sign-in, and names it there", async () => {
    renderFlow(["ENGINEER"]);

    await userEvent.click(
      await screen.findByRole("button", { name: /Sign in as Engineer/i }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        "/login?workspace=engineer",
      ),
    );
    expect(screen.getByText(/Signing in as/i)).toBeInTheDocument();
    expect(screen.getByText("Engineer")).toBeInTheDocument();
  });

  it("admits an engineer who said they were one", async () => {
    renderFlow(["ENGINEER"], { entry: "/login?workspace=engineer" });

    await signIn();

    expect(await screen.findByText("Dashboard screen")).toBeInTheDocument();
  });

  it("refuses a role the account does not hold, and says which one", async () => {
    // The whole point of the flow: the claim is settled by the credentials.
    renderFlow(["ENGINEER"], { entry: "/login?workspace=security" });

    await signIn();

    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        "/workspaces?denied=security",
      ),
    );
    expect(
      await screen.findByText(/does not hold/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Security screen")).not.toBeInTheDocument();
  });

  it("shows the refused engineer only the identities the account holds", async () => {
    renderFlow(["ENGINEER"], {
      signedIn: true,
      entry: "/workspaces?denied=security",
    });

    expect(
      await screen.findByRole("button", { name: /Sign in as Engineer/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sign in as Security Administrator/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sign in as Administrator/i }),
    ).not.toBeInTheDocument();
    // An engineer is not an analyst either, even though both are "employee".
    expect(
      screen.queryByRole("button", { name: /Sign in as Analyst/i }),
    ).not.toBeInTheDocument();
  });

  it("admits a security administrator who said they were one", async () => {
    renderFlow(["SECURITY_ADMIN"], { entry: "/login?workspace=security" });

    await signIn();

    expect(await screen.findByText("Security screen")).toBeInTheDocument();
  });

  it("does not stop a single-role account on a screen with one button", async () => {
    // An engineer holds exactly one identity; asking them to pick it is noise.
    renderFlow(["ENGINEER"], { signedIn: true });

    expect(await screen.findByText("Dashboard screen")).toBeInTheDocument();
  });

  it("still shows the chooser to that role when it is asked for", async () => {
    renderFlow(["ENGINEER"], { signedIn: true, entry: "/workspaces?choose=1" });

    expect(
      await screen.findByRole("heading", { name: /Continue as/i }),
    ).toBeInTheDocument();
  });

  it("lets an account holding several actually choose between them", async () => {
    // The seeded demo account is exactly this shape.
    renderFlow(["ADMIN", "ENGINEER"], { signedIn: true });

    await userEvent.click(
      await screen.findByRole("button", { name: /Sign in as Engineer/i }),
    );

    expect(await screen.findByText("Dashboard screen")).toBeInTheDocument();
  });

  it("sends someone signing in with nothing stated to their own home", async () => {
    renderFlow(["SECURITY_ADMIN"], { entry: "/login" });

    await signIn();

    // Not a dashboard they have no data for.
    expect(await screen.findByText("Security screen")).toBeInTheDocument();
  });
});
