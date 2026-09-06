/**
 * The agent pipeline: the fixed sequence of stages a task passes through, and
 * the reducer that turns a stream of `AgentEvent`s into that sequence's state.
 *
 * The nine stages are the ones the `front` design system shows in its reasoning
 * timeline (Identity Check → … → Audit Log). The backend does not emit an event
 * per stage — it emits its own vocabulary (`task_created`, `plan_built`,
 * `model_selected`, …) — so the mapping from event name to stage lives here, in
 * one place, tested against every event name the contract lists. A screen that
 * matched events to stages inline would drift the moment a new event appeared.
 *
 * The reducer is pure and order-independent over a *complete* buffer: feeding it
 * the replayed backlog of a finished task produces the same result as having
 * watched the task run live. That is what makes a late subscriber safe.
 */

import type { AgentEvent } from "@/lib/sse";

export type StageStatus = "pending" | "active" | "done" | "failed";

export type StageId =
  | "identity"
  | "authorization"
  | "risk"
  | "retrieval"
  | "model"
  | "execution"
  | "validation"
  | "checkpoint"
  | "audit";

export type Stage = {
  id: StageId;
  name: string;
  status: StageStatus;
  /** A short line of machine truth: the model chosen, the source count, why. */
  detail: string;
};

/** The nine stages, in order, matching the `front` reasoning timeline. */
export const STAGES: ReadonlyArray<{ id: StageId; name: string }> = [
  { id: "identity", name: "Identity Check" },
  { id: "authorization", name: "Authorization" },
  { id: "risk", name: "Risk Classification" },
  { id: "retrieval", name: "Retrieval" },
  { id: "model", name: "Model Selection" },
  { id: "execution", name: "Execution" },
  { id: "validation", name: "Validation" },
  { id: "checkpoint", name: "Checkpoint" },
  { id: "audit", name: "Audit Log" },
];

const STAGE_ORDER = STAGES.map((stage) => stage.id);

/** The backend events that end the run. */
export const TERMINAL = new Set([
  "task_completed",
  "task_failed",
  "task_cancelled",
]);

/** The backend events that mean a stage failed rather than progressed. */
const FAILURE = new Set([
  "task_failed",
  "task_cancelled",
  "reasoning_failed",
  "tool_denied",
  "permission_denied",
]);

/**
 * Which stage an event advances, and to what status.
 *
 * `done` on a stage implicitly marks every earlier `pending` stage `done` too —
 * the backend does not announce "identity checked" separately, but by the time
 * it has built a plan that step has demonstrably happened.
 */
const EVENT_STAGE: Record<string, { stage: StageId; status: StageStatus }> = {
  task_created: { stage: "identity", status: "done" },
  task_started: { stage: "authorization", status: "done" },
  request_analysed: { stage: "risk", status: "done" },
  plan_built: { stage: "execution", status: "active" },
  tool_called: { stage: "execution", status: "active" },
  tool_completed: { stage: "execution", status: "active" },
  retrieval_completed: { stage: "retrieval", status: "done" },
  model_selected: { stage: "model", status: "done" },
  reasoning_completed: { stage: "execution", status: "done" },
  approval_requested: { stage: "checkpoint", status: "active" },
  artifact_generated: { stage: "execution", status: "done" },
  validation_completed: { stage: "validation", status: "done" },
  task_completed: { stage: "audit", status: "done" },
};

/** Everything a screen needs to render a run, derived from its events. */
export type PipelineState = {
  stages: Stage[];
  /** The assistant's answer, once `reasoning_completed` or the task carries it. */
  answer: string | null;
  citations: Citation[];
  artifacts: ArtifactRef[];
  /** Set while the run is paused at the approval gate. */
  awaitingApproval: boolean;
  /** From `model_selected`: which model, and the router's reasoning. */
  routing: ModelRouting | null;
  /** The three numbers, kept apart on purpose. Any may be absent. */
  confidence: number | null;
  evidenceSufficiency: number | null;
  validation: "passed" | "failed" | "partial" | null;
  /** Set once a terminal event has been seen. */
  outcome: "completed" | "failed" | "cancelled" | null;
  /** The failure message, if the run ended badly. */
  error: string | null;
};

