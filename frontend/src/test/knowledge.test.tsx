/**
 * The Knowledge Base.
 *
 * An empty search is one of three different things and the screen has to say
 * which — nothing indexed, nothing matched, or matches withheld by clearance
 * (that last without revealing anything about what was withheld). And the
 * equipment graph must label a same-page co-occurrence differently from a real
 * modelled relationship: presenting the weaker claim as the stronger one on a
 * P&ID would be a genuine error.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const DIAG = {
  vector_backend: "neo4j",
  keyword_backend: "sqlite_fts",
  rerank_method: "cross-encoder",
  vector_hits: 0,
  keyword_hits: 0,
  chunks_considered: 0,
  classifications_allowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
  notes: [] as string[],
};

function mount({
  documents = [] as unknown[],
  searchResponse,
  equipment,
}: {
  documents?: unknown[];
  searchResponse?: unknown;
  equipment?: unknown;
}) {
  tokenStore.set("t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "a@b.local", name: "A", roles: ["ENGINEER"] });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor(["ENGINEER"]));
      if (url.includes("/knowledge/search")) return json(searchResponse ?? {});
      if (url.includes("/knowledge/equipment/")) {
        return equipment ? json(equipment) : json({ error: { code: "not_found", message: "no", details: {} } }, 404);
      }
      if (url.includes("/api/v1/documents")) {
        return json({ items: documents, total: documents.length, limit: 100, offset: 0 });
      }
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <Knowledge />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function runSearch(term: string) {
  await userEvent.type(screen.getByPlaceholderText(/exact identifier/i), term);
  await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
}

describe("the Knowledge Base empty states", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("distinguishes 'nothing indexed'", async () => {
    mount({
      documents: [],
      searchResponse: { query: "psv", evidence: [], diagnostics: { ...DIAG } },
    });
    await runSearch("psv");
    expect(await screen.findByText(/Nothing is indexed yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /upload a document/i })).toBeInTheDocument();
  });

  it("distinguishes 'indexed, no match' and points at exact identifiers", async () => {
    mount({
      documents: [{ id: "d1", file_id: "f1", filename: "a.pdf", classification: "INTERNAL", version: 1, kind: "report", mime_type: "application/pdf", page_count: 10, chunk_count: 20, indexed_in_graph: true, status: "indexed", classification_reason: "", ingest_error: "", created_at: "2026-01-01T00:00:00Z" }],
      searchResponse: {
        query: "nonsense",
        evidence: [],
        diagnostics: { ...DIAG, chunks_considered: 128 },
      },
    });
    await runSearch("nonsense");
    expect(await screen.findByText(/No match/i)).toBeInTheDocument();
    expect(screen.getByText(/SOP-204/)).toBeInTheDocument();
  });

  it("distinguishes 'withheld by clearance' without revealing what", async () => {
    mount({
      documents: [{ id: "d1", file_id: "f1", filename: "a.pdf", classification: "INTERNAL", version: 1, kind: "report", mime_type: "application/pdf", page_count: 10, chunk_count: 20, indexed_in_graph: true, status: "indexed", classification_reason: "", ingest_error: "", created_at: "2026-01-01T00:00:00Z" }],
      searchResponse: {
        query: "secret",
        evidence: [],
        diagnostics: { ...DIAG, chunks_considered: 40, notes: ["2 results withheld by clearance"] },
      },
    });
    await runSearch("secret");
    expect(await screen.findByText(/Some results were withheld/i)).toBeInTheDocument();
    // It must not name or count what was withheld in the user-facing copy.
    expect(screen.queryByText(/2 results/i)).not.toBeInTheDocument();
  });
});

describe("the equipment graph", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("labels a same-page co-occurrence as the weaker claim it is", async () => {
    mount({
      equipment: {
        tag: "P-103",
        type: "pump",
        source: "page_co_occurrence",
        neighbours: [{ tag: "V-201", type: "valve" }],
      },
    });
    await userEvent.type(screen.getByPlaceholderText(/equipment tag/i), "p-103");
    await userEvent.click(screen.getByRole("button", { name: /trace/i }));

    expect(await screen.findByText(/same-page co-occurrence/i)).toBeInTheDocument();
    expect(screen.getByText(/not the same as them being connected/i)).toBeInTheDocument();
  });

  it("labels a graph traversal as a real relationship", async () => {
    mount({
      equipment: {
        tag: "P-103",
        type: "pump",
        source: "graph_traversal",
        neighbours: [{ tag: "V-201", type: "valve", relation: "discharges to" }],
      },
    });
    await userEvent.type(screen.getByPlaceholderText(/equipment tag/i), "p-103");
    await userEvent.click(screen.getByRole("button", { name: /trace/i }));

    expect(await screen.findByText(/graph relationship/i)).toBeInTheDocument();
    expect(screen.queryByText(/not the same as them being connected/i)).not.toBeInTheDocument();
  });
});
