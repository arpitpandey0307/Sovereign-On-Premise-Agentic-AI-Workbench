/**
 * Citations and outputs for an assistant turn.
 *
 * Two rules from the brief hold here. Every claim carries its source, rendered
 * as `SOURCE: filename — Page X`; a finding the generator could not support is
 * shown as `unsupported`, visibly, rather than quietly dropped. And an artifact
 * is fetched with the session attached — a plain link would carry no
 * Authorization header and the server would refuse it.
 */

import { useState } from "react";
import { Download, FileWarning } from "lucide-react";
import { api, describeError } from "@/lib/api";
import type { ArtifactRef, Citation } from "@/lib/pipeline";
import { formatBytes } from "@/lib/format";

export function Citations({ items }: { items: Citation[] }) {
  if (!items.length) return null;
  return (
    <div className="sources">
      <div className="lbl">SOURCES</div>
      {items.map((c, index) => (
        <div className="source-row" key={`${c.documentId ?? c.documentName}-${index}`}>
          <span className="ref mono">
            <b>{c.documentName}</b>
            {c.page != null ? `  —  Page ${c.page}` : ""}
            {c.section ? `  ·  ${c.section}` : ""}
          </span>
          {c.unsupported ? (
            <span className="pill warn">
              <FileWarning className="size-3" aria-hidden />
              unsupported
            </span>
          ) : c.score != null ? (
            <span className="mono" style={{ color: "var(--text-faint)", fontSize: "11px" }}>
              {c.score.toFixed(2)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Outputs({ items }: { items: ArtifactRef[] }) {
  if (!items.length) return null;
  return (
    <div className="sources outputs">
      <div className="lbl">OUTPUT</div>
      {items.map((a) => (
        <ArtifactRow key={a.id} artifact={a} />
      ))}
    </div>
  );
}

function ArtifactRow({ artifact }: { artifact: ArtifactRef }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meta = [artifact.mime, artifact.sizeBytes != null ? formatBytes(artifact.sizeBytes) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="source-row">
      <span className="ref mono">
        <b>{artifact.filename}</b>
        {meta ? `  —  ${meta}` : ""}
      </span>
      <div className="flex items-center gap-2">
        {error && (
          <span className="mono" style={{ color: "var(--danger-text)", fontSize: "11px" }}>
            {error}
          </span>
        )}
        <button
          type="button"
          className="btn btn-sm btn-accent"
          disabled={busy || !artifact.id}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.download(
                `/api/v1/artifacts/${artifact.id}/download`,
                artifact.filename,
              );
            } catch (caught) {
              setError(describeError(caught).title);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Download className="size-3.5" aria-hidden />
          {busy ? "Downloading…" : "Download"}
        </button>
      </div>
    </div>
  );
}
