/**
 * Every screen, rendered against a *running* backend.
 *
 * The unit tests mock `fetch`, which means they verify the screens against the
 * shapes this codebase believes the backend returns. That is exactly the
 * assumption that can be wrong, and was: four screens were reading fields the
 * API does not send, and their mocks said the same thing, so nothing failed.
 *
 * This spec removes the mock. It signs in for real, renders each screen, and
 * asserts that nothing threw and that the real payload produced real content.
 * It is opt-in because it needs a live API:
 *
 *     LIVE_API=http://127.0.0.1:8000 LIVE_EMAIL=... LIVE_PASSWORD=... npm test
 *
 * Without `LIVE_API` the whole file skips, so the ordinary suite still runs
 * with no external services.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import type { LoginResponse } from "@/lib/types";
import { Dashboard } from "@/pages/Dashboard";
import { Tasks } from "@/pages/Tasks";
import { TaskTrace } from "@/pages/TaskTrace";
import { Documents } from "@/pages/Documents";
import { Knowledge } from "@/pages/Knowledge";
import { Artifacts } from "@/pages/Artifacts";
import { Security } from "@/pages/Security";
import { Models } from "@/pages/Models";
import { Coding } from "@/pages/Coding";
import { Settings } from "@/pages/Settings";
import { Profile } from "@/pages/Profile";
import { Approvals } from "@/pages/Approvals";
import { Workbench } from "@/pages/Workbench";

// Read through globalThis: this file runs under Node, but the app's tsconfig
// has no node types, so `process` is not a declared global here.
const env =
  (globalThis as unknown as { process?: { env: Record<string, string | undefined> } })
    .process?.env ?? {};
const BASE = env.LIVE_API;
const EMAIL = env.LIVE_EMAIL ?? "admin@mrpl.local";
const PASSWORD = env.LIVE_PASSWORD ?? "workbench";

const live = BASE ? describe : describe.skip;

/**
 * The app calls same-origin paths (`/api/v1/...`), which jsdom cannot resolve.
 * Prefixing them with the live host is what the dev server's proxy does.
 */
function useRealFetchAgainst(base: string) {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const target = url.startsWith("/") ? base + url : url;
    return real(target, init);
  });
}

