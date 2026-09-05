"""Part 05's installation into the port registry.

This is the last swap. Once it runs, no placeholder is left anywhere: the
policy checks Parts 01-04 have been making all along start being answered by
the real engine, and the audit events they have been emitting start landing in
a durable ledger instead of a list in memory.
"""

from __future__ import annotations

import logging

from app.audit.ledger import audit_ledger
from app.security.network import egress_monitor
from app.security.policy_engine import policy_engine

logger = logging.getLogger("workbench.security")


def install(*, monitor_network: bool = True) -> None:
    from app.integrations import registry

    registry.register_policy(policy_engine)
    registry.register_audit(audit_ledger)

    if monitor_network and egress_monitor.install():
        logger.info("sovereignty monitoring active for this process")
