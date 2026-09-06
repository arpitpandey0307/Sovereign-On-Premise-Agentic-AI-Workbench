/**
 * The Workbench send flow and the approval gate.
 *
 * Two things here would be invisible to a screenshot test and expensive to get
 * wrong. The send path has to create the task with the attached file ids, not
 * silently drop them. And Approve and Reject have to send the literal
 * `approved` value the button stands for — inverting that would let a rejection
 * resume a task, which is about the worst bug this screen could ship.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workbench } from "@/pages/Workbench";
import { tokenStore } from "@/lib/api";

/** An SSE response whose body is the given records, then closes. */
function sseResponse(records: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const record of records) controller.enqueue(encoder.encode(record));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function record(event: string, data: Record<string, unknown> = {}) {
  return `event: ${event}\ndata: ${JSON.stringify({
    task_id: "task-1",
    event,
    component: "orchestrator",
    timestamp: "2026-01-01T00:00:00Z",
    data,
  })}\n\n`;
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function mountWorkbench(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
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
      <MemoryRouter initialEntries={["/workbench"]}>
        <Routes>
          <Route path="/workbench" element={<Workbench />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the Workbench", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("creates the task with the request text and attached file ids", async () => {
    const calls = mountWorkbench((url) => {
      if (url.includes("/files/upload")) return json({ id: "file-9", filename: "report.pdf" });
      if (url.endsWith("/conversations")) return json({ id: "conv-1" });
      if (url.includes("/conversations/conv-1/messages")) return json({});
      if (url.endsWith("/tasks")) return json({ task_id: "task-1", status: "planning" });
      if (url.includes("/tasks/task-1/events")) return sseResponse([record("task_created")]);
      if (url.includes("/tasks/task-1")) return json({ task_id: "task-1", status: "planning", request_text: "check psv-107", conversation_id: "conv-1" });
      return json({});
    });

    // Attach a file.
    await userEvent.click(screen.getByRole("button", { name: /attach a file/i }));
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(picker, new File(["x"], "report.pdf", { type: "application/pdf" }));
    await screen.findByText("report.pdf");

    // Ask the question.
    await userEvent.type(screen.getByRole("textbox"), "check psv-107");
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/api/v1/tasks") && c.init?.method === "POST")).toBe(true);
    });

    const taskCall = calls.find((c) => c.url.endsWith("/api/v1/tasks") && c.init?.method === "POST")!;
    const body = JSON.parse(String(taskCall.init?.body));
    expect(body).toMatchObject({
      conversation_id: "conv-1",
      request_text: "check psv-107",
      input_file_ids: ["file-9"],
    });
  });

  it.each([
    ["Approve", true],
    ["Reject", false],
  ])("%s sends approved=%s to resume", async (label, approved) => {
    const calls = mountWorkbench((url) => {
      if (url.endsWith("/conversations")) return json({ id: "conv-1" });
      if (url.includes("/messages")) return json({});
      if (url.endsWith("/tasks")) return json({ task_id: "task-1", status: "planning" });
      if (url.includes("/tasks/task-1/events")) {
        return sseResponse([
          record("task_created"),
          record("model_selected", { model_id: "m1" }),
          record("reasoning_completed", { output_text: "draft note" }),
          record("approval_requested", { reason: "artifact export" }),
        ]);
      }
      if (url.includes("/tasks/task-1/resume")) return json({ task_id: "task-1", status: "running" });
      if (url.includes("/tasks/task-1")) {
        return json({ task_id: "task-1", status: "waiting_approval", request_text: "x", conversation_id: "conv-1" });
      }
      return json({});
    });

    await userEvent.type(screen.getByRole("textbox"), "export the note");
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));

    await userEvent.click(await screen.findByRole("button", { name: label }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/tasks/task-1/resume"))).toBe(true);
    });
    const resumeCall = calls.find((c) => c.url.includes("/tasks/task-1/resume"))!;
    expect(JSON.parse(String(resumeCall.init?.body))).toMatchObject({ approved });
  });

  it("shows the failure instead of a spinner when the task fails", async () => {
    mountWorkbench((url) => {
      if (url.endsWith("/conversations")) return json({ id: "conv-1" });
      if (url.includes("/messages")) return json({});
      if (url.endsWith("/tasks")) return json({ task_id: "task-1", status: "planning" });
      if (url.includes("/tasks/task-1/events")) {
        return sseResponse([
          record("task_created"),
          record("task_failed", { message: "The model runtime did not respond." }),
        ]);
      }
      if (url.includes("/tasks/task-1")) {
        return json({ task_id: "task-1", status: "failed", request_text: "x", conversation_id: "conv-1", error_message: "The model runtime did not respond." });
      }
      return json({});
    });

    await userEvent.type(screen.getByRole("textbox"), "do the thing");
    await userEvent.click(screen.getByRole("button", { name: /run task/i }));

    // The failure is stated (it appears both on the failed stage and as a
    // callout); what matters is that it is shown at all and the spinner is gone.
    const shown = await screen.findAllByText(/model runtime did not respond/i);
    expect(shown.length).toBeGreaterThan(0);
    expect(document.querySelector(".risk-callout.danger")).not.toBeNull();
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });
});
