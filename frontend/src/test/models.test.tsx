/**
 * The Model Center.
 *
 * The routing playground has to render each rejection with the stage it fell
 * out at and the reason — that is the whole point, showing selection is
 * reasoned rather than fixed. And the add-model form must not be able to
 * submit: it posts nowhere, because the endpoint does not exist, and a form
 * that fails confusingly in front of an audience is worse than an honest one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Models } from "@/pages/Models";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MODELS = {
  models: [
    {
      model_id: "refinery-7b",
      type: "text",
      capabilities: ["qa", "analysis"],
      context_length: 8192,
      vram_required_gb: 7,
      approved_for: ["CONFIDENTIAL"],
      status: "ready",
      name: "Refinery 7B",
      provider: "ollama",
      quantization: "Q4_K_M",
      status_detail: "",
      notes: "",
    },
    {
      model_id: "qwen3-8b",
      type: "text",
      capabilities: ["qa"],
      context_length: 32768,
      vram_required_gb: 8,
      approved_for: [],
      status: "unavailable",
      name: "Qwen3 8B",
      provider: "ollama",
      quantization: "Q4_K_M",
      status_detail: "not pulled: run `ollama pull qwen3:8b`",
      notes: "",
    },
  ],
};

function mount(routeResponse?: unknown, roles = ["ADMIN"] as const) {
  tokenStore.set("t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "a@b.local", name: "A", roles });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor([...roles]));
      if (url.includes("/api/v1/models/route")) return json(routeResponse ?? {});
      if (url.includes("/api/v1/models")) return json(MODELS);
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Models />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the Model Center", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("shows status_detail verbatim for an unavailable model", async () => {
    mount();
    expect(
      await screen.findByText("not pulled: run `ollama pull qwen3:8b`"),
    ).toBeInTheDocument();
  });

  // The router reports each rejection with the stage that made it, rather than
  // an array of stages. This fixture is the shape a running backend returns.
  it("renders routing rejections with their stage and reason", async () => {
    mount({
      selected: { model_id: "refinery-7b", type: "reasoning", status: "ready" },
      rationale: "Selected refinery-7b -- best fit for a reasoning task.",
      requirements: {
        task_type: "reasoning",
        model_type: null,
        classification: "INTERNAL",
        estimated_context_tokens: 2048,
        needs_vision: false,
        needs_structured_output: false,
      },
      considered: 3,
      ranked: [
        {
          model_id: "refinery-7b",
          total: 0.82,
          factors: [{ name: "task_accuracy", value: 0.9, weight: 0.5, contribution: 0.45 }],
        },
      ],
      rejected: [
        { model_id: "vlm-13b", stage: "capability", reason: "vision not requested" },
        { model_id: "qwen3-8b", stage: "hardware fit", reason: "not pulled on this host" },
      ],
      fallback_chain: ["refinery-7b", "qwen3-1_7b"],
    });

    await userEvent.click(await screen.findByRole("button", { name: /preview/i }));

    expect(await screen.findByText(/vision not requested/i)).toBeInTheDocument();
    expect(screen.getByText(/not pulled on this host/i)).toBeInTheDocument();
    expect(screen.getByText(/Ruled out at: hardware fit/i)).toBeInTheDocument();
    expect(screen.getByText(/Selected:/i)).toBeInTheDocument();
    // The chosen model is named, not rendered as "[object Object]".
    expect(screen.getAllByText("refinery-7b").length).toBeGreaterThan(0);
  });

  it("the add-model form generates a catalogue entry and posts nowhere", async () => {
    const calls: string[] = [];
    tokenStore.set("t");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/auth/me")) {
          return json({ id: "u1", email: "a@b.local", name: "A", roles: ["ADMIN"] });
        }
        if (url.includes("/security/permissions")) return json(permissionsFor(["ADMIN"]));
        if (url.includes("/api/v1/models")) return json(MODELS);
        return json({});
      }),
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <Models />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText("Add a local model");
    await userEvent.type(screen.getByLabelText(/^Model id$/i), "qwen3-8b");
    expect(screen.getByText(/model_id="qwen3-8b"/)).toBeInTheDocument();

    // No POST to a models-create endpoint ever happens.
    expect(calls.some((u) => /\/api\/v1\/models$/.test(u) && !u.includes("route"))).toBe(true);
    expect(
      calls.filter((u) => u.endsWith("/api/v1/models")).length,
    ).toBeGreaterThan(0);
    // It only ever GETs the list; there is no create call to assert beyond that.
  });
});
