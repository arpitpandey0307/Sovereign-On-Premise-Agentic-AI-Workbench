/**
 * The intentional empty state for a security administrator.
 *
 * `SECURITY_ADMIN` has PUBLIC clearance and cannot read the corpus, so the
 * document viewer, the knowledge base and the artifacts library all return
 * little or nothing for that role. This is the single most likely place for
 * the product to look broken while working exactly as designed, so the copy
 * has to make the emptiness read as deliberate — a boundary, not a fault — and
 * point at the screen the role is actually for.
 */

import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

export function SecurityOversightNote({ surface }: { surface: string }) {
  return (
    <div className="empty-state" style={{ maxWidth: "560px", margin: "40px auto" }}>
      <ShieldCheck
        className="mx-auto mb-3 size-7"
        style={{ color: "var(--accent-bright)" }}
        aria-hidden
      />
      <p style={{ color: "var(--text-dim)", fontSize: "14px", fontWeight: 500 }}>
        Your role oversees the system rather than its contents.
      </p>
      <p style={{ marginTop: "8px" }}>
        {surface} is held by the Engineering and Management roles. A security
        administrator monitors access to it without reading it — that separation
        is deliberate.
      </p>
      <Link
        to="/security"
        className="mt-4 inline-flex items-center gap-1.5 text-[12px]"
        style={{ color: "var(--accent-bright)" }}
      >
        Go to the Security Center
      </Link>
    </div>
  );
}
