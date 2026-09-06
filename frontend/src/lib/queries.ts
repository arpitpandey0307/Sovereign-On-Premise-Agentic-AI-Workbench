/**
 * One hook per endpoint, typed against the backend's responses.
 *
 * Screens call these rather than `api` directly, so a change to an endpoint is
 * one edit instead of a search across pages, and so query keys are structured
 * consistently -- a task update can then invalidate exactly what it should
 * rather than everything.
 *
 * Staleness is chosen per endpoint rather than globally. Reference data
 * (models, tools, permissions) barely moves; anything a task run changes is
 * fetched fresh. Nothing polls that the task event stream already reports.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  Conversation,
  DocumentSummary,
  FileRecord,
  ModelDescriptor,
  Page,
  Permissions,
  SearchResponse,
  Sovereignty,
  SystemStatus,
  Task,
  ToolDescriptor,
} from "@/lib/types";

/** Structured so a subtree can be invalidated without touching its siblings. */
export const keys = {
  me: ["auth", "me"] as const,
  permissions: ["auth", "permissions"] as const,
  systemStatus: ["system", "status"] as const,
  sovereignty: ["security", "sovereignty"] as const,
  audit: (filters: Record<string, unknown>) =>
    ["security", "audit", filters] as const,
  networkEvents: ["security", "network-events"] as const,
  files: ["files"] as const,
  documents: (page: number) => ["documents", page] as const,
  document: (id: string) => ["documents", id] as const,
  documentPage: (id: string, page: number) =>
    ["documents", id, "pages", page] as const,
  tasks: (filters: Record<string, unknown> = {}) => ["tasks", filters] as const,
  task: (id: string) => ["tasks", id] as const,
  taskExecution: (id: string) => ["tasks", id, "execution"] as const,
  taskArtifacts: (id: string) => ["tasks", id, "artifacts"] as const,
  taskReceipt: (id: string) => ["tasks", id, "receipt"] as const,
  conversations: ["conversations"] as const,
  models: ["models"] as const,
  modelHealth: ["models", "health"] as const,
  tools: ["tools"] as const,
  knowledgeStatus: ["knowledge", "status"] as const,
  sandboxStatus: ["sandbox", "status"] as const,
};

/** Data that changes rarely; refetching it on every mount is noise. */
const REFERENCE = { staleTime: 5 * 60_000 } as const;
/** Anything a task run can change. */
const LIVE = { staleTime: 0 } as const;

type Options<T> = Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">;

// --- identity and policy ---------------------------------------------------

export function usePermissions(options?: Options<Permissions>) {
  return useQuery({
    queryKey: keys.permissions,
    queryFn: () => api.get<Permissions>("/api/v1/security/permissions"),
    ...REFERENCE,
    ...options,
  });
}

// --- system ----------------------------------------------------------------

export function useSystemStatus(options?: Options<SystemStatus>) {
  return useQuery({
    queryKey: keys.systemStatus,
    queryFn: () => api.get<SystemStatus>("/api/v1/system/status"),
    staleTime: 30_000,
    ...options,
  });
}

export function useSovereignty(options?: Options<Sovereignty>) {
  return useQuery({
    queryKey: keys.sovereignty,
    queryFn: () => api.get<Sovereignty>("/api/v1/security/sovereignty"),
    refetchInterval: 30_000,
    ...options,
  });
}

// --- files and documents ---------------------------------------------------

export function useFiles(options?: Options<Page<FileRecord>>) {
  return useQuery({
    queryKey: keys.files,
    queryFn: () => api.get<Page<FileRecord>>("/api/v1/files"),
    ...LIVE,
    ...options,
  });
}

export function useDocuments(
  page = 0,
  limit = 25,
  options?: Options<Page<DocumentSummary>>,
) {
  return useQuery({
    queryKey: keys.documents(page),
    queryFn: () =>
      api.get<Page<DocumentSummary>>(
        `/api/v1/documents?limit=${limit}&offset=${page * limit}`,
      ),
    ...LIVE,
    ...options,
  });
}

