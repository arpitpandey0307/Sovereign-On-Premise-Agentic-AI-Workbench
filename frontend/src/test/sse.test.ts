/**
 * The task event stream.
 *
 * The cases here are the ones that only appear against a real server: a chunk
 * boundary landing mid-record, a reconnect replaying the whole buffer, and a
 * refusal that must not be retried forever behind a spinner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamTaskEvents } from "@/lib/sse";
import { tokenStore } from "@/lib/api";

/** A response whose body yields the given chunks, then ends. */
function streamOf(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function record(event: string, data: Record<string, unknown> = {}, at = "2026-01-01T00:00:00Z") {
  return `event: ${event}\ndata: ${JSON.stringify({
    task_id: "t1",
    event,
    component: "orchestrator",
    timestamp: at,
    data,
  })}\n\n`;
}

/** Collect events until the stream closes. */
function collect(chunksPerConnection: string[][]) {
  let connection = 0;
  const fetchMock = vi.fn(async () => {
    const chunks = chunksPerConnection[Math.min(connection, chunksPerConnection.length - 1)];
    connection += 1;
    return streamOf(chunks);
  });
  vi.stubGlobal("fetch", fetchMock);

  const events: string[] = [];
  const done = new Promise<void>((resolve) => {
    streamTaskEvents("t1", {
      onEvent: (event) => events.push(event.event),
      onClose: () => resolve(),
      onError: () => resolve(),
    });
  });
  return { events, done, fetchMock };
}

describe("the task event stream", () => {
  beforeEach(() => tokenStore.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("sends the session token, since EventSource could not", async () => {
    tokenStore.set("token-123");
    const { done, fetchMock } = collect([[record("task_completed")]]);
    await done;

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-123",
    );
  });

  it("reads records that arrive split across chunks", async () => {
    // The network decides where chunks break, not the server. A record cut in
    // half must be buffered, not dropped.
    const full = record("plan_built") + record("task_completed");
    const cut = Math.floor(full.length / 3);
    const { events, done } = collect([[full.slice(0, cut), full.slice(cut)]]);
    await done;

    expect(events).toEqual(["plan_built", "task_completed"]);
  });

  it("ignores keepalive comments", async () => {
    const { events, done } = collect([
      [": keepalive\n\n", record("task_started"), ": keepalive\n\n", record("task_completed")],
    ]);
    await done;

    expect(events).toEqual(["task_started", "task_completed"]);
  });

  it("survives one malformed record", async () => {
    // A single bad frame must not take down a stream that is otherwise fine;
    // the alternative is a task that appears to hang.
    const { events, done } = collect([
      [record("task_started"), "event: junk\ndata: {not json\n\n", record("task_completed")],
    ]);
    await done;

    expect(events).toEqual(["task_started", "task_completed"]);
  });

  it("does not re-announce replayed events after a reconnect", async () => {
    // The server replays its whole buffer on every connection. Without
    // de-duplication a dropped connection would double the timeline.
    const { events, done } = collect([
      [record("task_started", {}, "2026-01-01T00:00:01Z")],
      [
        record("task_started", {}, "2026-01-01T00:00:01Z"),
        record("task_completed", {}, "2026-01-01T00:00:09Z"),
      ],
    ]);
    await done;

    expect(events).toEqual(["task_started", "task_completed"]);
  });

  it("recognises the replay frame the server sends for a finished task", async () => {
    // Copied from a live response. It is not an AgentEvent: it carries only
    // `task_id` and `replayed`, and its name lives in the SSE event field.
    // Opening a completed task is the most common way this stream is used,
    // so treating this frame as unrecognised would leave the timeline blank.
    const { events, done, fetchMock } = collect([
      [
        'event: task_completed\ndata: {"task_id": "t1", "replayed": true}\n\n',
      ],
    ]);
    await done;

    expect(events).toEqual(["task_completed"]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // terminal: no reconnect
  });

  it("stops after a terminal event rather than reconnecting", async () => {
    const { done, fetchMock } = collect([[record("task_failed")]]);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a refusal", async () => {
    // Retrying a 403 forever just hides it behind a spinner.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));

    const error = await new Promise((resolve) => {
      streamTaskEvents("t1", { onEvent: () => {}, onError: resolve });
    });

    expect(error).toMatchObject({ name: "StreamRefused", status: 403 });
  });

  it("stops cleanly when the caller unmounts", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              /* never closes, like a task waiting for approval */
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const stop = streamTaskEvents("t1", { onEvent: () => {} });
    expect(() => {
      stop();
      stop(); // stopping twice is not an error
    }).not.toThrow();
  });
});
