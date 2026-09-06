/**
 * Why this model.
 *
 * The router returns the full rationale — which model it chose, and what it
 * rejected and for what reason. Showing the rejected options is a genuinely
 * strong thing to put in front of someone: it demonstrates the choice was
 * reasoned rather than fixed.
 */

import { Cpu } from "lucide-react";
import type { ModelRouting } from "@/lib/pipeline";

export function ModelRoutingCard({ routing }: { routing: ModelRouting }) {
  return (
    <div className="card">
      <div className="flex items-center gap-2">
        <Cpu className="size-4 text-accent" aria-hidden />
        <span className="section-title">Model selection</span>
      </div>
      <p className="mono mt-2 text-[13px]" style={{ color: "var(--accent-bright)" }}>
        {routing.model}
      </p>
      <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-dim)" }}>
        {routing.rationale}
      </p>

      {routing.rejected.length > 0 && (
        <>
          <div className="mt-3 field-label">Not selected</div>
          <ul className="mt-1 space-y-1">
            {routing.rejected.map((option) => (
              <li key={option.model} className="text-[12px]" style={{ color: "var(--text-mute)" }}>
                <span className="mono" style={{ color: "var(--text-dim)" }}>
                  {option.model}
                </span>{" "}
                — {option.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