export type Citation = {
  documentId: string | null;
  documentName: string;
  page: number | null;
  section: string | null;
  score: number | null;
  /** A finding the generator could not support renders as unsupported. */
  unsupported?: boolean;
};

export type ArtifactRef = {
  id: string;
  filename: string;
  mime: string | null;
  sizeBytes: number | null;
};

export type ModelRouting = {
  model: string;
  rationale: string;
  rejected: Array<{ model: string; reason: string }>;
};

function freshStages(): Stage[] {
  return STAGES.map((stage) => ({ ...stage, status: "pending", detail: "" }));
}

export function emptyPipeline(): PipelineState {
  return {
    stages: freshStages(),
    answer: null,
    citations: [],
    artifacts: [],
    awaitingApproval: false,
    routing: null,
    confidence: null,
    evidenceSufficiency: null,
    validation: null,
    outcome: null,
    error: null,
  };
}

// --- reading the loosely-typed `data` bag off an event --------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** A ratio that might arrive as 0..1 or as 0..100, normalised to a percentage. */
function pct(value: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  return Math.round(n <= 1 ? n * 100 : n);
}

function readCitations(data: Record<string, unknown>): Citation[] {
  const raw = data.citations ?? data.sources ?? data.evidence;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const c = (item ?? {}) as Record<string, unknown>;
    return {
      documentId: (c.document_id as string) ?? (c.documentId as string) ?? null,
      documentName:
        str(c.document_name) ||
        str(c.documentName) ||
        str(c.filename) ||
        str(c.source) ||
        "document",
      page: num(c.page ?? c.page_number),
      section: str(c.section) || null,
      score: num(c.score),
      unsupported: c.unsupported === true || str(c.support) === "none",
    };
  });
}

function readArtifacts(data: Record<string, unknown>): ArtifactRef[] {
  const raw = data.artifacts ?? data.outputs ?? data.output_files;
  const list = Array.isArray(raw)
    ? raw
    : data.artifact_id || data.filename
      ? [data]
      : [];
  return list.map((item) => {
    const a = (item ?? {}) as Record<string, unknown>;
    return {
      id: str(a.artifact_id) || str(a.id) || str(a.artifactId),
      filename: str(a.filename) || str(a.name) || "artifact",
      mime: str(a.mime_type) || str(a.mime) || str(a.content_type) || null,
      sizeBytes: num(a.size_bytes ?? a.size),
    };
  });
}

function readRouting(data: Record<string, unknown>): ModelRouting | null {
  const model = str(data.model_id) || str(data.model) || str(data.selected_model);
  if (!model) return null;
  const rejectedRaw = data.rejected ?? data.alternatives ?? data.considered;
  const rejected = Array.isArray(rejectedRaw)
    ? rejectedRaw.map((item) => {
        const r = (item ?? {}) as Record<string, unknown>;
        return {
          model: str(r.model_id) || str(r.model) || "model",
          reason: str(r.reason) || str(r.rejected_reason) || "not selected",
        };
      })
    : [];
  return {
    model,
    rationale:
      str(data.rationale) ||
      str(data.reason) ||
      str(data.why) ||
      "Selected by the router.",
    rejected,
  };
}

function detailFor(event: AgentEvent): string {
  const d = event.data ?? {};
  switch (event.event) {
    case "model_selected": {
      const model = str(d.model_id) || str(d.model);
      const why = str(d.rationale) || str(d.reason);
      return [model, why].filter(Boolean).join(" — ");
    }
    case "retrieval_completed": {
      const n = num(d.source_count ?? d.count ?? (Array.isArray(d.sources) ? d.sources.length : null));
      return n === null ? "Knowledge retrieved" : `${n} source${n === 1 ? "" : "s"} retrieved`;
    }
    case "validation_completed": {
      return str(d.summary) || str(d.checked) || "Checked against the cited evidence";
    }
    case "tool_called":
    case "tool_completed":
      return str(d.tool) || str(d.name) ? `Tool: ${str(d.tool) || str(d.name)}` : "";
    case "plan_built": {
      const steps = Array.isArray(d.steps) ? d.steps.length : null;
      return steps === null ? "Plan prepared" : `Plan: ${steps} step${steps === 1 ? "" : "s"}`;
    }
    case "approval_requested":
      return str(d.reason) || str(d.message) || "Awaiting approver sign-off";
    default:
      return str(d.detail) || str(d.message) || str(d.summary) || "";
  }
}

