/**
 * The Document Viewer.
 *
 * Three columns: the page rail, the page, and the evidence panel. The point of
 * the centre column is that three things stay visually distinct, because
 * conflating them would mislead in a way that matters here:
 *
 *   - text from a real text layer  → plain
 *   - text recovered by OCR        → labelled, with its confidence
 *   - a vision model's description → its own block, "described by <model>",
 *                                    never merged into the page text
 *
 * The backend keeps `vision_summary` out of `page.text` on purpose; this screen
 * preserves that separation rather than rendering one readable blob.
 *
 * A citation arriving from the Workbench carries `?page=` and, when the backend
 * sent the passage, `?q=`. The viewer opens that page and highlights the
 * matching passage in the extracted text — there is no rendered PDF to draw a
 * box on, and saying so honestly is better than faking one.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, ScanLine, Sparkles } from "lucide-react";
import { useRole } from "@/lib/auth";
import { useDocument, useDocumentPage, useReingest } from "@/lib/queries";
import { ClassificationBadge, StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import { SecurityOversightNote } from "@/components/states/SecurityOversightNote";
import type { DocumentPage } from "@/lib/types";

export function DocumentViewer() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const { isSecurityOnly } = useRole();

  const wantedPage = Math.max(1, Number(params.get("page")) || 1);
  const passage = params.get("q") ?? "";
  const [page, setPage] = useState(wantedPage);

  // Follow the citation if the URL's page changes under us (a second "View
  // source" click while the viewer is already open). Adjusting state during
  // render rather than in an effect, per the React "derived from props" pattern.
  const [syncedPage, setSyncedPage] = useState(wantedPage);
  if (wantedPage !== syncedPage) {
    setSyncedPage(wantedPage);
    setPage(wantedPage);
  }

  const doc = useDocument(id);
  const reingest = useReingest();

  if (isSecurityOnly) {
    return (
      <div className="view-pad">
        <SecurityOversightNote surface="This document" />
      </div>
    );
  }

  if (doc.isError) {
    return (
      <div className="view-pad">
        <ErrorState error={doc.error} onRetry={() => doc.refetch()} />
      </div>
    );
  }
  if (doc.isLoading || !doc.data) {
    return (
      <div className="view-pad">
        <LoadingState rows={4} label="Loading the document" />
      </div>
    );
  }

  const d = doc.data;
  const pageCount = Math.max(1, d.page_count || 1);

  return (
    <div className="view-pad" style={{ maxWidth: "1280px" }}>
      <Link
        to="/documents"
        className="mb-3 inline-flex items-center gap-1.5 text-[12px]"
        style={{ color: "var(--text-mute)" }}
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        My Documents
      </Link>

      <header className="card" style={{ marginBottom: "16px" }}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[15px] font-semibold text-primary">{d.filename}</span>
          <ClassificationBadge level={d.classification} />
          <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
            v{d.version} · {d.kind || d.mime_type}
          </span>
          {d.ingest_error ? (
            <StatusPill tone="danger">Ingest failed</StatusPill>
          ) : d.indexed_in_graph ? (
            <StatusPill tone="positive">Indexed · in graph</StatusPill>
          ) : (
            <StatusPill tone="info">Indexed · text only</StatusPill>
          )}
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            disabled={reingest.isPending}
            onClick={() => reingest.mutate(d.file_id)}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            Reingest
          </button>
        </div>
        {d.ingest_error && (
          <p className="error-note" style={{ marginTop: "10px" }}>
            {d.ingest_error}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-4 lg:flex-row">
        <nav className="page-rail lg:w-20 lg:shrink-0" aria-label="Pages">
          {Array.from({ length: pageCount }, (_, index) => index + 1).map((n) => (
            <button
              key={n}
              type="button"
              className={n === page ? "active" : ""}
              onClick={() => setPage(n)}
              aria-current={n === page ? "page" : undefined}
            >
              {n}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <PageContent id={id} page={page} passage={passage} />
        </div>

        <aside className="lg:w-72 lg:shrink-0">
          <EvidencePanel
            documentName={d.filename}
            page={wantedPage}
            section={params.get("section")}
            confidence={params.get("confidence")}
            passage={passage}
            hasCitation={params.has("page") || params.has("q")}
          />
        </aside>
      </div>
    </div>
  );
}

function PageContent({
  id,
  page,
  passage,
}: {
  id: string;
  page: number;
  passage: string;
}) {
  const query = useDocumentPage(id, page);
  const anchorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Guarded: jsdom and some embedded webviews do not implement this.
    anchorRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [query.data, passage]);

  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isLoading || !query.data) {
    return <LoadingState rows={5} label={`Loading page ${page}`} />;
  }

  const p: DocumentPage = query.data;
  const isOcr = /ocr/i.test(p.ocr_status) && p.ocr_status !== "none";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="section-title">Page {p.page_number}</span>
        {isOcr && (
          <span className="pill warn">
            <ScanLine className="size-3" aria-hidden />
            OCR
            {p.ocr_confidence != null
              ? ` · ${Math.round((p.ocr_confidence <= 1 ? p.ocr_confidence * 100 : p.ocr_confidence))}%`
              : ""}
          </span>
        )}
        {p.vision_summary && (
          <span className="pill accent">
            <Sparkles className="size-3" aria-hidden />
            vision description
          </span>
        )}
      </div>

      {/* The page's own text. If it was recovered by OCR the whole block is
          labelled as such — the words are a machine's best reading, not a
          certainty. */}
      {isOcr ? (
        <div className="ocr-block">
          <div className="ocr-label">
            Recovered by OCR
            {p.ocr_confidence != null
              ? ` · confidence ${Math.round((p.ocr_confidence <= 1 ? p.ocr_confidence * 100 : p.ocr_confidence))}%`
              : ""}
          </div>
          <Highlighted text={p.text} passage={passage} anchorRef={anchorRef} />
        </div>
      ) : p.text ? (
        <Highlighted text={p.text} passage={passage} anchorRef={anchorRef} />
      ) : (
        <p className="hint">This page has no extracted text.</p>
      )}

      {/* A vision model's description — deliberately separate. It is one model's
          account of what the page shows, and must never be quotable as the
          page's own words. */}
      {p.vision_summary && (
        <div className="vision-block">
          <div className="vision-label">
            Described by {p.vision_model || "a vision model"}
          </div>
          <p className="vision-body">{p.vision_summary}</p>
        </div>
      )}
    </div>
  );
}

