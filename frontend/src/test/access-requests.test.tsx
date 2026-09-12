/**
 * The refusal-to-request loop.
 *
 * What is worth pinning here is not that a form renders. It is that a 403 on
 * the knowledge base produces somewhere to ask rather than an apology, that a
 * reason is genuinely required before anything can be sent, and that the
 * approver sees the asker's own words and has to choose how long a grant lasts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccessQueue } from "@/components/access/AccessQueue";
import { RequestAccess } from "@/components/access/RequestAccess";
import { Knowledge } from "@/pages/Knowledge";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PENDING = {
  id: "req-1",
  scope: "knowledge.search",
  resource: "knowledge",
  action: "search",
  document_id: null,
  user_id: "u1",
  user_email: "engineer@mrpl.local",
  user_roles: ["ENGINEER"],
  justification: "Preparing the CDU-3 shutdown pack and need corpus search.",
  state: "pending",
  active: false,
  created_at: new Date().toISOString(),
  decided_by_email: "",
  decided_at: null,
  decision_note: "",
  expires_at: null,
};

const DENIED_BODY = {
  error: {
    code: "permission_denied",
    message: "knowledge:search requires one of ['ADMIN', 'SECURITY_ADMIN']",
    details: { resource: "knowledge", action: "search" },
  },
};

interface Options {
  roles?: string[];
  mine?: unknown[];
  queue?: unknown[];
  searchStatus?: number;
  onCall?: (url: string, init?: RequestInit) => void;
}

function stub({
  roles = ["ENGINEER"],
  mine = [],
  queue = [],
  searchStatus = 403,
  onCall,
}: Options) {
  tokenStore.set("t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      onCall?.(url, init);
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "a@b.local", name: "A", roles });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor(roles));
      if (url.includes("/access-requests/mine")) return json({ items: mine });
      if (url.includes("/decide")) return json({ ...PENDING, state: "denied" });
      if (url.includes("/access-requests")) return json({ items: queue });
      if (url.includes("/knowledge/search")) {
        return searchStatus === 200
          ? json({ query: "x", evidence: [], diagnostics: {} })
          : json(DENIED_BODY, searchStatus);
      }
      if (url.includes("/api/v1/documents")) {
        return json({ items: [], total: 0, limit: 100, offset: 0 });
      }
      return json({});
    }),
  );
}

function mount(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
});

describe("asking for access", () => {
  it("will not send until a real reason is written", async () => {
    stub({});
    mount(
      <RequestAccess
        scope="knowledge.search"
        title="The knowledge base is restricted"
        reason="Limited to administrators and the security team."
      />,
    );

    const button = await screen.findByRole("button", { name: /request access/i });
    expect(button).toBeDisabled();

    await userEvent.type(
      screen.getByLabelText(/why do you need this/i),
      "Tracing the isolation procedure for V-103 this week.",
    );
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("shows a waiting request instead of the form", async () => {
    stub({ mine: [PENDING] });
    mount(
      <RequestAccess
        scope="knowledge.search"
        title="The knowledge base is restricted"
        reason="Limited to administrators and the security team."
      />,
    );

    expect(await screen.findByText(/with an administrator/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /request access/i }),
    ).not.toBeInTheDocument();
  });

  it("turns a 403 on the knowledge base into somewhere to ask", async () => {
    stub({});
    mount(<Knowledge />);

    await userEvent.type(
      screen.getByPlaceholderText(/exact identifier/i),
      "isolation procedure",
    );
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));

    // Not an apology. The next step.
    expect(
      await screen.findByText(/knowledge base is restricted/i),
    ).toBeInTheDocument();
  });
});

describe("the approver's queue", () => {
  it("shows the asker's own words, and a grant that has to end", async () => {
    stub({ roles: ["ADMIN"], queue: [PENDING] });
    mount(<AccessQueue />);

    expect(await screen.findByText(/CDU-3 shutdown pack/i)).toBeInTheDocument();
    expect(screen.getByText("engineer@mrpl.local")).toBeInTheDocument();
    // Every grant expires: there is no "forever" to choose.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByText(/permanent/i)).not.toBeInTheDocument();
  });

  it("posts the literal decision rather than computing it", async () => {
    const seen: { url: string; body?: BodyInit | null }[] = [];
    stub({
      roles: ["ADMIN"],
      queue: [PENDING],
      onCall: (url, init) => seen.push({ url, body: init?.body }),
    });
    mount(<AccessQueue />);

    await screen.findByText(/CDU-3 shutdown pack/i);
    await userEvent.click(screen.getByRole("button", { name: /decline/i }));

    await waitFor(() => {
      const decide = seen.find((call) => call.url.includes("/decide"));
      expect(decide).toBeTruthy();
      expect(JSON.parse(String(decide?.body)).approved).toBe(false);
    });
  });
});
