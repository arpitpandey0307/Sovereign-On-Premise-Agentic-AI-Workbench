/**
 * The backend's permission matrix, mirrored for tests.
 *
 * Copied deliberately rather than approximated: hand-written permission lists
 * per test drift towards whatever makes the assertion pass, and then the
 * navigation is verified against a role that does not exist. This mirrors
 * `backend/app/security/acl.py`, and `permissionsFor` derives each role's set
 * the same way `describe()` does there.
 */

import type { Classification, Permissions, Role } from "@/lib/types";

const WORKERS: Role[] = ["ENGINEER", "ANALYST", "MANAGER", "ADMIN"];
const OVERSIGHT: Role[] = ["ADMIN", "SECURITY_ADMIN"];

const MATRIX: Array<[string, Role[]]> = [
  ["conversation:read", WORKERS],
  ["conversation:write", WORKERS],
  ["file:read", WORKERS],
  ["file:upload", WORKERS],
  ["file:delete", WORKERS],
  ["document:read", WORKERS],
  ["document:search", WORKERS],
  ["document:ingest", WORKERS],
  ["task:read", WORKERS],
  ["task:create", WORKERS],
  ["artifact:download", WORKERS],
  ["model:read", [...WORKERS, "SECURITY_ADMIN"]],
  ["model:admin", ["ADMIN"]],
  ["system:read", OVERSIGHT],
  ["audit:read", OVERSIGHT],
  ["security:read", OVERSIGHT],
];

const CLEARANCE: Record<Role, Classification> = {
  ENGINEER: "CONFIDENTIAL",
  ANALYST: "CONFIDENTIAL",
  MANAGER: "HIGHLY_CONFIDENTIAL",
  ADMIN: "HIGHLY_CONFIDENTIAL",
  // Oversees the system without reading the corpus. Several screens are
  // legitimately empty for this role.
  SECURITY_ADMIN: "PUBLIC",
};

const LADDER: Classification[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "HIGHLY_CONFIDENTIAL",
];

export function permissionsFor(roles: Role[]): Permissions {
  const held = new Set(roles);
  const ceiling = roles.length
    ? LADDER[Math.max(...roles.map((role) => LADDER.indexOf(CLEARANCE[role])))]
    : undefined;

  return {
    roles,
    clearance: ceiling ?? "none",
    readable_classifications: ceiling
      ? LADDER.slice(0, LADDER.indexOf(ceiling) + 1)
      : [],
    permissions: MATRIX.filter(([, allowed]) =>
      allowed.some((role) => held.has(role)),
    ).map(([permission]) => permission),
  };
}
