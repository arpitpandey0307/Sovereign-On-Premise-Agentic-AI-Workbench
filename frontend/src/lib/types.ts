/** Response shapes from the backend, typed once. */

export type Role =
  | "ENGINEER"
  | "ANALYST"
  | "MANAGER"
  | "ADMIN"
  | "SECURITY_ADMIN";

export type Classification =
  | "PUBLIC"
  | "INTERNAL"
  | "CONFIDENTIAL"
  | "HIGHLY_CONFIDENTIAL";

export type TaskStatus =
  | "pending"
  | "planning"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type User = {
  id: string;
  email: string;
  name: string;
  roles: Role[];
};

export type LoginResponse = {
  access_token: string;
  token_type: string;
  expires_at: string;
};

/**
 * What the caller may do, from the policy engine.
 *
 * `clearance` is "none" for a role the engine does not recognise -- which is a
 * denial, not a default, and the UI has to render it as one.
 */
export type Permissions = {
  roles: Role[];
  clearance: Classification | "none";
  readable_classifications: Classification[];
  permissions: string[]; // "resource:action"
};

export type SystemStatus = {
  status: string;
  app: string;
  version: string;
  external_network_allowed: boolean;
  object_storage: string;
  model_runtime: { reachable: boolean; detail: string };
  event_buffers_retained: number;
  parts: Record<string, "live" | "stub">;
};

export type Sovereignty = {
  external_requests: number;
  external_connections: number;
  external_dns_queries: number;
  local_connections: number;
  local_dns_queries: number;
  network_egress: "BLOCKED" | "BREACHED";
  /** False means nothing is watching -- which is not the same as "clean". */
  monitoring: boolean;
  monitoring_since: string | null;
  recent_external: Array<{
    kind: string;
    host: string;
    port: number;
    task_id: string | null;
    at: string;
  }>;
  how_it_is_enforced?: string[];
};

export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

/** One outbound connection the egress monitor observed. */
export type NetworkEvent = {
  kind: string;
  host: string;
  port: number;
  task_id: string | null;
  at: string;
};

/**
 * One line of the audit ledger. Denials (`PERMISSION_DENIED`, `TOOL_DENIED`,
 * `EXTERNAL_CALL_ATTEMPTED`) are the entries that prove the controls are live,
 * so the screen makes them prominent. Typed permissively.
 */
