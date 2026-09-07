/**
 * The Security & Sovereignty Center.
 *
 * The states most likely to rot unnoticed are the ones asserted here: the
 * panel has to render BREACHED in its alarm state and `monitoring: false` as
 * unverified, because the happy path looks identical to both. The audit filter
 * has to be built from `known_event_types` in the response, not a hard-coded
 * list that can drift. And the read-only policy form must have no live
 * controls.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Security } from "@/pages/Security";
import { AuthProvider } from "@/lib/auth";
import { tokenStore } from "@/lib/api";
import { permissionsFor } from "@/test/roles";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SOV_CLEAN = {
  external_requests: 0,
  external_connections: 0,
  external_dns_queries: 0,
  local_connections: 47,
  local_dns_queries: 3,
  network_egress: "BLOCKED",
  monitoring: true,
  monitoring_since: "2026-01-01T00:00:00Z",
  recent_external: [],
  how_it_is_enforced: ["In-process audit hook on every socket connect"],
};

function mount(overrides: {
  sovereignty?: unknown;
  networkEvents?: unknown;
  audit?: unknown;
  status?: unknown;
} = {}) {
  tokenStore.set("t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "a@b.local", name: "A", roles: ["ADMIN"] });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor(["ADMIN"]));
      if (url.includes("/security/sovereignty")) return json(overrides.sovereignty ?? SOV_CLEAN);
      if (url.includes("/security/network-events")) return json(overrides.networkEvents ?? { items: [] });
      if (url.includes("/security/audit")) {
        return json(
          overrides.audit ?? {
            items: [],
            total: 0,
            limit: 50,
            offset: 0,
            known_event_types: ["LOGIN", "PERMISSION_DENIED", "TASK_CREATED"],
          },
        );
      }
      if (url.includes("/security/status")) return json(overrides.status ?? {});
      if (url.includes("/internal/models/health")) return json({});
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Security />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the sovereignty panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("reads SOVEREIGN MODE ON when watching and clean", async () => {
    mount();
    expect(await screen.findByText(/SOVEREIGN MODE ON/i)).toBeInTheDocument();
  });

  it("goes to its alarm state on a breach and lists the attempts", async () => {
    mount({
      sovereignty: { ...SOV_CLEAN, network_egress: "BREACHED", external_connections: 1 },
      networkEvents: {
        items: [
          { kind: "tcp_connect", host: "13.107.4.52", port: 443, task_id: "task-9", at: "2026-01-01T00:00:00Z" },
        ],
      },
    });

    // "BREACHED" shows both as the status pill and as the egress count value.
    expect((await screen.findAllByText("BREACHED")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/should never happen/i)).toBeInTheDocument();
    expect(await screen.findByText("13.107.4.52")).toBeInTheDocument();
  });

  it("reads UNVERIFIED when the monitor is off", async () => {
    mount({ sovereignty: { ...SOV_CLEAN, monitoring: false } });

    expect(await screen.findByText("UNVERIFIED")).toBeInTheDocument();
    expect(screen.getByText(/proves nothing/i)).toBeInTheDocument();
  });
});

describe("the audit log", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("builds its filter from known_event_types in the response", async () => {
    mount({
      audit: {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
        known_event_types: ["MODEL_ROUTED", "EXTERNAL_CALL_ATTEMPTED"],
      },
    });

    // Wait for the filter to be populated from the response.
    await screen.findByRole("option", { name: "MODEL_ROUTED" });
    const select = screen.getByRole("combobox");
    expect(within(select).getByRole("option", { name: "EXTERNAL_CALL_ATTEMPTED" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: "LOGIN" })).not.toBeInTheDocument();
  });

  it("highlights a denial entry", async () => {
    mount({
      audit: {
        items: [
          {
            id: "e1",
            timestamp: "2026-01-01T00:00:00Z",
            event_type: "PERMISSION_DENIED",
            component: "acl",
            action: "read security/audit",
            user_email: "eng@b.local",
            task_id: null,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
        known_event_types: ["PERMISSION_DENIED"],
      },
    });

    const cell = await screen.findAllByText("PERMISSION_DENIED");
    // One in the row, one in the filter menu; the row one carries the danger pill.
    expect(cell.some((el) => el.className.includes("pill") && el.className.includes("danger"))).toBe(true);
  });
});

describe("the policy panel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("renders the real policy with every control disabled", async () => {
    mount({
      status: {
        classification_levels: [
          { level: "CONFIDENTIAL", max_tool_risk: "medium", requires_approval: true, local_models_only: true },
        ],
        roles: [
          { role: "ENGINEER", clearance: "CONFIDENTIAL", readable_classifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"] },
        ],
      },
    });

    // Wait for the policy data to render its controls.
    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) expect(box).toBeDisabled();
    expect(screen.getByText(/Editing requires the policy service/i)).toBeInTheDocument();
  });
});
