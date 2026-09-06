/**
 * The reasoning timeline — the nine pipeline stages as the `front` design
 * system draws them, inside a collapsible "Show reasoning" panel.
 *
 * It is open while the run is in flight (someone wants to see it working) and
 * collapsed once it settles (the answer is what matters now). A stage shows its
 * one line of machine truth: the model chosen, the source count, what was
 * validated.
 */

import type { PipelineState } from "@/lib/pipeline";

export function ReasoningTimeline({
  state,
  running,
}: {
  state: PipelineState;
  running: boolean;
}) {
  const done = state.stages.filter((s) => s.status === "done").length;
  const summary = running
    ? `Show reasoning — ${done}/${state.stages.length} steps`
    : `Show reasoning — ${done} steps`;

  return (
    <details className="reasoning" open={running}>
      <summary>
        <span className="chev mono">▸</span>
        {summary}
      </summary>
      <div className="timeline">
        {state.stages.map((stage, index) => (
          <div
            key={stage.id}
            className={
              "tl-step" +
              (stage.status === "done"
                ? " done"
                : stage.status === "active"
                  ? " active"
                  : stage.status === "failed"
                    ? " fail"
                    : "")
            }
          >
            <div className="tl-node">
              {stage.status === "done"
                ? "✓"
                : stage.status === "failed"
                  ? "✗"
                  : String(index + 1)}
            </div>
            <div className="tl-body">
              <div className="tl-name">{stage.name}</div>
              {stage.detail && <div className="tl-detail">{stage.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