export type AuditEvent = {
  id: string;
  timestamp: string;
  event_type: string;
  component: string;
  action: string;
  user_email?: string | null;
  user_id?: string | null;
  task_id?: string | null;
  decision?: string | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

/** The audit page carries the filter menu with it, so the two cannot drift. */
export type AuditPage = Page<AuditEvent> & { known_event_types: string[] };

/**
 * The whole policy in force, from `GET /api/v1/security/status`. Read-only on
 * this deployment — policy lives in configuration, not a store. Permissive.
 */
export type PolicyRule = {
  local_models_only?: boolean;
  max_tool_risk?: string;
  human_approval_required?: boolean;
  restricted_artifact_storage?: boolean;
  notes?: string;
};

/**
 * The whole policy in force, from `GET /api/v1/security/status`.
 *
 * The backend keys `policy` and `roles` by name rather than sending arrays, so
 * both are objects here — reading them as arrays is what an earlier version of
 * this file did, and `.map` on an object throws during render.
 */
export type SecurityStatus = {
  classification_levels?: Classification[];
  policy?: Partial<Record<Classification, PolicyRule>>;
  roles?: Partial<
    Record<Role, { clearance: Classification | "none"; readable_classifications: Classification[] }>
  >;
  sovereignty?: Sovereignty;
  [key: string]: unknown;
};

/**
 * What `POST /api/v1/models/route` returns — the router's reasoning without
 * running anything.
 *
 * `selected` is the chosen model *object*, not its id; `ranked` carries the
 * score breakdown for the survivors and `rejected` names the stage that ruled
 * each candidate out. There is no `stages` array — the stage is a field on
 * each rejection.
 */
export type RoutingFactor = {
  name: string;
  value?: number;
  weight?: number;
  contribution?: number;
  why?: string;
};

export type RoutingDecision = {
  selected?: {
    model_id: string;
    type?: string;
    capabilities?: string[];
    context_length?: number;
    vram_required_gb?: number;
    status?: string;
  } | null;
  rationale?: string;
  requirements?: {
    task_type?: string;
    model_type?: string | null;
    required_capabilities?: string[];
    preferred_capabilities?: string[];
    classification?: Classification;
    estimated_context_tokens?: number;
    needs_vision?: boolean;
    needs_structured_output?: boolean;
    exclude_models?: string[];
  };
  hardware?: {
    gpu?: string;
    present?: boolean;
    total_vram_gb?: number;
    free_vram_gb?: number;
    usable_vram_gb?: number;
    pressure?: number;
  };
  considered?: number;
  ranked?: Array<{ model_id: string; total?: number; factors?: RoutingFactor[] }>;
  rejected?: Array<{ model_id: string; stage: string; reason: string }>;
  fallback_chain?: string[];
  [key: string]: unknown;
};

export type Task = {
  task_id: string;
  id: string;
  conversation_id: string;
  user_id: string;
  request_text: string;
  task_type: string;
  status: TaskStatus;
  input_file_ids: string[];
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type Conversation = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
};

export type FileRecord = {
  id: string;
  owner_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  ingestion_status: string;
  uploaded_at: string;
};

export type DocumentSummary = {
  id: string;
  file_id: string;
  filename: string;
  mime_type: string;
  kind: string;
  classification: Classification;
  classification_reason: string;
  version: number;
  status: string;
  page_count: number;
  chunk_count: number;
  indexed_in_graph: boolean;
  ingest_error: string;
  created_at: string;
};

/**
 * One page of a document.
 *
 * `text` is the real text layer plus anything OCR recovered. `vision_summary`
 * is a model's description of the page and the backend keeps it *out* of
 * `text` deliberately, so a generated description can never be quoted as the
 * page's own words. The UI must preserve that separation.
 */
export type DocumentPage = {
  document_id: string;
  page_number: number;
  text: string;
  ocr_status: "none" | "ocr" | "failed" | string;
  ocr_confidence: number | null;
  vision_summary: string | null;
  vision_model: string | null;
};

export type Evidence = {
  document_id: string;
  document_name: string;
  page: number;
  section: string | null;
  text: string;
  score: number;
};

/**
 * A deliverable the Workbench produced.
 *
 * A failed artifact is kept and shown, not hidden -- `validation_detail` lists
 * every check the validator ran with its result, so the operator can see what
 * it objected to. Typed permissively; the backend owns the exact shape.
 */
export type Artifact = {
  id: string;
  task_id?: string;
  filename: string;
  mime_type?: string;
  size_bytes?: number;
  created_at?: string;
  validation_status?: "passed" | "failed" | "pending" | string;
  validation_detail?: Array<{ check: string; result: string; message?: string }>;
  preview?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * "What relates to P-103", answered as a graph traversal. `source` says how:
 * `graph_traversal` is a real modelled relationship; `page_co_occurrence` only
 * means the tags appear on the same page, which is a weaker claim and must be
 * labelled as such.
 */
export type EquipmentGraph = {
  tag: string;
  type?: string;
  source: "graph_traversal" | "page_co_occurrence" | string;
  neighbours?: Array<{
    tag: string;
    type?: string;
    relation?: string;
    documents?: Array<{ id: string; name: string; page?: number }>;
  }>;
  documents?: Array<{ id: string; name: string; page?: number }>;
  [key: string]: unknown;
};

export type SearchResponse = {
  query: string;
  evidence: Evidence[];
  diagnostics: {
    vector_backend: string;
    keyword_backend: string;
    rerank_method: string;
    vector_hits: number;
    keyword_hits: number;
    chunks_considered: number;
    classifications_allowed: Classification[];
    notes: string[];
  };
};

export type ModelDescriptor = {
  model_id: string;
  type: string;
  capabilities: string[];
  context_length: number;
  vram_required_gb: number;
  approved_for: string[];
  status: "ready" | "loading" | "unavailable";
  name: string;
  provider: string;
  quantization: string;
  status_detail: string;
  notes: string;
};

export type ToolDescriptor = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk_level: "low" | "medium" | "high";
  requires_approval: boolean;
};

/**
 * The task receipt. Every field is derived from the audit ledger as the work
 * happened. The two that matter most for the product's argument are
 * `external_calls` and `sovereignty` -- shown against a real completed task,
 * they are the most convincing artefact it has.
 *
 * Typed permissively: the backend owns the exact shape and may carry more, but
 * these are the fields the trace screen reads.
 */
/**
 * What the sandbox runner enforces, as it reports it. Every field is a
 * verified property (`scripts/verify_sandbox.py` proves each), so the UI is
 * reporting fact rather than aspiration. Typed permissively; the runner owns
 * the shape.
 */
export type SandboxStatus = {
  /** Which runner the backend is configured to use, e.g. "docker". */
  runner?: string;
  /** Whether that runner actually answered. False means no code can run. */
  available?: boolean;
  /** Why, when it is not available. */
  detail?: string;
  image?: string;
  confinement?: {
    network?: string;
    root_filesystem?: string;
    workspace?: string;
    capabilities?: string;
    user?: string;
  };
  [key: string]: unknown;
};

export type TaskReceipt = {
  task_id?: string;
  user_id?: string;
  status?: string;
  request?: string;
  started_at?: string;
  finished_at?: string;
  events_recorded?: number;
  models_used?: string[];
  tools_used?: string[];
  /** Tools the policy engine refused. The ledger's proof that it said no. */
  tools_denied?: string[];
  /** Document names, not objects. */
  documents_consulted?: string[];
  input_files?: string[];
  /** Artifact ids, not objects — the filenames live on the artifact records. */
  artifacts?: string[];
  approvals?: Array<Record<string, unknown>>;
  external_calls?: number;
  sovereignty?: string;
  [key: string]: unknown;
};

/** One artifact, exactly as `GET /api/v1/tasks/{id}/artifacts` returns it. */
export type ArtifactRecord = {
  artifact_id: string;
  task_id: string;
  type: string;
  validation_status: "passed" | "failed" | "pending" | string;
  download_url: string;
};
