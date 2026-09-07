/**
 * Settings.
 *
 * The parts panel is the reason this screen carries system status: a part
 * reading `stub` failed to install at startup, and that has to be visible, not
 * buried. And the honest-UI rule holds — the notifications tab, which is not
 * wired, says so rather than showing dead controls.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "@/pages/Settings";
import { tokenStore } from "@/lib/api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mount() {
  tokenStore.set("t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/system/status")) {
        return json({
          status: "ok",
          app: "sovereign-workbench",
          version: "0.5.0",
          external_network_allowed: false,
          object_storage: "filesystem",
          model_runtime: { reachable: true, detail: "ollama on loopback" },
          event_buffers_retained: 3,
          parts: { part01: "live", part03: "live", part04: "stub" },
        });
      }
      if (url.includes("/security/sovereignty")) {
        return json({
          external_requests: 0,
          external_connections: 0,
          external_dns_queries: 0,
          local_connections: 5,
          local_dns_queries: 1,
          network_egress: "BLOCKED",
          monitoring: true,
          monitoring_since: "2026-01-01T00:00:00Z",
          recent_external: [],
        });
      }
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
    localStorage.clear();
  });

  it("remembers the sidebar preference to storage", async () => {
    mount();
    await userEvent.click(screen.getByRole("switch", { name: /sidebar collapsed/i }));
    expect(localStorage.getItem("sovereign.sidebar.collapsed")).toBe("true");
  });

  it("flags a stubbed backend part in the system tab", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "System" }));

    const cell = await screen.findByText("part04");
    const row = cell.closest("tr")!;
    const pill = row.querySelector(".pill")!;
    expect(pill.textContent).toBe("stub");
    expect(pill.className).toContain("danger");
  });

  it("says the notifications tab is not wired", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(
      await screen.findByText(/notifications service, which is not\s+enabled/i),
    ).toBeInTheDocument();
  });
});
