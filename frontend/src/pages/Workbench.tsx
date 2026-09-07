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
import {
  FileText,
  Gauge,
  Image as ImageIcon,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Plus,
  Table2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { isSupported as dictationSupported, startDictation, type Dictation } from "@/lib/dictation";
import { instructionPreamble, loadProfile } from "@/lib/profile";
import { useAuth } from "@/lib/auth";
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
  mergeExecution,
  type PipelineState,
  type TaskExecution,
} from "@/lib/pipeline";
import { streamTaskEvents, type AgentEvent } from "@/lib/sse";
import type { Page, Task } from "@/lib/types";
import { ReasoningTimeline } from "@/components/workbench/ReasoningTimeline";
import { Citations, Outputs } from "@/components/workbench/Sources";
import { ConfidenceRow } from "@/components/workbench/ConfidenceRow";
import { ModelRoutingCard } from "@/components/workbench/ModelRoutingCard";
import { CodeExecution } from "@/components/workbench/CodeExecution";

type Effort = "low" | "balanced" | "high";

/** The effort levels, and what each actually does to model choice. */
const EFFORTS: Array<{ id: Effort; label: string; hint: string }> = [
  { id: "low", label: "Low", hint: "Fast answer on the small model" },
  { id: "balanced", label: "Balanced", hint: "The router decides on merit" },
  { id: "high", label: "High", hint: "Reaches for the largest model that fits" },
];

type AttachKind = "all" | "documents" | "images" | "data";

/** What the `+` menu offers, and what each narrows the file dialog to. */
const ATTACH_KINDS: Array<{
  id: AttachKind;
  label: string;
  hint: string;
  Icon: typeof Paperclip;
}> = [
  {
    id: "documents",
    label: "Documents",
    hint: "PDF, Word, text — SOPs, reports, permits",
    Icon: FileText,
  },
  {
    id: "images",
    label: "Images & drawings",
    hint: "P&IDs and scans — read by OCR and the vision model",
    Icon: ImageIcon,
  },
  {
    id: "data",
    label: "Spreadsheets & data",
    hint: "Excel, CSV, JSON — logs and readings",
    Icon: Table2,
  },
  { id: "all", label: "Any file", hint: "Anything the ingester accepts", Icon: Paperclip },
];

