"""Route real requests against the live registry and check what comes back.

The unit tests build their own models, so they can only prove the router obeys
its rules. They cannot see the registry the machine is actually running, and
that is where this class of bug lives: a model whose stored capabilities are
stale, or one marked unavailable months ago by a single slow call, changes
which model answers without changing a line of code.

Both of those happened. The vision model listed the generic "reasoning"
capability, and being smaller and faster than the reasoner it won ordinary
chat turns. Later it was marked unavailable after one timeout and stayed that
way, so drawings stopped being read at all. Neither was visible to the suite.

Run this after changing the catalogue, the router, or anything about model
status, and run it on the demo machine before demonstrating anything.

    PYTHONPATH=. .venv/Scripts/python.exe scripts/verify_routing.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.security import port as security_port

# The real policy engine, exactly as main.py installs it. Without it the
# fail-closed placeholder denies every model -- correct behaviour, and the
# reason a check like this has to boot the same wiring the application does.
security_port.install(monitor_network=False)

from app.db.database import SessionLocal  # noqa: E402
from app.models.registry import ModelRegistry  # noqa: E402
from app.routing.hardware import hardware  # noqa: E402
from app.routing.model_router import (  # noqa: E402
    NON_GENERATIVE,
    ModelRouter,
    TaskRequirements,
)

# What each kind of work must be answered by. A request that names no type is
# the interesting one: nothing filters it on capability, so the smallest model
# in the registry wins on efficiency and latency unless the router has an
# opinion about types.
CASES = [
    ("a plain chat turn", TaskRequirements(task_type="general"), "reasoning"),
    (
        "explicit reasoning",
        TaskRequirements(task_type="general", model_type="reasoning"),
        "reasoning",
    ),
    (
        "an approval note",
        TaskRequirements(task_type="approval_note", model_type="reasoning"),
        "reasoning",
    ),
    (
        "a drawing to describe",
        TaskRequirements(task_type="vision_describe", needs_vision=True),
        "vision",
    ),
    (
        "a calculation to write",
        TaskRequirements(task_type="code_generation", model_type="coding"),
        "coding",
    ),
    (
        "text to embed",
        TaskRequirements(task_type="embedding", model_type="embedding"),
        "embedding",
    ),
]


def main() -> int:
    failures: list[str] = []

    with SessionLocal() as db:
        registry = ModelRegistry(db)
        records = registry.all()

        print("=== 1. what the registry is actually holding ===")
        if not records:
            print("  [FAIL] the registry is empty -- refresh it before demonstrating")
            return 1

        for record in records:
            caps = ", ".join(record.capabilities or [])
            print(f"    {record.id:30} {record.type:10} {record.status:12} {caps}")

        # A vision model that claims a generic reasoning capability will win
        # ordinary questions on size and speed. It reasons about what it can
        # see; that is not the same thing.
        for record in records:
            if record.type != "reasoning" and "reasoning" in (record.capabilities or []):
                failures.append(
                    f"{record.id} is a {record.type} model claiming the generic "
                    "'reasoning' capability"
                )

        unavailable = [r.id for r in records if r.status != "ready"]
        if unavailable:
            print(f"\n  [note] not ready: {', '.join(unavailable)}")
            print("         a capability is missing while its model sits here.")

        gpu = hardware.state()
        print(
            f"\n=== 2. hardware ===\n    {gpu.name}: {gpu.usable_vram_gb:.1f} GB usable "
            f"({gpu.free_vram_gb:.1f} free + {gpu.resident_vram_gb:.1f} reclaimable)"
        )

        print("\n=== 3. what each kind of work routes to ===")
        router = ModelRouter(db)
        for label, requirements, expected in CASES:
            decision = router.route(requirements, gpu=gpu)

            if decision.selected is None:
                print(f"  [FAIL] {label:24} -> nothing: {decision.failure_reason}")
                failures.append(f"{label} routed to nothing")
                continue

            chosen = decision.selected
            note = ""
            if decision.substituted:
                asked, used = decision.substituted
                note = f"  (no {asked} model was usable, a {used} model stood in)"

            ok = chosen.type == expected or decision.substituted is not None
            if chosen.type in NON_GENERATIVE and expected not in NON_GENERATIVE:
                ok = False
                note = "  -- this model cannot answer a prompt at all"

            print(
                f"  [{'PASS' if ok else 'FAIL'}] {label:24} -> {chosen.id} "
                f"({chosen.type}, wanted {expected}){note}"
            )
            if not ok:
                failures.append(
                    f"{label} routed to a {chosen.type} model, expected {expected}"
                )

    print("\n" + "=" * 62)
    if failures:
        print(f"{len(failures)} problem(s):")
        for failure in failures:
            print(f"  - {failure}")
        print("\nIf the capabilities look stale, refresh the registry:")
        print("  POST /internal/models/refresh  (ADMIN), or the Models page button.")
        return 1

    print("Every kind of work routes to the right kind of model.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
