/**
 * The Artifacts library.
 *
 * A failed artifact is kept and shown, not filtered out — the operator needs
 * to see what the validator objected to, and hiding it would make a
 * regeneration look like the only attempt. And download has to attach the auth
 * header: a plain link would not carry the token and the server would refuse
 * it.
 *
 * The fixtures here are the shapes the backend actually returns, verified
 * against a running instance: `/tasks/{id}/artifacts` answers with a bare
 * array of `{artifact_id, task_id, type, validation_status, download_url}`
 * and the validator's individual checks live on the execution trace. An
 * earlier version of this file mocked an `{artifacts: [...]}` envelope with
 * filenames on it, which is why the page could be permanently empty against
 * the real API while its tests passed.
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

function mount(artifacts: unknown[], checks: unknown[] = []) {
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
      // A bare array, as the backend sends it.
      if (url.includes("/tasks/task-1/artifacts")) return json(artifacts);
      if (url.includes("/tasks/task-1/execution")) {
        return json({
          validation: {
            passed: checks.every((c) => (c as { ok: boolean }).ok),
            checks,
            failures: [],
          },
        });
      }
      if (url.includes("/api/v1/tasks")) {
        return json({ items: [TASK], total: 1, limit: 25, offset: 0 });
      }
      if (url.includes("/artifacts/") && url.includes("/download")) {
        return new Response("PK fake docx", { status: 200 });
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

  it("lists an artifact returned as a bare array, not an envelope", async () => {
    mount([
      {
        artifact_id: "a1",
        task_id: "task-1",
        type: "docx",
        validation_status: "passed",
        download_url: "/api/v1/artifacts/a1/download",
      },
    ]);

    expect(await screen.findByText(/DOCX deliverable/i)).toBeInTheDocument();
    expect(screen.getByText(/Validated/i)).toBeInTheDocument();
  });

  it("keeps a failed artifact and shows why it failed, in plain language", async () => {
    mount(
      [
        {
          artifact_id: "a1",
          task_id: "task-1",
          type: "docx",
          validation_status: "failed",
          download_url: "/api/v1/artifacts/a1/download",
        },
      ],
      [
        {
          check: "citations point at retrieved evidence",
          ok: false,
          detail: "Cited a document that was not retrieved: Imaginary Standard.pdf",
        },
      ],
    );

    expect(await screen.findByText(/DOCX deliverable/i)).toBeInTheDocument();
    expect(screen.getByText(/Validation failed/i)).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Cited a document that was not retrieved: Imaginary Standard\.pdf/i,
      ),
    ).toBeInTheDocument();
  });

  it("attaches the auth header when downloading", async () => {
    const calls = mount([
      {
        artifact_id: "a1",
        task_id: "task-1",
        type: "docx",
        validation_status: "passed",
        download_url: "/api/v1/artifacts/a1/download",
      },
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
