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

export type Evidence = {
  document_id: string;
  document_name: string;
  page: number;
  section: string | null;
  text: string;
  score: number;
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
export type TaskReceipt = {
  task_id?: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  inputs?: Array<{ kind: string; name: string; id?: string }>;
  models_used?: string[];
  tools_used?: string[];
  sources?: Array<{ document_name: string; page?: number | null }>;
  artifacts?: Array<{ id: string; filename: string; mime_type?: string; size_bytes?: number }>;
  security_events?: Array<{ kind: string; detail: string; at?: string }>;
  external_calls?: number;
  sovereignty?: string;
  [key: string]: unknown;
};
