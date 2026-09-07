/**
 * The sandbox panel and the task receipt, against the shapes the backend
 * actually sends.
 *
 * Both screens state facts about the running system, which makes a wrong field
 * name worse here than almost anywhere else: the panel keeps rendering, it just
 * quietly reports its own defaults instead of what the runner said. The sandbox
 * status arrives with its properties nested under `confinement`, and a runner
 * that never answered says so with `available: false` — a deployment where no
 * code can run must not present a wall of green.
 *
 * The receipt names documents and artifacts as plain strings, and records
 * refusals under `tools_denied`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Coding } from "@/pages/Coding";
import { TaskTrace } from "@/pages/TaskTrace";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ME = { id: "u1", email: "a@b.local", name: "A", roles: ["ADMIN"] };

function mount(ui: React.ReactNode, path: string, handler: (url: string) => Response | null) {
  tokenStore.set("tok");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) return json(ME);
      if (url.includes("/security/permissions")) return json(permissionsFor(["ADMIN"]));
      const answered = handler(url);
      if (answered) return answered;
      // The trace page opens an SSE stream; an empty body ends it immediately.
      return new Response("", { status: 200 });
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <Routes>
            <Route path="/tasks/:id" element={ui} />
            <Route path="*" element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the sandbox confinement panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("reports the confinement the runner states, not this screen's defaults", async () => {
    mount(<Coding />, "/coding", (url) =>
      url.includes("/internal/sandbox/status")
        ? json({
            runner: "docker",
            available: true,
            detail: "",
            image: "python:3.12-slim",
            confinement: {
              network: "none",
              root_filesystem: "read-only",
              workspace: "tmpfs, discarded after the run",
              capabilities: "all dropped, no-new-privileges",
              user: "nobody (65534)",
            },
          })
        : null,
    );

    expect(await screen.findByText("NONE")).toBeInTheDocument();
    expect(screen.getByText("read-only")).toBeInTheDocument();
    expect(screen.getByText("tmpfs, discarded after the run")).toBeInTheDocument();
    expect(screen.getByText(/all dropped, no-new-privileges · nobody \(65534\)/)).toBeInTheDocument();
    expect(screen.getByText("python:3.12-slim")).toBeInTheDocument();
    expect(screen.getByText(/docker ready/i)).toBeInTheDocument();
  });

  it("says so when the runner never answered, rather than showing a green grid", async () => {
    mount(<Coding />, "/coding", (url) =>
      url.includes("/internal/sandbox/status")
        ? json({
            runner: "docker",
            available: false,
            detail: "Docker is not reachable (DockerException).",
            image: "python:3.12-slim",
            confinement: { network: "none", root_filesystem: "read-only" },
          })
        : null,
    );

    expect(
      await screen.findByText(/is not reachable, so no code can be executed/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/docker unreachable/i)).toBeInTheDocument();
    expect(screen.getByText(/DockerException/)).toBeInTheDocument();
  });
});

describe("the task receipt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  const TASK = {
    task_id: "t1",
    id: "t1",
    conversation_id: "c1",
    user_id: "u1",
    request_text: "Write the approval note",
    task_type: "inspection_review",
    status: "completed",
    input_file_ids: [],
    error_message: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    steps: [],
  };

  const RECEIPT = {
    task_id: "t1",
    user_id: "u1",
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:00:18Z",
    events_recorded: 7,
    models_used: ["reasoner-qwen3-8b-4bit"],
    tools_used: ["docx.generate", "knowledge.search"],
    tools_denied: ["shell.exec"],
    documents_consulted: ["sop.txt"],
    artifacts: ["393ac7f5-4425-456c-9f67-209fda8a980f"],
    approvals: [],
    external_calls: 0,
    sovereignty: "INTACT",
    request: "Write the approval note",
    status: "completed",
    input_files: [],
  };

  function mountTrace() {
    mount(<TaskTrace />, "/tasks/t1", (url) => {
      if (url.includes("/tasks/t1/receipt")) return json(RECEIPT);
      if (url.includes("/tasks/t1/events")) return new Response("", { status: 200 });
      if (url.includes("/tasks/t1")) return json(TASK);
      return null;
    });
  }

  it("renders the fields the ledger actually carries", async () => {
    mountTrace();

    expect(await screen.findByText("External calls")).toBeInTheDocument();
    expect(screen.getByText("INTACT")).toBeInTheDocument();
    expect(screen.getByText("Documents consulted")).toBeInTheDocument();
    expect(screen.getByText("sop.txt")).toBeInTheDocument();
    expect(screen.getByText("reasoner-qwen3-8b-4bit")).toBeInTheDocument();
    expect(screen.getByText("393ac7f5-4425-456c-9f67-209fda8a980f")).toBeInTheDocument();
    expect(screen.getByText(/7 ledger entries recorded/i)).toBeInTheDocument();
  });

  it("states a refusal by policy rather than leaving it to be inferred", async () => {
    mountTrace();

    expect(await screen.findByText("Tools denied by policy")).toBeInTheDocument();
    expect(screen.getByText("shell.exec")).toBeInTheDocument();
  });
});
