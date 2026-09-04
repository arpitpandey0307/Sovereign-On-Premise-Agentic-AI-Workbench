"""In-process event bus backing the SSE endpoint.

Part 04 publishes ``AgentEvent`` objects here; Part 01's
``GET /tasks/{id}/events`` subscribes and forwards them to the browser. A
short replay buffer per task covers the normal race where the frontend opens
the stream a moment after ``POST /tasks`` returns.

This is intentionally the simplest thing that works for the MVP. The publish/
subscribe surface is narrow enough that swapping in Redis pub/sub later is a
change to this file alone.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict, defaultdict, deque
from datetime import UTC, datetime
from uuid import UUID

from app.schemas.shared import AgentEvent

REPLAY_BUFFER_SIZE = 200

# How many finished tasks keep their replay buffer. A browser that opens the
# stream just after a fast task ends still gets the events; older ones are
# dropped so a long-running server does not grow without bound.
RETAINED_FINISHED_TASKS = 64

TERMINAL_EVENTS = {"task_completed", "task_failed", "task_cancelled"}


class EventBus:
    def __init__(self) -> None:
        self._subscribers: dict[UUID, list[asyncio.Queue[AgentEvent | None]]] = (
            defaultdict(list)
        )
        self._replay: dict[UUID, deque[AgentEvent]] = defaultdict(
            lambda: deque(maxlen=REPLAY_BUFFER_SIZE)
        )
        # Ordered: the oldest finished task is the first one evicted.
        self._finished: OrderedDict[UUID, None] = OrderedDict()

    def publish(self, event: AgentEvent) -> None:
        """Fan an event out to every live subscriber and the replay buffer."""
        self._replay[event.task_id].append(event)
        for queue in list(self._subscribers.get(event.task_id, [])):
            queue.put_nowait(event)
        if event.event in TERMINAL_EVENTS:
            self.close(event.task_id)

    def emit(
        self, task_id: UUID, event: str, component: str, data: dict | None = None
    ) -> None:
        """Convenience wrapper so callers do not build the model by hand."""
        self.publish(
            AgentEvent(
                task_id=task_id,
                event=event,
                component=component,
                timestamp=datetime.now(UTC),
                data=data or {},
            )
        )

    def subscribe(
        self, task_id: UUID
    ) -> tuple[asyncio.Queue[AgentEvent | None], list[AgentEvent]]:
        """Attach a subscriber, returning its queue and the events it missed."""
        queue: asyncio.Queue[AgentEvent | None] = asyncio.Queue()
        self._subscribers[task_id].append(queue)
        backlog = list(self._replay.get(task_id, []))
        if task_id in self._finished:
            queue.put_nowait(None)
        return queue, backlog

    def unsubscribe(
        self, task_id: UUID, queue: asyncio.Queue[AgentEvent | None]
    ) -> None:
        subscribers = self._subscribers.get(task_id)
        if not subscribers:
            return
        if queue in subscribers:
            subscribers.remove(queue)
        if not subscribers:
            self._subscribers.pop(task_id, None)

    def close(self, task_id: UUID) -> None:
        """Signal end-of-stream to every subscriber, then start ageing out."""
        self._finished[task_id] = None
        self._finished.move_to_end(task_id)
        for queue in list(self._subscribers.get(task_id, [])):
            queue.put_nowait(None)
        self._evict_old()

    def _evict_old(self) -> None:
        while len(self._finished) > RETAINED_FINISHED_TASKS:
            oldest, _ = self._finished.popitem(last=False)
            self._replay.pop(oldest, None)
            self._subscribers.pop(oldest, None)

    def forget(self, task_id: UUID) -> None:
        """Drop retained state immediately, once the trace is persisted."""
        self._replay.pop(task_id, None)
        self._finished.pop(task_id, None)
        self._subscribers.pop(task_id, None)

    def retained_tasks(self) -> int:
        """Buffers currently held. Surfaced by /health to make leaks visible."""
        return len(self._replay)


event_bus = EventBus()
