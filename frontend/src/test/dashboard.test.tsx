/**
 * The Dashboard's system-status panel.
 *
 * `GET /api/v1/system/status` requires `system:read`, which only the oversight
 * roles hold. Asking for it as an engineer is a request that can only ever be
 * refused — and the backend records every refusal in the audit ledger, which
 * the Security Center then shows in red as evidence the controls are live.
 * A screen that generates its own denials on every visit both looks broken to
 * the person using it and buries the real denials for the person auditing it.
 *
 * The oversight figures also come from the `/internal` bags, where the corpus
 * counts are nested under `corpus` — reading them from the top level found
 * nothing, so the knowledge metric never appeared at all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "@/pages/Dashboard";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";
import type { Role } from "@/lib/types";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SYSTEM_STATUS = {
  status: "ok",
  app: "Sovereign AI Workbench",
  version: "0.1.0",
  external_network_allowed: false,
  object_storage: "filesystem",
  model_runtime: { reachable: true, detail: "5/6 models ready" },
  event_buffers_retained: 0,
  parts: {
    "01_foundation": "live",
    "02_model_layer": "live",
    "03_documents": "live",
    "04_orchestration": "live",
    "05_security_audit": "live",
  },
};

/** The real shape of `/internal/knowledge/status`: counts nested under corpus. */
const KNOWLEDGE_STATUS = {
  available: true,
  graph: { reachable: false },
  ocr: { available: true },
  corpus: { documents: 12, chunks: 480, embedded_chunks: 480, entities: 33 },
  retrieval_mode: "hybrid (local scan)",
};

const MODEL_HEALTH = {
  gpu: { present: true, name: "RTX 5050" },
  runtimes: { ollama: { reachable: true } },
  resident_models: ["reasoner-qwen3-8b-4bit", "embed-bge-small"],
  models: [],
};

function mount(roles: Role[]) {
  const urls: string[] = [];
  tokenStore.set("tok");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "a@b.local", name: "A", roles });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor(roles));
      if (url.includes("/system/status")) return json(SYSTEM_STATUS);
      if (url.includes("/internal/knowledge/status")) return json(KNOWLEDGE_STATUS);
      if (url.includes("/internal/models/health")) return json(MODEL_HEALTH);
      if (url.includes("/security/sovereignty")) {
        return json({
          external_requests: 0,
          external_connections: 0,
          external_dns_queries: 0,
          local_connections: 0,
          local_dns_queries: 0,
          network_egress: "BLOCKED",
          monitoring: true,
          monitoring_since: "2026-01-01T00:00:00Z",
          recent_external: [],
        });
      }
      if (url.includes("/api/v1/tasks")) {
        return json({ items: [], total: 0, limit: 25, offset: 0 });
      }
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Dashboard />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return urls;
}

describe("the Dashboard system-status panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("never asks for system status as a role that cannot read it", async () => {
    const urls = mount(["ENGINEER"]);

    expect(
      await screen.findByText(/reported to administrators and security administrators/i),
    ).toBeInTheDocument();
    // Give any stray request a chance to fire before asserting it did not.
    await waitFor(() => expect(urls.some((u) => u.includes("/auth/me"))).toBe(true));
    expect(urls.some((u) => u.includes("/api/v1/system/status"))).toBe(false);
    expect(urls.some((u) => u.includes("/internal/"))).toBe(false);
  });

  it("reads the oversight figures from where the API actually nests them", async () => {
    mount(["ADMIN"]);

    expect(await screen.findByText("Reachable")).toBeInTheDocument();
    // corpus.documents / corpus.chunks, not top-level keys.
    expect(await screen.findByText("12 docs")).toBeInTheDocument();
    expect(screen.getByText("480 chunks indexed")).toBeInTheDocument();
    // resident_models is a list; its length is the count.
    expect(screen.getByText("Models loaded")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
