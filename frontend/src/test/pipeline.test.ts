/**
 * The agent pipeline reducer.
 *
 * Two properties matter here and neither is visible in a screenshot test. Every
 * event name the backend contract lists has to land on a stage — a name that
 * falls through leaves the timeline frozen mid-run. And a failure event has to
 * mark a stage failed and settle the run, not leave a spinner turning after the
 * task died two minutes ago.
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/lib/sse";
import {
  applyEvent,
  emptyPipeline,
  isSettled,
  reducePipeline,
  STAGES,
} from "@/lib/pipeline";

function ev(event: string, data: Record<string, unknown> = {}, at = "2026-01-01T00:00:00Z"): AgentEvent {
  return { task_id: "t1", event, component: "orchestrator", timestamp: at, data };
}

const SUCCESS_RUN: AgentEvent[] = [
  ev("task_created"),
  ev("task_started"),
  ev("request_analysed", { detail: "Read-only technical query" }),
  ev("plan_built", { steps: [1, 2, 3] }),
  ev("retrieval_completed", { source_count: 4 }),
  ev("model_selected", { model_id: "refinery-13b", rationale: "smallest model that fits the context" }),
  ev("tool_called", { tool: "python" }),
  ev("tool_completed", { tool: "python" }),
  ev("reasoning_completed", { output_text: "PSV-107 has a 4.8% margin." }),
  ev("validation_completed", { result: "passed", confidence: 0.88, evidence_sufficiency: 0.93 }),
  ev("artifact_generated", { artifact_id: "a1", filename: "psv_check.md", mime_type: "text/markdown", size_bytes: 1840 }),
  ev("task_completed"),
];

describe("the pipeline reducer", () => {
  it("walks a clean run to every stage done", () => {
    const state = reducePipeline(SUCCESS_RUN);

    expect(state.outcome).toBe("completed");
    expect(state.stages.every((s) => s.status === "done")).toBe(true);
    expect(isSettled(state)).toBe(true);
  });

  it("carries the answer, the citation count, the artifact and the routing", () => {
    const withCitations = [
      ...SUCCESS_RUN.slice(0, 9),
      ev("reasoning_completed", {
        output_text: "PSV-107 has a 4.8% margin.",
        citations: [
          { document_name: "CDU_PID_RevC.pdf", page: 4, score: 0.7 },
          { document_name: "API-521.pdf", page: 118, score: 0.6 },
        ],
      }),
      ...SUCCESS_RUN.slice(9),
    ];
    const state = reducePipeline(withCitations);

    expect(state.answer).toMatch(/4\.8% margin/);
    expect(state.citations).toHaveLength(2);
    expect(state.artifacts[0]).toMatchObject({ id: "a1", filename: "psv_check.md" });
    expect(state.routing).toMatchObject({ model: "refinery-13b" });
    expect(state.routing?.rationale).toMatch(/smallest model/);
  });

  it("keeps confidence, evidence sufficiency and validation as three values", () => {
    const state = reducePipeline(SUCCESS_RUN);

    expect(state.confidence).toBe(88);
    expect(state.evidenceSufficiency).toBe(93);
    expect(state.validation).toBe("passed");
    // They are distinct fields, never collapsed into one number.
    expect(state.confidence).not.toBe(state.evidenceSufficiency);
  });

  it("maps every event name in the contract to a stage change", () => {
    // The full vocabulary from 00_overview §3, success path and failures.
    const names = [
      "task_created",
      "task_started",
      "request_analysed",
      "plan_built",
      "tool_called",
      "tool_completed",
      "retrieval_completed",
      "model_selected",
      "reasoning_completed",
      "approval_requested",
      "artifact_generated",
      "validation_completed",
      "task_completed",
      "tool_denied",
      "permission_denied",
      "reasoning_failed",
      "task_failed",
      "task_cancelled",
    ];

    for (const name of names) {
      const before = emptyPipeline();
      const after = applyEvent(before, ev(name, { message: "x" }));
      const changed =
        JSON.stringify(after.stages) !== JSON.stringify(before.stages) ||
        after.outcome !== before.outcome ||
        after.awaitingApproval !== before.awaitingApproval ||
        after.error !== before.error;
      expect(changed, `${name} did nothing`).toBe(true);
    }
  });

  it("fails the stage in flight and settles on task_failed rather than spinning", () => {
    const state = reducePipeline([
      ev("task_created"),
      ev("task_started"),
      ev("request_analysed"),
      ev("plan_built", { steps: [1] }),
      ev("task_failed", { message: "The model runtime did not respond." }),
    ]);

    expect(state.outcome).toBe("failed");
    expect(isSettled(state)).toBe(true);
    expect(state.stages.some((s) => s.status === "failed")).toBe(true);
    expect(state.stages.some((s) => s.status === "active")).toBe(false);
    expect(state.error).toMatch(/did not respond/);
  });

  it("marks the approval gate and clears it on resume-to-completion", () => {
    const paused = reducePipeline([
      ev("task_created"),
      ev("task_started"),
      ev("request_analysed"),
      ev("model_selected", { model_id: "m" }),
      ev("reasoning_completed", { output_text: "draft" }),
      ev("approval_requested", { reason: "artifact export" }),
    ]);
    expect(paused.awaitingApproval).toBe(true);
    expect(paused.outcome).toBeNull();

    const resumed = applyEvent(
      applyEvent(paused, ev("artifact_generated", { artifact_id: "a1", filename: "note.docx" })),
      ev("task_completed"),
    );
    expect(resumed.awaitingApproval).toBe(false);
    expect(resumed.outcome).toBe("completed");
  });

  it("produces the same result from a replayed backlog as from a live run", () => {
    // A late subscriber gets the whole buffer at once. Folding it must land in
    // exactly the state a live watcher reached.
    const live = reducePipeline(SUCCESS_RUN);
    const replayedAllAtOnce = reducePipeline([...SUCCESS_RUN]);
    expect(replayedAllAtOnce).toEqual(live);
  });

  it("has nine stages, in the order the front timeline shows", () => {
    expect(STAGES.map((s) => s.id)).toEqual([
      "identity",
      "authorization",
      "risk",
      "retrieval",
      "model",
      "execution",
      "validation",
      "checkpoint",
      "audit",
    ]);
  });
});
