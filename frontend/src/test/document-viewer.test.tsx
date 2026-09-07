/**
 * The Document Viewer.
 *
 * The property that matters most here is a correctness one, not a styling one:
 * a vision model's description of a page must never render as the page's own
 * text. The backend keeps them in separate fields on purpose; the viewer has
 * to keep them in separate containers. OCR text has to be labelled as OCR. And
 * a security administrator, who cannot read the corpus, has to get the
 * deliberate oversight note rather than an error.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentViewer } from "@/pages/DocumentViewer";
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

const DOC = {
  id: "doc-1",
  file_id: "file-1",
  filename: "Inspection_Report.pdf",
  mime_type: "application/pdf",
  kind: "report",
  classification: "CONFIDENTIAL",
  classification_reason: "contains equipment condition data",
  version: 2,
  status: "indexed",
  page_count: 3,
  chunk_count: 40,
  indexed_in_graph: true,
  ingest_error: "",
  created_at: "2026-01-01T00:00:00Z",
};

function mountViewer(
  page: {
    text?: string;
    ocr_status?: string;
    ocr_confidence?: number | null;
    vision_summary?: string | null;
    vision_model?: string | null;
  },
  { roles = ["ENGINEER"] as Role[], entry = "/documents/doc-1?page=2" } = {},
) {
  tokenStore.set("t");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/me")) {
        return json({ id: "u1", email: "a@b.local", name: "A", roles });
      }
      if (url.includes("/security/permissions")) return json(permissionsFor(roles));
      if (/\/documents\/doc-1\/pages\/\d+$/.test(url)) {
        return json({
          document_id: "doc-1",
          page_number: 2,
          text: "",
          ocr_status: "none",
          ocr_confidence: null,
          vision_summary: null,
          vision_model: null,
          ...page,
        });
      }
      if (url.includes("/documents/doc-1")) return json(DOC);
      return json({});
    }),
  );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <Routes>
            <Route path="/documents/:id" element={<DocumentViewer />} />
            <Route path="/security" element={<p>Security Center</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the Document Viewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    tokenStore.clear();
  });

  it("never renders a vision description as page text", async () => {
    await mountViewer({
      text: "Valve V-103 was isolated per SOP-204.",
      vision_summary: "A close-up photograph of a corroded flange with visible pitting.",
      vision_model: "vision-7b",
    });

    const description = await screen.findByText(/close-up photograph of a corroded flange/i);
    // It is in the labelled vision block...
    expect(description.closest(".vision-block")).not.toBeNull();
    // ...and NOT in the page-text container.
    expect(description.closest(".page-text")).toBeNull();
    expect(screen.getByText(/described by vision-7b/i)).toBeInTheDocument();

    // The real text layer is present and unannotated.
    const pageText = screen.getByText(/Valve V-103 was isolated/i);
    expect(pageText.closest(".page-text")).not.toBeNull();
    expect(pageText.closest(".ocr-block")).toBeNull();
  });

  it("labels OCR text as OCR, with its confidence", async () => {
    await mountViewer({
      text: "PRESSURE RELIEF VALVE SCHEDULE — SHEET 4",
      ocr_status: "ocr",
      ocr_confidence: 0.82,
    });

    const block = (await screen.findByText(/PRESSURE RELIEF VALVE SCHEDULE/i)).closest(
      ".ocr-block",
    );
    expect(block).not.toBeNull();
    expect(screen.getByText(/confidence 82%/i)).toBeInTheDocument();
  });

  it("highlights the cited passage when it is on the page verbatim", async () => {
    await mountViewer(
      { text: "Section 4.2. Valve V-103 shows leakage at the bonnet gasket." },
      { entry: "/documents/doc-1?page=2&q=Valve%20V-103%20shows%20leakage" },
    );

    const mark = await screen.findByText("Valve V-103 shows leakage");
    expect(mark.tagName).toBe("MARK");
  });

  it("says so when the cited passage is not on the page", async () => {
    await mountViewer(
      { text: "This page is about something else entirely." },
      { entry: "/documents/doc-1?page=2&q=leakage%20at%20valve%20V-103" },
    );

    expect(
      await screen.findByText(/cited passage was not found verbatim/i),
    ).toBeInTheDocument();
  });

  it("gives a security administrator the oversight note, not an error", async () => {
    await mountViewer({ text: "secret" }, { roles: ["SECURITY_ADMIN"] });

    expect(
      await screen.findByText(/oversees the system rather than its contents/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });
});
