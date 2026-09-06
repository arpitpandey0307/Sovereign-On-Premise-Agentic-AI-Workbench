import type { ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The status vocabulary, mapped onto the `front` design system's `.pill`.
 *
 * Every pill carries an icon and a word as well as a colour. That is an
 * accessibility requirement, and it is a practical one too: these states carry
 * security meaning, and a projector in a bright room flattens colour to the
 * point where green and amber are the same thing.
 */
export type Tone =
  | "positive" // completed, verified, secure, approved, active
  | "info" // running, processing, selected
  | "warning" // waiting, needs approval, low confidence
  | "danger" // blocked, failed, security violation, denied
  | "inactive"; // unavailable, not started

const TONES: Record<Tone, { pill: string; Icon: typeof CheckCircle2 }> = {
  positive: { pill: "ok", Icon: CheckCircle2 },
  info: { pill: "accent", Icon: Loader2 },
  warning: { pill: "warn", Icon: Clock },
  danger: { pill: "danger", Icon: XCircle },
  inactive: { pill: "", Icon: CircleDashed },
};

export function StatusPill({
  tone,
  children,
  icon,
  spin,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  icon?: ReactNode;
  spin?: boolean;
  className?: string;
}) {
  const { pill, Icon } = TONES[tone];
  return (
    <span className={cn("pill uppercase", pill, className)}>
      {icon ?? (
        <Icon className={cn("size-3", spin && "animate-spin")} aria-hidden />
      )}
      {children}
    </span>
  );
}

/** Task status, mapped to the vocabulary once so it cannot drift per screen. */
export function TaskStatusPill({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <StatusPill tone="positive">Completed</StatusPill>;
    case "running":
      return (
        <StatusPill tone="info" spin>
          Running
        </StatusPill>
      );
    case "planning":
      return (
        <StatusPill tone="info" spin>
          Planning
        </StatusPill>
      );
    case "pending":
      return <StatusPill tone="inactive">Pending</StatusPill>;
    case "waiting_approval":
      return (
        <StatusPill tone="warning" icon={<AlertTriangle className="size-3" />}>
          Needs approval
        </StatusPill>
      );
    case "failed":
      return <StatusPill tone="danger">Failed</StatusPill>;
    case "cancelled":
      return (
        <StatusPill tone="inactive" icon={<Ban className="size-3" />}>
          Cancelled
        </StatusPill>
      );
    default:
      return <StatusPill tone="inactive">{status}</StatusPill>;
  }
}

/**
 * A document's sensitivity.
 *
 * Shown wherever a document is, because the levels on what a user *can* see
 * are what make the governance legible.
 */
export function ClassificationBadge({ level }: { level: string }) {
  const tone: Tone =
    level === "HIGHLY_CONFIDENTIAL"
      ? "danger"
      : level === "CONFIDENTIAL"
        ? "warning"
        : level === "INTERNAL"
          ? "info"
          : "inactive";

  return (
    <StatusPill tone={tone} icon={<ShieldAlert className="size-3" />}>
      {level.replace(/_/g, " ").toLowerCase()}
    </StatusPill>
  );
}