const ACCEPT_FOR: Record<AttachKind, string> = {
  documents: ".pdf,.docx,.txt",
  images: ".png,.jpg,.jpeg,.tif,.tiff,.pdf",
  data: ".xlsx,.csv,.json",
  all: ".pdf,.png,.jpg,.jpeg,.tif,.tiff,.docx,.xlsx,.pptx,.csv,.txt,.json",
};


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
  const openConversationId = params.get("conversation");

  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  // How much thinking to give the request. It reaches the model router, which
  // biases towards a smaller or a larger model -- it is a real instruction,
  // not a label on the message.
  const [effort, setEffort] = useState<Effort>("balanced");
  /** Which kind of file the picker was opened for, so `accept` can narrow. */
  const [picking, setPicking] = useState<AttachKind>("all");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // One live subscription per assistant turn, so unmount can stop them all.
  const streams = useRef(new Map<string, () => void>());

  const createConversation = useCreateConversation();
  const createTask = useCreateTask();
  const uploadFile = useUploadFile();
  const { user } = useAuth();

  // Dictation. The text it produces lands in the box and is sent by hand --
  // speech never starts a task on its own, so what the model is given is
  // always something a person read first.
  const dictation = useRef<Dictation | null>(null);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  // Resolved once: the button must not appear and then vanish.
  const [canDictate] = useState(() => dictationSupported());

  const stopDictation = useCallback(() => {
    dictation.current?.stop();
    dictation.current = null;
    setListening(false);
    setHeard("");
  }, []);

  // A run left listening when the screen goes away keeps the microphone open.
  useEffect(() => stopDictation, [stopDictation]);

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
      // The stream announces *counts* -- "2 results", "1 finding" -- not the
      // passages themselves or the validator's checks. Those are on the
      // execution trace, so a finished run is completed from there; without
      // this the turn renders with no citations at all.
      try {
        const [task, execution] = await Promise.all([
          api.get<Task>(`/api/v1/tasks/${taskId}`),
          api
            .get<TaskExecution>(`/api/v1/tasks/${taskId}/execution`)
            .catch(() => null),
        ]);
        setTurns((current) =>
          current.map((turn) => {
            if (turn.kind !== "assistant" || turn.taskId !== taskId) return turn;
            let pipeline = execution
              ? mergeExecution(turn.pipeline, execution)
              : turn.pipeline;
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

  /**
   * Reopen a past conversation from the history list.
   *
   * Rebuilt from the tasks it produced rather than from the event stream: the
   * stream's backlog is held in memory and is gone after a restart, while the
   * tasks and their execution records are kept. Each run contributes the
   * question that was asked and the answer's citations, which is what someone
   * scrolling back is looking for.
   */
  useEffect(() => {
    if (!openConversationId) return;
    let cancelled = false;

    (async () => {
      setTurns([]);
      setConversationId(openConversationId);
      try {
        // No server-side filter by conversation, so a recent page is fetched
        // and narrowed here.
        const page = await api.get<Page<Task>>("/api/v1/tasks?limit=100");
        const mine = page.items
          .filter((task) => task.conversation_id === openConversationId)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));

        const rebuilt = await Promise.all(
          mine.map(async (task) => {
            const execution = await api
              .get<TaskExecution>(`/api/v1/tasks/${task.task_id}/execution`)
              .catch(() => null);
            let pipeline = emptyPipeline();
            if (execution) pipeline = mergeExecution(pipeline, execution);
            return { task, pipeline };
          }),
        );
        if (cancelled) return;

        const restored: Turn[] = [];
        for (const { task, pipeline } of rebuilt) {
          restored.push({ kind: "user", text: task.request_text });
          restored.push({
            kind: "assistant",
            taskId: task.task_id,
            pipeline: {
              ...pipeline,
              outcome:
                task.status === "completed"
                  ? "completed"
                  : task.status === "failed"
                    ? "failed"
                    : task.status === "cancelled"
                      ? "cancelled"
                      : pipeline.outcome,
              error: task.error_message ?? pipeline.error,
            },
            running: false,
            reconnecting: false,
            streamError: null,
          });
        }
        setTurns(restored);
      } catch (caught) {
        if (!cancelled) setComposerError(describeError(caught).detail);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [openConversationId]);

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

      // Standing instructions from the profile, prepended to what was typed.
      // Sent as part of the request rather than hidden somewhere the trace
      // cannot see: what the model was given has to be exactly what the
      // receipt shows it was given.
      const preamble = instructionPreamble(loadProfile(user?.id));

      const task = await createTask.mutateAsync({
        conversation_id: conversation,
        request_text: preamble ? `${preamble}\n\n${text}` : text,
        input_file_ids: fileIds.length ? fileIds : undefined,
        effort,
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

  function toggleDictation() {
    if (listening) {
      stopDictation();
      return;
    }

    setComposerError(null);
    // What was already typed is kept; dictation appends to it.
    const existing = draft.trim();
    const started = startDictation({
      onTranscript: (final, interim) => {
        setHeard(interim);
        const spoken = [final, interim].filter(Boolean).join(" ");
        setDraft([existing, spoken].filter(Boolean).join(" "));
      },
      onError: (message) => {
        if (message) setComposerError(message);
        stopDictation();
      },
      onEnd: () => {
        dictation.current = null;
        setListening(false);
        setHeard("");
      },
    });

    if (!started) {
      setComposerError(
        "Dictation could not start. Type your request instead.",
      );
      return;
    }
    dictation.current = started;
    setListening(true);
  }

  async function onPickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    setComposerError(null);
    // One at a time, and a failure stops the run rather than being swallowed:
    // silently attaching three of four files would send a task off with less
    // evidence than the operator believes it has.
    for (const file of files) {
      try {
        const record = await uploadFile.mutateAsync(file);
        setAttached((current) => [
          ...current,
          { id: record.id, filename: record.filename },
        ]);
      } catch (caught) {
        setComposerError(`${file.name}: ${describeError(caught).detail}`);
        return;
      }
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
              aria-label={attachOpen ? "Close the attach menu" : "Attach files"}
              aria-expanded={attachOpen}
              aria-haspopup="menu"
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
            {canDictate && (
              <button
                type="button"
                className="icon-sq"
                onClick={toggleDictation}
                aria-label={listening ? "Stop dictating" : "Dictate your request"}
                aria-pressed={listening}
                title={listening ? "Stop dictating" : "Dictate your request"}
                style={
                  listening
                    ? {
                        color: "var(--danger-text)",
                        borderColor: "var(--danger-line)",
                      }
                    : undefined
                }
              >
                {listening ? (
                  <MicOff className="size-4 animate-pulse" aria-hidden />
                ) : (
                  <Mic className="size-4" aria-hidden />
                )}
              </button>
            )}
            <button
              type="submit"
              className="send"
              disabled={!draft.trim() || sending}
              aria-label="Run task"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : "↑"}
            </button>
          </form>

          <AnimatePresence>
            {attachOpen && (
              <motion.div
                className="attach-menu"
                role="menu"
                aria-label="Attach"
                initial={{ opacity: 0, y: 6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.98 }}
                transition={{ duration: 0.14 }}
              >
                {ATTACH_KINDS.map((kind) => (
                  <button
                    key={kind.id}
                    type="button"
                    role="menuitem"
                    className="attach-menu-item"
                    onClick={() => {
                      setPicking(kind.id);
                      setAttachOpen(false);
                      // The accept attribute has to be in the DOM before the
                      // dialog opens, so the click waits a frame.
                      requestAnimationFrame(() => fileInputRef.current?.click());
                    }}
                  >
                    <span className="ico">
                      <kind.Icon className="size-4" aria-hidden />
                    </span>
                    <span>
                      <span className="t">{kind.label}</span>
                      <span className="d">{kind.hint}</span>
                    </span>
                  </button>
                ))}
                <p className="attach-menu-foot">
                  Files are ingested on this machine. Classification is read
                  from each document&rsquo;s own markings.
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            accept={ACCEPT_FOR[picking]}
            onChange={onPickFile}
          />

          {(attached.length > 0 || uploadFile.isPending) && (
            <div className="attached-row">
              {attached.map((file) => (
                <motion.span
                  className="file-chip"
                  key={file.id}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                >
                  <Paperclip className="size-3" aria-hidden />
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
                </motion.span>
              ))}
              {uploadFile.isPending && (
                <span className="file-chip">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  Uploading…
                </span>
              )}
            </div>
          )}

          {/* How hard to think about this. A real routing instruction: the
              backend biases model choice by it, so "low" genuinely answers on
              the small fast model and "high" reaches for the large one. */}
          <div className="effort-row">
            <span className="effort-label">
              <Gauge className="size-3.5" aria-hidden />
              Effort
            </span>
            <div className="effort-seg" role="radiogroup" aria-label="Reasoning effort">
              {EFFORTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={effort === option.id}
                  title={option.hint}
                  className={"effort-opt" + (effort === option.id ? " active" : "")}
                  onClick={() => setEffort(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="effort-hint">
              {EFFORTS.find((option) => option.id === effort)?.hint}
            </span>
          </div>

          {listening && (
            <p
              className="hint"
              role="status"
              aria-live="polite"
              style={{ marginTop: "8px", color: "var(--danger-text)" }}
            >
              Listening&hellip; {heard ? `“${heard}”` : "speak your request"} —
              the words go into the box, and nothing is sent until you press
              send.
            </p>
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

      {/* A sandbox that could not run and code that ran and failed are
          different things, and the difference matters. */}
      {pipeline.sandboxFailed ? (
        <div className="risk-callout danger">
          The sandbox could not run the code — it did not execute.
          {pipeline.sandboxDetail ? ` ${pipeline.sandboxDetail}` : ""}
        </div>
      ) : pipeline.error ? (
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

      {pipeline.codeRun && !pipeline.sandboxFailed && (
        <CodeExecution run={pipeline.codeRun} />
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