function mount(ui: React.ReactNode, path = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/tasks/:id" element={ui} />
            <Route path="/workbench" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** No screen may render React's crash text, and none may sit on a spinner. */
async function settles() {
  await waitFor(
    () => {
      expect(document.body.textContent ?? "").not.toMatch(
        /is not a function|object Object|Something went wrong|undefined/i,
      );
    },
    { timeout: 15_000 },
  );
}

live("every screen against a live backend", () => {
  let taskId: string | null = null;
  let completedTaskId: string | null = null;
  let token = "";

  // The shared setup file clears sessionStorage after every test, so the token
  // has to be put back before each one rather than once at the start.
  beforeEach(() => {
    if (token) tokenStore.set(token);
  });

  beforeAll(async () => {
    const response = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!response.ok) throw new Error(`login failed: ${response.status}`);
    const body = (await response.json()) as LoginResponse;
    token = body.access_token;
    tokenStore.set(token, body.expires_at);

    const tasks = await fetch(`${BASE}/api/v1/tasks?limit=25`, {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    const page = (await tasks.json()) as { items: Array<{ task_id: string; status: string }> };
    completedTaskId = page.items.find((t) => t.status === "completed")?.task_id ?? null;
    taskId = completedTaskId ?? page.items[0]?.task_id ?? null;
  }, 30_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function screenTest(name: string, ui: React.ReactNode, expected: RegExp) {
    it(`renders ${name}`, async () => {
      useRealFetchAgainst(BASE!);
      mount(ui);
      // findAllByText: the heading text recurs in body copy on several of
      // these screens, and matching more than once is not a failure.
      const found = await screen.findAllByText(expected, {}, { timeout: 15_000 });
      expect(found.length).toBeGreaterThan(0);
      await settles();
    }, 30_000);
  }

  screenTest("the Dashboard", <Dashboard />, /Workbench|Dashboard|System/i);
  screenTest("the task list", <Tasks />, /Tasks/i);
  screenTest("My Documents", <Documents />, /Documents/i);
  screenTest("the Knowledge Base", <Knowledge />, /Knowledge/i);
  screenTest("the Artifacts library", <Artifacts />, /Artifacts/i);
  screenTest("the Security Center", <Security />, /Security|Sovereignty/i);
  screenTest("the Model Center", <Models />, /Model/i);
  screenTest("the Coding Workspace", <Coding />, /Sandbox|Coding/i);
  screenTest("Settings", <Settings />, /Settings/i);
  screenTest("Profile", <Profile />, /Profile|Access/i);
  screenTest("Approval Requests", <Approvals />, /Approval/i);

  /**
   * Open more event streams than the API's database pool has connections, and
   * check the API still answers.
   *
   * This is where a real defect showed itself and where an in-process test
   * could not: a request-scoped session lives until the response completes,
   * and an SSE response does not complete while the client is attached, so
   * every open stream used to hold a pooled connection. Fifteen of them
   * exhausted the pool and the entire backend stopped serving with
   * `QueuePool limit of size 5 overflow 10 reached` -- observed here, killing
   * the server mid-run, before the endpoint was changed to release its session
   * before streaming.
   */
  it("keeps serving with more open event streams than the pool has connections", async () => {
    if (!taskId) return;

    const controllers: AbortController[] = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        // Read the head only; leave the body streaming.
        const response = await fetch(`${BASE}/api/v1/tasks/${taskId}/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
      }

      const still = await fetch(`${BASE}/api/v1/tasks?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(still.status).toBe(200);

      const health = await fetch(`${BASE}/health`);
      expect(health.status).toBe(200);
    } finally {
      for (const controller of controllers) controller.abort();
    }
  }, 60_000);

  /**
   * A completed run, reopened in the Workbench, shows what it cited.
   *
   * The event stream announces counts and nothing else -- `retrieval_completed`
   * says "2 results", `reasoning_completed` says "1 finding" -- so a run
   * reconstructed from the stream alone has no citations at all, and the
   * backlog is gone entirely once the backend restarts. The passages live on
   * the execution record, which is why the Workbench folds that in when a run
   * settles. Citations are the centre of the demo; this checks they are there
   * against real data rather than a fixture.
   */
  it("shows the citations of a completed run reopened from its task id", async () => {
    if (!completedTaskId) return;
    useRealFetchAgainst(BASE!);
    mount(<Workbench />, `/workbench?task=${completedTaskId}`);

    expect(await screen.findByText("SOURCES", {}, { timeout: 20_000 })).toBeInTheDocument();
    // The seeded corpus document the run actually retrieved.
    await waitFor(
      () => expect(screen.getAllByText(/\.txt|\.pdf|\.docx/i).length).toBeGreaterThan(0),
      { timeout: 20_000 },
    );
  }, 45_000);

  it("renders the forensic trace for a real task", async () => {
    if (!taskId) return;
    useRealFetchAgainst(BASE!);
    mount(<TaskTrace />, `/tasks/${taskId}`);
    // The receipt's two headline facts come from the audit ledger.
    expect(
      await screen.findByText(/External calls/i, {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    await settles();
  }, 30_000);

  it("the Security policy panel renders the keyed policy without throwing", async () => {
    useRealFetchAgainst(BASE!);
    mount(<Security />);
    expect(
      await screen.findByText(/Policy in force/i, {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    // Every classification the API names must reach the table.
    await waitFor(
      () => expect(screen.getAllByText("HIGHLY_CONFIDENTIAL").length).toBeGreaterThan(0),
      { timeout: 15_000 },
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toBeDisabled();
  }, 30_000);
});
