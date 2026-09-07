/**
 * Session history, split by the surface that produced it.
 *
 * A conversation belongs to whichever workspace made it: a session whose tasks
 * were `coding` is the coding workspace's, everything else is the AI
 * workbench's. Scrolling past a dozen document questions to find yesterday's
 * script is the problem this avoids, and getting the split backwards would
 * silently hide someone's work in the other room.
 *
 * The backend has no conversation *kind*, so it is derived from the tasks each
 * conversation produced — which makes this worth pinning rather than assuming.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChatHistory } from "@/components/shell/ChatHistory";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";

const CONVERSATIONS = [
  { id: "c-ai", user_id: "u1", title: "Pump seal review", created_at: "2026-01-03T00:00:00Z" },
  { id: "c-code", user_id: "u1", title: "Rolling mean script", created_at: "2026-01-02T00:00:00Z" },
  { id: "c-new", user_id: "u1", title: "Untouched session", created_at: "2026-01-01T00:00:00Z" },
];

function task(id: string, conversation: string, type: string) {
  return {
    task_id: id,
    id,
    conversation_id: conversation,
    user_id: "u1",
    request_text: "…",
    task_type: type,
    status: "completed",
    input_file_ids: [],
    error_message: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const TASKS = [
  task("t1", "c-ai", "inspection_review"),
  task("t2", "c-code", "coding"),
  // c-new has produced nothing yet.
];

function mount(kind: "ai" | "coding") {
  tokenStore.set("tok");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return new Response(
          JSON.stringify({ id: "u1", email: "a@b.local", name: "A", roles: ["ADMIN"] }),
          { status: 200 },
        );
      }
      if (url.includes("/security/permissions")) {
        return new Response(JSON.stringify(permissionsFor(["ADMIN"])), { status: 200 });
      }
      if (url.includes("/conversations")) {
        return new Response(
          JSON.stringify({ items: CONVERSATIONS, total: 3, limit: 50, offset: 0 }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/tasks")) {
        return new Response(
          JSON.stringify({ items: TASKS, total: 2, limit: 100, offset: 0 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <ChatHistory kind={kind} collapsed={false} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("session history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("shows the workbench only its own sessions", async () => {
    mount("ai");

    expect(await screen.findByText("Pump seal review")).toBeInTheDocument();
    expect(screen.queryByText("Rolling mean script")).not.toBeInTheDocument();
  });

  it("shows the coding workspace only its own sessions", async () => {
    mount("coding");

    expect(await screen.findByText("Rolling mean script")).toBeInTheDocument();
    expect(screen.queryByText("Pump seal review")).not.toBeInTheDocument();
  });

  it("leaves an untouched session on whichever surface is asking", async () => {
    // It has produced no tasks, so nothing yet says which kind it is. Hiding it
    // from both would lose a session someone had just started.
    mount("ai");
    expect(await screen.findByText("Untouched session")).toBeInTheDocument();
  });

  it("and shows that same untouched session to the coding workspace too", async () => {
    mount("coding");
    expect(await screen.findByText("Untouched session")).toBeInTheDocument();
  });

  it("links each session to the surface it belongs to", async () => {
    mount("coding");

    const link = await screen.findByTitle("Rolling mean script");
    expect(link).toHaveAttribute("href", "/coding?conversation=c-code");
  });

  it("labels the list for the surface it is showing", async () => {
    mount("coding");
    expect(await screen.findByText("Coding sessions")).toBeInTheDocument();
  });
});
