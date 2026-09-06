/**
 * The AI Workbench.
 *
 * A conversation column, in the shape the `front` design system draws: the
 * thread, then a composer that takes text and files. What separates it from a
 * chatbot is the shape of the assistant's turn — a nine-stage reasoning
 * timeline driven by the live event stream, a structured result with its
 * citations and downloadable artifacts, the three quality numbers kept apart,
 * and an approval gate that actually pauses a running task.
 *
 * The stream is the centrepiece. Events fold into a `PipelineState` per task;
 * a dropped connection reconnects and a late attach replays the backlog, so
 * opening `?task=<id>` for a run that finished an hour ago rebuilds the whole
 * timeline.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Paperclip, Plus, X } from "lucide-react";
import { api, describeError } from "@/lib/api";
import {
  useCreateConversation,
  useCreateTask,
  useResumeTask,
  useUploadFile,
} from "@/lib/queries";
import {
  applyEvent,
  emptyPipeline,
  isSettled,
  type PipelineState,
} from "@/lib/pipeline";
import { streamTaskEvents, type AgentEvent } from "@/lib/sse";
import type { Task } from "@/lib/types";
import { ReasoningTimeline } from "@/components/workbench/ReasoningTimeline";
import { Citations, Outputs } from "@/components/workbench/Sources";
import { ConfidenceRow } from "@/components/workbench/ConfidenceRow";
import { ModelRoutingCard } from "@/components/workbench/ModelRoutingCard";

/** The classification a person tags an upload with, before it is ingested. */
const CLASSIFICATIONS = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "HIGHLY_CONFIDENTIAL",
] as const;

const SUGGESTIONS = [
  "Review this inspection report against the maintenance SOP and prepare an approval note.",
  "Identify the equipment and tags on this P&ID and explain the relief path.",
  "Summarise the overdue HAZOP action items across Unit 3.",
];

type AttachedFile = { id: string; filename: string };

type UserTurn = { kind: "user"; text: string };
type AssistantTurn = {
  kind: "assistant";
  taskId: string;
  pipeline: PipelineState;
  running: boolean;
  reconnecting: boolean;
  streamError: string | null;
};
type Turn = UserTurn | AssistantTurn;

