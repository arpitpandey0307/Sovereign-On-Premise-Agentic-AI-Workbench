/**
 * The three numbers, side by side and never merged.
 *
 * Confidence, evidence sufficiency and validation are separate measurements the
 * backend goes to real trouble to keep apart. Collapsing them into one
 * reassuring percentage would be the most dishonest thing this UI could do, so
 * they render as three cells, each with its own label and a tooltip saying what
 * it actually is. Any of them may be absent — a run that has not reached
 * validation simply shows fewer.
 */

import type { PipelineState } from "@/lib/pipeline";

const EXPLAIN = {
  confidence:
    "The model's own estimate that its answer is correct. Not a measure of evidence.",
  evidence:
    "How well the retrieved sources actually cover the question asked.",
  validation:
    "Whether an automated check found the answer consistent with its cited evidence.",
} as const;

export function ConfidenceRow({ state }: { state: PipelineState }) {
  const cells: Array<{ label: string; value: string; title: string; tone: string }> = [];

  if (state.confidence != null) {
    cells.push({
      label: "Confidence",
      value: `${state.confidence}%`,
      title: EXPLAIN.confidence,
      tone: "var(--text)",
    });
  }
  if (state.evidenceSufficiency != null) {
    cells.push({
      label: "Evidence sufficiency",
      value: `${state.evidenceSufficiency}%`,
      title: EXPLAIN.evidence,
      tone: "var(--text)",
    });
  }
  if (state.validation != null) {
    cells.push({
      label: "Validation",
      value: state.validation.toUpperCase(),
      title: EXPLAIN.validation,
      tone:
        state.validation === "passed"
          ? "var(--ok-text)"
          : state.validation === "failed"
            ? "var(--danger-text)"
            : "var(--warn-text)",
    });
  }

  if (!cells.length) return null;

  return (
    <div className="stat-grid" role="group" aria-label="Answer quality">
      {cells.map((cell) => (
        <div className="stat" key={cell.label} title={cell.title}>
          <div className="s-label">{cell.label}</div>
          <div className="s-value mono" style={{ color: cell.tone }}>
            {cell.value}
          </div>
        </div>
      ))}
    </div>
  );
}
