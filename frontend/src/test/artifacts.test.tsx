/**
 * The Artifacts library.
 *
 * A failed artifact is kept and shown, not filtered out — the operator needs
 * to see what the validator objected to, and hiding it would make a
 * regeneration look like the only attempt. And download has to attach the auth
 * header: a plain link would not carry the token and the server would refuse
 * it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Artifacts } from "@/pages/Artifacts";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TASK = {
  task_id: "task-1",
  id: "task-1",
  conversation_id: "c1",
  user_id: "u1",
  request_text: "Write the approval note",
  task_type: "report",
  status: "completed",
  input_file_ids: [],
  error_message: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function mount(artifacts: unknown[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  tokenStore.set("tok-123");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "a@b.local", name: "A", roles: ["ENGINEER"] });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor(["ENGINEER"]));
      if (url.includes("/tasks/task-1/artifacts")) return json({ artifacts });
      if (url.includes("/api/v1/tasks")) {
        return json({ items: [TASK], total: 1, limit: 25, offset: 0 });
      }
      if (url.includes("/artifacts/") && url.includes("/download")) {
        return new Response("PK fake docx", { status: 200 });
      }
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Artifacts />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("the Artifacts library", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("keeps a failed artifact and shows why it failed, in plain language", async () => {
    mount([
      {
        id: "a1",
        filename: "approval_note.docx",
        validation_status: "failed",
        validation_detail: [
          {
            check: "citations",
            result: "failed",
            message: "Cited a document that was not retrieved: Imaginary Standard.pdf",
          },
        ],
      },
    ]);

    expect(await screen.findByText("approval_note.docx")).toBeInTheDocument();
    expect(screen.getByText(/Validation failed/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Cited a document that was not retrieved: Imaginary Standard\.pdf/i),
    ).toBeInTheDocument();
  });

  it("attaches the auth header when downloading", async () => {
    const calls = mount([
      { id: "a1", filename: "report.docx", validation_status: "passed", validation_detail: [] },
    ]);

    await userEvent.click(await screen.findByRole("button", { name: /download/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/api/v1/artifacts/a1/download"))).toBe(true),
    );
    const dl = calls.find((c) => c.url.includes("/api/v1/artifacts/a1/download"))!;
    const headers = (dl.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
  });
});