export function Workbench() {
  const [params, setParams] = useSearchParams();
  const attachTaskId = params.get("task");

  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [classification, setClassification] =
    useState<(typeof CLASSIFICATIONS)[number]>("INTERNAL");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // One live subscription per assistant turn, so unmount can stop them all.
  const streams = useRef(new Map<string, () => void>());

  const createConversation = useCreateConversation();
  const createTask = useCreateTask();
  const uploadFile = useUploadFile();

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns]);

  const stopAll = useCallback(() => {
    for (const stop of streams.current.values()) stop();
    streams.current.clear();
  }, []);

  useEffect(() => stopAll, [stopAll]);

  /** Fold one event into the assistant turn it belongs to. */
  const onEvent = useCallback((taskId: string, event: AgentEvent) => {
    setTurns((current) =>
      current.map((turn) =>
        turn.kind === "assistant" && turn.taskId === taskId
          ? { ...turn, pipeline: applyEvent(turn.pipeline, event), reconnecting: false }
          : turn,
      ),
    );
  }, []);

  const settle = useCallback(
    async (taskId: string) => {
      // The stream usually carries the final answer, but not always. When it
      // does not, the task record and the orchestrator trace are authoritative.
      try {
        const task = await api.get<Task>(`/api/v1/tasks/${taskId}`);
        setTurns((current) =>
          current.map((turn) => {
            if (turn.kind !== "assistant" || turn.taskId !== taskId) return turn;
            let pipeline = turn.pipeline;
            if (!pipeline.answer && task.error_message) {
              pipeline = { ...pipeline, error: task.error_message };
            }
            const outcome =
              pipeline.outcome ??
              (task.status === "completed"
                ? "completed"
                : task.status === "failed"
                  ? "failed"
                  : task.status === "cancelled"
                    ? "cancelled"
                    : null);
            return { ...turn, pipeline: { ...pipeline, outcome }, running: false };
          }),
        );
      } catch {
        setTurns((current) =>
          current.map((turn) =>
            turn.kind === "assistant" && turn.taskId === taskId
              ? { ...turn, running: false }
              : turn,
          ),
        );
      }
    },
    [],
  );

  const follow = useCallback(
    (taskId: string) => {
      const stop = streamTaskEvents(taskId, {
        onEvent: (event) => onEvent(taskId, event),
        onReconnecting: () =>
          setTurns((current) =>
            current.map((turn) =>
              turn.kind === "assistant" && turn.taskId === taskId
                ? { ...turn, reconnecting: true }
                : turn,
            ),
          ),
        onClose: () => {
          streams.current.delete(taskId);
          void settle(taskId);
        },
        onError: (error) => {
          streams.current.delete(taskId);
          setTurns((current) =>
            current.map((turn) =>
              turn.kind === "assistant" && turn.taskId === taskId
                ? {
                    ...turn,
                    running: false,
                    reconnecting: false,
                    streamError: describeError(error).detail,
                  }
                : turn,
            ),
          );
          void settle(taskId);
        },
      });
      streams.current.set(taskId, stop);
    },
    [onEvent, settle],
  );

  // Attach to a task passed in the URL (Dashboard hands off this way, and it is
  // how a finished run is reopened).
  useEffect(() => {
    if (!attachTaskId || turns.length > 0) return;
    let cancelled = false;
    (async () => {
      let requestText = "";
      let conversation: string | null = null;
      try {
        const task = await api.get<Task>(`/api/v1/tasks/${attachTaskId}`);
        requestText = task.request_text;
        conversation = task.conversation_id;
      } catch {
        /* still attach the stream; the request text is a nicety */
      }
      if (cancelled) return;
      if (conversation) setConversationId(conversation);
      setTurns([
        ...(requestText ? [{ kind: "user" as const, text: requestText }] : []),
        {
          kind: "assistant",
          taskId: attachTaskId,
          pipeline: emptyPipeline(),
          running: true,
          reconnecting: false,
          streamError: null,
        },
      ]);
      follow(attachTaskId);
    })();
    return () => {
      cancelled = true;
    };
  }, [attachTaskId, turns.length, follow]);

  async function send(text: string) {
    setSending(true);
    setComposerError(null);
    const fileIds = attached.map((file) => file.id);

    try {
      let conversation = conversationId;
      if (!conversation) {
        const created = await createConversation.mutateAsync(
          text.split(/\s+/).slice(0, 6).join(" ") || "New task",
        );
        conversation = created.id;
        setConversationId(conversation);
      }

      // Best effort: the message record is not what drives the run, the task is.
      api
        .post(`/api/v1/conversations/${conversation}/messages`, {
          role: "user",
          content: text,
        })
        .catch(() => {});

      const task = await createTask.mutateAsync({
        conversation_id: conversation,
        request_text: text,
        input_file_ids: fileIds.length ? fileIds : undefined,
      });

      setTurns((current) => [
        ...current,
        { kind: "user", text },
        {
          kind: "assistant",
          taskId: task.task_id,
          pipeline: emptyPipeline(),
          running: true,
          reconnecting: false,
          streamError: null,
        },
      ]);
      setDraft("");
      setAttached([]);
      setAttachOpen(false);
      follow(task.task_id);
    } catch (caught) {
      setComposerError(describeError(caught).detail);
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    void send(text);
  }

  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const record = await uploadFile.mutateAsync(file);
      setAttached((current) => [
        ...current,
        { id: record.id, filename: record.filename },
      ]);
    } catch (caught) {
      setComposerError(describeError(caught).detail);
    }
  }

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 ? (
          <div className="chat-empty">
            <div className="glyph" />
            <h3>What would you like the workbench to do?</h3>
            <p>
              Attach the documents, ask the question. You will see the plan
              before anything runs, then each stage as it happens.
            </p>
            <div className="suggestion-row">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  onClick={() => setDraft(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-thread">
            {turns.map((turn, index) =>
              turn.kind === "user" ? (
                <div className="msg-user" key={`u${index}`}>
                  {turn.text}
                </div>
              ) : (
                <AssistantMessage
                  key={turn.taskId}
                  turn={turn}
                  onResumed={() => follow(turn.taskId)}
                />
              ),
            )}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-inner">
          <form className="composer-box" onSubmit={submit}>
            <button
              type="button"
              className="icon-sq"
              aria-label={attachOpen ? "Close attachments" : "Attach a file"}
              aria-expanded={attachOpen}
              onClick={() => setAttachOpen((open) => !open)}
            >
              {attachOpen ? <X className="size-4" /> : <Plus className="size-4" />}
            </button>
            <textarea
              rows={1}
              value={draft}
              placeholder="Review this inspection report against the maintenance SOP and prepare an approval note."
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit(event);
                }
              }}
            />
            <button
              type="submit"
              className="send"
              disabled={!draft.trim() || sending}
              aria-label="Run task"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : "↑"}
            </button>
          </form>

          {attachOpen && (
            <div className="attach-pop">
              <div className="row">
                <span className="field-label" style={{ margin: 0 }}>
                  Classification
                </span>
                <select
                  className="select"
                  style={{ maxWidth: "260px" }}
                  value={classification}
                  onChange={(event) =>
                    setClassification(
                      event.target.value as (typeof CLASSIFICATIONS)[number],
                    )
                  }
                >
                  {CLASSIFICATIONS.map((value) => (
                    <option key={value} value={value}>
                      {value.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadFile.isPending}
                >
                  <Paperclip className="size-3.5" aria-hidden />
                  {uploadFile.isPending ? "Uploading…" : "Choose file"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  onChange={onPickFile}
                />
              </div>
              <div className="chip-list">
                {attached.length === 0 ? (
                  <span className="hint">No documents attached.</span>
                ) : (
                  attached.map((file) => (
                    <span className="file-chip" key={file.id}>
                      {file.filename}
                      <button
                        type="button"
                        aria-label={`Remove ${file.filename}`}
                        onClick={() =>
                          setAttached((current) =>
                            current.filter((f) => f.id !== file.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <span className="hint">
                Attached files are ingested, then passed to the task as
                input_file_ids.
              </span>
            </div>
          )}

          {composerError && (
            <p className="error-note" style={{ marginTop: "10px" }}>
              {composerError}
            </p>
          )}

          <p className="disclaimer">
            Runs entirely on-premises. Output is a draft for review — verify
            against the cited sources.
          </p>
        </div>
      </div>

      {/* Keep the selector's stale `?task` out of the URL once a real
          conversation is going, so a refresh does not reattach a finished run. */}
      <UrlSync
        clearTask={turns.length > 0 && !attachTaskId}
        params={params}
        setParams={setParams}
      />
    </div>
  );
}

function AssistantMessage({
  turn,
  onResumed,
}: {
  turn: AssistantTurn;
  onResumed: () => void;
}) {
  const { pipeline, running } = turn;
  const settled = isSettled(pipeline);

  return (
    <div className="msg-ai">
      <ReasoningTimeline state={pipeline} running={running && !settled} />

      {turn.reconnecting && (
        <div className="risk-callout warn">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Reconnecting to the task stream…
        </div>
      )}

      {pipeline.routing && <ModelRoutingCard routing={pipeline.routing} />}

      {pipeline.awaitingApproval && (
        <ApprovalGate taskId={turn.taskId} pipeline={pipeline} onResumed={onResumed} />
      )}

      {pipeline.error ? (
        <div className="risk-callout danger">{pipeline.error}</div>
      ) : pipeline.answer ? (
        <div className="body">{pipeline.answer}</div>
      ) : running ? (
        <div className="body muted">Working…</div>
      ) : (
        <div className="body muted">
          The task finished without returning text. See the trace for what it
          did.
        </div>
      )}

      {(pipeline.confidence != null ||
        pipeline.evidenceSufficiency != null ||
        pipeline.validation != null) && <ConfidenceRow state={pipeline} />}

      <Citations items={pipeline.citations} />
      <Outputs items={pipeline.artifacts} />

      {turn.streamError && !pipeline.error && (
        <p className="hint" style={{ color: "var(--warn-text)" }}>
          The live stream dropped: {turn.streamError}
        </p>
      )}
    </div>
  );
}

/**
 * The approval gate, inline in the thread.
 *
 * The run has genuinely paused — the backend is holding state. Approve and
 * Reject both `POST /resume`; inverting `approved` would be a serious bug, so
 * the two buttons pass the literal value and nothing computes it.
 */
function ApprovalGate({
  taskId,
  pipeline,
  onResumed,
}: {
  taskId: string;
  pipeline: PipelineState;
  onResumed: () => void;
}) {
  const resume = useResumeTask(taskId);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function answer(approved: boolean) {
    setError(null);
    try {
      await resume.mutateAsync({ approved, note: note.trim() || undefined });
      onResumed();
    } catch (caught) {
      setError(describeError(caught).detail);
    }
  }

  return (
    <div className="approval-card risk-medium">
      <div className="grow">
        <div className="a-head">
          <span className="a-title">Approval required</span>
          <span className="pill warn">DRAFT — NOT A DECISION</span>
        </div>
        <p className="a-meta">
          The task has paused before a consequential step. This is the product
          admitting its own limits — the output is proposed, for a person to
          approve.
        </p>
        {pipeline.artifacts[0] && (
          <p className="a-meta">Artifact: {pipeline.artifacts[0].filename}</p>
        )}
        <textarea
          className="textarea mono"
          rows={2}
          placeholder="Optional note for the record…"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          style={{ marginTop: "10px", fontSize: "13px" }}
        />
        {error && (
          <p className="error-note" style={{ marginTop: "8px" }}>
            {error}
          </p>
        )}
      </div>
      <div className="a-actions">
        <button
          type="button"
          className="btn btn-sm btn-ok"
          disabled={resume.isPending}
          onClick={() => answer(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={resume.isPending}
          onClick={() => answer(false)}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/** A tiny effect-only child, so the URL write does not re-run the parent. */
function UrlSync({
  clearTask,
  params,
  setParams,
}: {
  clearTask: boolean;
  params: URLSearchParams;
  setParams: (next: URLSearchParams, options?: { replace?: boolean }) => void;
}) {
  useEffect(() => {
    if (clearTask && params.has("task")) {
      const next = new URLSearchParams(params);
      next.delete("task");
      setParams(next, { replace: true });
    }
  }, [clearTask, params, setParams]);
  return null;
}
