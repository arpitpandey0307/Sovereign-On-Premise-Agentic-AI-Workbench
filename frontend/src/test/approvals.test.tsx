/**
 * Approval Requests.
 *
 * The one bug that would really matter here is Approve and Reject sending the
 * wrong `approved` value — a rejection that resumed a task, or an approval that
 * killed one. Neither is visible in a screenshot, so it is pinned here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Approvals } from "@/pages/Approvals";
import { tokenStore } from "@/lib/api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const WAITING = {
  items: [
    {
      task_id: "task-7",
      id: "task-7",
      conversation_id: "c1",
      user_id: "u1",
      request_text: "Export the relief-valve design basis to a removable drive for the vendor.",
      task_type: "export",
      status: "waiting_approval",
      input_file_ids: [],
      error_message: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:05:00Z",
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

function mount(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Approvals />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("Approval Requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("asks only for tasks waiting on approval", async () => {
    const calls = mount(() => json(WAITING));
    await screen.findByText(/Export the relief-valve design basis/i);
    // The screen now also loads the access-request queue, so the task fetch
    // is one of several rather than the first. What matters is that it asks
    // only for tasks that are actually waiting, not which order it asks in.
    expect(
      calls.some((call) => /status=waiting_approval/.test(call.url)),
    ).toBe(true);
  });

  it("says so plainly when nothing is waiting", async () => {
    mount(() => json({ items: [], total: 0, limit: 50, offset: 0 }));
    expect(
      await screen.findByText(/Nothing is waiting for your approval/i),
    ).toBeInTheDocument();
  });

  it.each([
    ["Approve", true, /Approved —/i],
    ["Reject", false, /Rejected —/i],
  ])("%s posts approved=%s and confirms", async (label, approved, confirmation) => {
    const calls = mount((url) => {
      if (url.includes("/tasks/task-7/resume")) return json({ status: "running" });
      if (url.includes("/api/v1/tasks")) return json(WAITING);
      return json({});
    });

    await userEvent.click(await screen.findByRole("button", { name: label }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/tasks/task-7/resume"))).toBe(true),
    );
    const resume = calls.find((c) => c.url.includes("/tasks/task-7/resume"))!;
    expect(JSON.parse(String(resume.init?.body))).toMatchObject({ approved });
    expect(await screen.findByText(confirmation)).toBeInTheDocument();
  });
});
