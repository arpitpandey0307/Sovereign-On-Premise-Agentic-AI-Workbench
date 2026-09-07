/**
 * The workspace chooser, and the sign-in that settles the claim it makes.
 *
 * The flow the product now runs: the landing page sends everyone here, someone
 * says which part of the plant they work in, and only then do they sign in.
 * Three things matter and none of them is cosmetic.
 *
 * Choosing must never be a route to privilege. Before sign-in this screen has
 * no idea who is looking at it, so it offers every workspace — disabling them
 * would both leak the shape of the organisation and be a lie. The claim is
 * settled at sign-in, against the role the server returns.
 *
 * A refusal has to say so. Someone who picks Security and signs in as an
 * engineer must land back here with the reason and their real options, not be
 * dropped silently on a dashboard they did not ask for.
 *
 * And a role with one workspace is not making a choice, so it does not get a
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

describe("the workspace chooser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
    workspaceIntent.clear();
  });

  it("offers every workspace to an anonymous visitor, none of them disabled", async () => {
    renderFlow(["ENGINEER"]);

    const card = await screen.findByRole("button", {
      name: /Enter the Security & Audit workspace/i,
    });
    // It cannot know who this is yet, so it must not pretend to.
    expect(card).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Enter the Engineering & Operations/i }),
    ).toBeEnabled();
  });

  it("sends the choice to sign-in, naming the workspace being entered", async () => {
    renderFlow(["ENGINEER"]);

    await userEvent.click(
      await screen.findByRole("button", {
        name: /Enter the Engineering & Operations workspace/i,
      }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        "/login?workspace=engineering",
      ),
    );
    expect(screen.getByText(/Signing in to/i)).toBeInTheDocument();
    expect(screen.getByText("Engineering & Operations")).toBeInTheDocument();
  });

  it("admits an engineer to the workspace they chose", async () => {
    renderFlow(["ENGINEER"], { entry: "/login?workspace=engineering" });

    await signIn();

    expect(await screen.findByText("Dashboard screen")).toBeInTheDocument();
  });

  it("refuses a workspace the role does not hold, and says which one", async () => {
    // The whole point of the flow: the claim is settled by the credentials.
    renderFlow(["ENGINEER"], { entry: "/login?workspace=security" });

    await signIn();

    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        "/workspaces?denied=security",
      ),
    );
    expect(
      await screen.findByText(/not admitted to/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Security screen")).not.toBeInTheDocument();
  });

  it("shows the refused engineer only the workspaces they do hold", async () => {
    renderFlow(["ENGINEER"], {
      signedIn: true,
      entry: "/workspaces?denied=security",
    });

    expect(
      await screen.findByRole("button", {
        name: /Enter the Engineering & Operations workspace/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Enter the Security & Audit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Enter the Administration/i }),
    ).not.toBeInTheDocument();
  });

  it("admits a security administrator to the security workspace", async () => {
    renderFlow(["SECURITY_ADMIN"], { entry: "/login?workspace=security" });

    await signIn();

    expect(await screen.findByText("Security screen")).toBeInTheDocument();
  });

  it("does not stop a single-workspace role on a screen with one button", async () => {
    // An engineer holds exactly one workspace; asking them to pick it is noise.
    renderFlow(["ENGINEER"], { signedIn: true });

    expect(await screen.findByText("Dashboard screen")).toBeInTheDocument();
  });

  it("still shows the chooser to that role when it is asked for", async () => {
    renderFlow(["ENGINEER"], { signedIn: true, entry: "/workspaces?choose=1" });

    expect(
      await screen.findByRole("heading", { name: /Choose your workspace/i }),
    ).toBeInTheDocument();
  });

  it("lets an administrator, who holds several, actually choose", async () => {
    renderFlow(["ADMIN"], { signedIn: true });

    await userEvent.click(
      await screen.findByRole("button", {
        name: /Enter the Security & Audit workspace/i,
      }),
    );

    expect(await screen.findByText("Security screen")).toBeInTheDocument();
  });

  it("sends someone signing in with no workspace chosen to their own home", async () => {
    renderFlow(["SECURITY_ADMIN"], { entry: "/login" });

    await signIn();

    // Not a dashboard they have no data for.
    expect(await screen.findByText("Security screen")).toBeInTheDocument();
  });
});