function applyStage(stages: Stage[], id: StageId, status: StageStatus, detail: string): Stage[] {
  const index = STAGE_ORDER.indexOf(id);
  if (index === -1) return stages;
  return stages.map((stage, i) => {
    if (i < index && stage.status === "pending") return { ...stage, status: "done" };
    if (i !== index) return stage;
    // Never walk a stage backwards from done.
    const next: StageStatus = stage.status === "done" && status === "active" ? "done" : status;
    return { ...stage, status: next, detail: detail || stage.detail };
  });
}

/** Fold one event into the state. */
export function applyEvent(state: PipelineState, event: AgentEvent): PipelineState {
  const data = event.data ?? {};
  let next: PipelineState = { ...state, stages: state.stages };

  // Stage progression.
  const mapping = EVENT_STAGE[event.event];
  if (mapping) {
    next.stages = applyStage(next.stages, mapping.stage, mapping.status, detailFor(event));
  }

  // Failure: fail the stage that was in flight, and stop.
  if (FAILURE.has(event.event)) {
    const activeIndex = next.stages.findIndex((s) => s.status === "active");
    const target = activeIndex === -1 ? next.stages.findIndex((s) => s.status === "pending") : activeIndex;
    if (target !== -1) {
      next.stages = next.stages.map((s, i) =>
        i === target
          ? { ...s, status: "failed", detail: str(data.reason) || str(data.message) || s.detail }
          : s,
      );
    }
    next.error = str(data.message) || str(data.reason) || `The task ${event.event.replace("task_", "")}.`;
  }

  // Answer text can arrive on reasoning_completed, artifact_generated, or the
  // terminal event.
  const answer =
    str(data.output_text) ||
    str(data.answer) ||
    str(data.text) ||
    str((data.result as Record<string, unknown> | undefined)?.output_text);
  if (answer) next.answer = answer;

  const citations = readCitations(data);
  if (citations.length) next.citations = citations;

  const artifacts = readArtifacts(data);
  if (artifacts.length) {
    const seen = new Set(next.artifacts.map((a) => a.id));
    next.artifacts = [...next.artifacts, ...artifacts.filter((a) => a.id && !seen.has(a.id))];
  }

  if (event.event === "model_selected") {
    next.routing = readRouting(data) ?? next.routing;
  }

  if (event.event === "approval_requested") next.awaitingApproval = true;
  if (event.event === "task_completed" || event.event === "task_failed") {
    next.awaitingApproval = false;
  }

  if (event.event === "validation_completed") {
    const verdict = str(data.result || data.status || data.verdict).toLowerCase();
    next.validation =
      verdict.includes("pass") ? "passed" : verdict.includes("fail") ? "failed" : verdict.includes("partial") ? "partial" : next.validation;
    next.confidence = pct(data.confidence) ?? next.confidence;
    next.evidenceSufficiency =
      pct(data.evidence_sufficiency ?? data.evidence_score) ?? next.evidenceSufficiency;
  }
  // Some runs carry the numbers on the terminal event instead.
  next.confidence = next.confidence ?? pct(data.confidence);
  next.evidenceSufficiency = next.evidenceSufficiency ?? pct(data.evidence_sufficiency);

  // Terminal handling.
  if (event.event === "task_completed") {
    next.outcome = "completed";
    next.stages = next.stages.map((s) =>
      s.status === "pending" || s.status === "active" ? { ...s, status: "done" } : s,
    );
  } else if (event.event === "task_failed") {
    next.outcome = "failed";
  } else if (event.event === "task_cancelled") {
    next.outcome = "cancelled";
  }

  return next;
}

/** Fold a whole buffer — the shape a replayed backlog arrives in. */
export function reducePipeline(events: Iterable<AgentEvent>): PipelineState {
  let state = emptyPipeline();
  for (const event of events) state = applyEvent(state, event);
  return state;
}

/** True once nothing more will change and the UI should stop showing a spinner. */
export function isSettled(state: PipelineState): boolean {
  return state.outcome !== null;
}
