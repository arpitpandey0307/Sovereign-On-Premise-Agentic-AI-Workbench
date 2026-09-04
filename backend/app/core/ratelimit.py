"""Login attempt throttling.

General per-user rate limiting is a later phase, but an unthrottled login
endpoint on a system holding confidential work is a standing invitation to
brute force a password. This is the narrow case: repeated failed logins from
one source, or against one account, are slowed and then locked out.

In-process and per-worker, which is enough for the single-process MVP. When a
real queue and multiple workers arrive, this moves to Redis behind the same
two methods.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

# Five bad attempts inside the window locks the key out for the cooldown.
MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300.0
LOCKOUT_SECONDS = 900.0


class LoginThrottle:
    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = defaultdict(deque)
        self._locked_until: dict[str, float] = {}

    def _prune(self, key: str, now: float) -> None:
        attempts = self._failures[key]
        while attempts and now - attempts[0] > WINDOW_SECONDS:
            attempts.popleft()

    def check(self, key: str) -> tuple[bool, int]:
        """Return ``(allowed, seconds_remaining)`` for this key."""
        now = time.monotonic()
        until = self._locked_until.get(key)
        if until is not None:
            if now < until:
                return False, int(until - now)
            # Cooldown served: clear it and give the key a clean slate.
            del self._locked_until[key]
            self._failures.pop(key, None)
        return True, 0

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        self._prune(key, now)
        self._failures[key].append(now)
        if len(self._failures[key]) >= MAX_ATTEMPTS:
            self._locked_until[key] = now + LOCKOUT_SECONDS

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._locked_until.pop(key, None)


login_throttle = LoginThrottle()