export function useDocument(id: string, options?: Options<DocumentSummary>) {
  return useQuery({
    queryKey: keys.document(id),
    queryFn: () => api.get<DocumentSummary>(`/api/v1/documents/${id}`),
    enabled: Boolean(id),
    ...options,
  });
}

/**
 * Upload a file.
 *
 * Ingestion runs in the background after the response, so the document list is
 * invalidated rather than assumed current -- the file appears immediately, its
 * chunks a moment later.
 */
export function useUploadFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post<FileRecord>("/api/v1/files/upload", form);
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: keys.files });
      client.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

// --- knowledge -------------------------------------------------------------

export function useKnowledgeSearch() {
  return useMutation({
    mutationFn: (body: {
      query: string;
      limit?: number;
      document_ids?: string[];
    }) => api.post<SearchResponse>("/api/v1/knowledge/search", body),
  });
}

// --- tasks -----------------------------------------------------------------

export function useTasks(
  filters: { status?: string; limit?: number } = {},
  options?: Options<Page<Task>>,
) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  params.set("limit", String(filters.limit ?? 25));

  return useQuery({
    queryKey: keys.tasks(filters),
    queryFn: () => api.get<Page<Task>>(`/api/v1/tasks?${params}`),
    ...LIVE,
    ...options,
  });
}

export function useTask(id: string, options?: Options<Task>) {
  return useQuery({
    queryKey: keys.task(id),
    queryFn: () => api.get<Task>(`/api/v1/tasks/${id}`),
    enabled: Boolean(id),
    ...LIVE,
    ...options,
  });
}

export function useTaskExecution(id: string, options?: Options<unknown>) {
  return useQuery({
    queryKey: keys.taskExecution(id),
    queryFn: () => api.get(`/api/v1/tasks/${id}/execution`),
    enabled: Boolean(id),
    ...LIVE,
    ...options,
  });
}

export function useCreateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      conversation_id: string;
      request_text: string;
      task_type?: string;
      input_file_ids?: string[];
    }) => api.post<Task>("/api/v1/tasks", body),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

/** Answer an approval gate. The task resumes from the artifact, not the top. */
export function useResumeTask(taskId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { approved: boolean; note?: string }) =>
      api.post<Task>(`/api/v1/tasks/${taskId}/resume`, body),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: keys.task(taskId) });
      client.invalidateQueries({ queryKey: keys.taskExecution(taskId) });
    },
  });
}

export function useCancelTask(taskId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<Task>(`/api/v1/tasks/${taskId}/cancel`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.task(taskId) }),
  });
}

// --- conversations ---------------------------------------------------------

export function useConversations(options?: Options<Page<Conversation>>) {
  return useQuery({
    queryKey: keys.conversations,
    queryFn: () => api.get<Page<Conversation>>("/api/v1/conversations"),
    ...options,
  });
}

export function useCreateConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (title: string) =>
      api.post<Conversation>("/api/v1/conversations", { title }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.conversations }),
  });
}

// --- models and tools ------------------------------------------------------

export function useModels(options?: Options<{ models: ModelDescriptor[] }>) {
  return useQuery({
    queryKey: keys.models,
    queryFn: () => api.get<{ models: ModelDescriptor[] }>("/api/v1/models"),
    ...REFERENCE,
    ...options,
  });
}

export function useTools(options?: Options<{ tools: ToolDescriptor[] }>) {
  return useQuery({
    queryKey: keys.tools,
    queryFn: () => api.get<{ tools: ToolDescriptor[] }>("/api/v1/tools"),
    ...REFERENCE,
    ...options,
  });
}

/** Ask the router what it would choose, without spending any GPU time. */
export function usePreviewRouting() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<Record<string, unknown>>("/api/v1/models/route", body),
  });
}