/** Highlight the cited passage in the page text, if it is there verbatim. */
function Highlighted({
  text,
  passage,
  anchorRef,
}: {
  text: string;
  passage: string;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const parts = useMemo(() => {
    const needle = passage.trim();
    if (!needle) return null;
    const at = text.toLowerCase().indexOf(needle.toLowerCase());
    if (at === -1) return null;
    return {
      before: text.slice(0, at),
      match: text.slice(at, at + needle.length),
      after: text.slice(at + needle.length),
    };
  }, [text, passage]);

  if (!parts) {
    return (
      <>
        {passage.trim() && (
          <p className="hint" style={{ marginBottom: "8px" }}>
            The cited passage was not found verbatim on this page — it may be
            paraphrased or span a page break.
          </p>
        )}
        <div className="page-text">{text}</div>
      </>
    );
  }

  return (
    <div className="page-text">
      {parts.before}
      <mark ref={anchorRef as React.RefObject<HTMLElement>}>{parts.match}</mark>
      {parts.after}
    </div>
  );
}

function EvidencePanel({
  documentName,
  page,
  section,
  confidence,
  passage,
  hasCitation,
}: {
  documentName: string;
  page: number;
  section: string | null;
  confidence: string | null;
  passage: string;
  hasCitation: boolean;
}) {
  if (!hasCitation) {
    return (
      <div className="card">
        <span className="section-title">Evidence</span>
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-mute)" }}>
          Open this viewer from a citation in the Workbench to see the claim it
          supports and jump to the cited passage.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <span className="section-title">Evidence</span>
      {passage && (
        <blockquote
          className="mt-2 border-l-2 pl-3 text-[13px]"
          style={{ borderColor: "var(--accent-line)", color: "var(--text-dim)" }}
        >
          “{passage}”
        </blockquote>
      )}
      <dl className="mt-3 space-y-1.5 text-[12px]">
        <Row label="Source" value={documentName} />
        <Row label="Page" value={String(page)} />
        {section && <Row label="Section" value={section} />}
        {confidence && <Row label="Confidence" value={`${confidence}%`} />}
      </dl>
      <p className="mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Highlighted in the extracted text on the left. There is no rendered PDF
        here — the match is on the page's text, not a region of an image.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt style={{ color: "var(--text-mute)" }}>{label}</dt>
      <dd className="mono text-right" style={{ color: "var(--text-dim)" }}>
        {value}
      </dd>
    </div>
  );
}
