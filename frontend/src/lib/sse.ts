/**
 * The live task event stream.
 *
 * `GET /api/v1/tasks/{id}/events` is Server-Sent Events, but this is
 * deliberately not `EventSource`. That API cannot set an Authorization header,
 * and the endpoint authenticates like every other one. The alternatives --
 * putting the token in the query string, where it lands in server logs, or
 * moving the session to a cookie and taking on CSRF -- are both worse than
 * reading the stream with fetch. The cost is that reconnection and event
 * framing are ours to implement; that is this file.
 *
 * What the server does, which shapes what this has to handle:
 *   - it replays a per-task buffer, so events emitted before the browser
 *     attached are not lost in the race after `POST /tasks` returns;
 *   - it sends `: keepalive` comments every few seconds through idle periods;
 *   - it closes on `task_completed`, `task_failed` or `task_cancelled`;
 *   - a task that paused at an approval gate keeps the stream open and silent
 *     until it is resumed, so a quiet stream is not a dead one.
 */

import { tokenStore } from "@/lib/api";

/** Mirrors the backend's `AgentEvent`. */
export type AgentEvent = {
  task_id: string;
  event: string;
  component: string;
  timestamp: string;
  data: Record<string, unknown>;
};

/** After these the server closes the stream, so reconnecting is wrong. */
export const TERMINAL_EVENTS = new Set([
  "task_completed",
  "task_failed",
  "task_cancelled",
]);

export type StreamHandlers = {
  onEvent: (event: AgentEvent) => void;
  /** The stream ended normally, with the terminal event if there was one. */
  onClose?: (terminal: AgentEvent | null) => void;
  /**
   * The connection dropped and will be retried. Called with the attempt
   * number so a screen can say "reconnecting" rather than looking frozen --
   * a silent retry behind a working-looking UI is how a stalled task gets
   * mistaken for a slow one.
   */
  onReconnecting?: (attempt: number, error: unknown) => void;
  /** Retries are exhausted, or the server refused. Nothing more will arrive. */
  onError?: (error: unknown) => void;
};

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

/**
 * Follow one task's events until it finishes.
 *
 * Returns a function that stops the stream. Calling it is not an error at any
 * point, including after the stream has already closed.
 */
export function streamTaskEvents(
  taskId: string,
  handlers: StreamHandlers,
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let attempt = 0;
  /** Set once, so a reconnect cannot replay a completed task's ending twice. */
  let terminal: AgentEvent | null = null;
  /**
   * Events already delivered. The server replays its whole buffer on every
   * connection, so without this a reconnect would re-announce every step the
   * task has taken and the timeline would grow duplicates.
   */
  const delivered = new Set<string>();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
  };

  /** Reset the retry budget when a connection is actually productive. */
  let progressed = false;

  const deliver = (event: AgentEvent) => {
    const fingerprint = `${event.timestamp}|${event.event}|${event.component}`;
    if (delivered.has(fingerprint)) return;
    delivered.add(fingerprint);
    progressed = true;
    handlers.onEvent(event);
    if (TERMINAL_EVENTS.has(event.event)) terminal = event;
  };

  const run = async () => {
    while (!stopped && terminal === null) {
      let failure: unknown = null;
      progressed = false;

      try {
        await readStream(taskId, controller.signal, deliver);
        if (stopped || controller.signal.aborted) return;
        if (terminal !== null) break;
        // The server closes the stream only on a terminal event. A body that
        // ends without one is a connection that was cut somewhere in between
        // -- a proxy timeout, a suspended laptop -- and the task is very
        // likely still running, so this reconnects rather than reporting a
        // finish that did not happen.
        failure = new Error("The event stream ended before the task did.");
      } catch (error) {
        if (stopped || controller.signal.aborted) return;

        // A refusal is not a transient failure: retrying a 403 forever just
        // hides it. Only a dropped connection is worth another attempt.
        if (error instanceof StreamRefused) {
          handlers.onError?.(error);
          return;
        }
        failure = error;
      }

      // A connection that delivered something new was working; a drop after
      // it is a fresh problem, not a continuation of the last one. Only a run
      // of connections that achieve nothing exhausts the budget.
      if (progressed) attempt = 0;

      attempt += 1;
      if (attempt > MAX_RETRIES) {
        handlers.onError?.(failure);
        return;
      }
      handlers.onReconnecting?.(attempt, failure);
      await sleep(
        Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS),
        controller.signal,
      );
    }

    if (!stopped) handlers.onClose?.(terminal);
  };

  void run();
  return stop;
}

/** The server answered, but not with a stream. Retrying will not help. */
export class StreamRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StreamRefused";
    this.status = status;
  }
}

async function readStream(
  taskId: string,
  signal: AbortSignal,
  deliver: (event: AgentEvent) => void,
): Promise<void> {
  const token = tokenStore.get();
  const response = await fetch(`/api/v1/tasks/${taskId}/events`, {
    headers: {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });

  if (!response.ok) {
    throw new StreamRefused(
      response.status,
      response.status === 403
        ? "This task belongs to someone else."
        : response.status === 404
          ? "This task no longer exists."
          : `The event stream returned ${response.status}.`,
    );
  }
  if (!response.body) {
    throw new Error("The event stream carried no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE separates records with a blank line. A chunk boundary can fall
      // anywhere, so anything after the last separator stays in the buffer.
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const record = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = parseRecord(record);
        if (event) deliver(event);
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {
      /* already closed */
    });
  }
}

/**
 * Turn one SSE record into an event, or null if it carried none.
 *
 * Keepalive comments and any field the server adds later fall through here
 * harmlessly rather than becoming a parse failure that kills the stream.
 */
function parseRecord(record: string): AgentEvent | null {
  let name = "message";
  const dataLines: string[] = [];

  for (const line of record.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment, e.g. keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  try {
    const payload = JSON.parse(dataLines.join("\n")) as Partial<AgentEvent>;
    return {
      task_id: String(payload.task_id ?? ""),
      // The synthetic replay record the server sends for an already-finished
      // task carries its name only in the SSE event field.
      event: payload.event ?? name,
      component: payload.component ?? "orchestrator",
      timestamp: payload.timestamp ?? new Date().toISOString(),
      data: payload.data ?? (payload as Record<string, unknown>),
    };
  } catch {
    // One malformed record must not end a stream that is otherwise fine.
    return null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
