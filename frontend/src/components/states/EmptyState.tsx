import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * An empty state names the situation and offers the action that resolves it.
 * "No data" tells someone nothing and leaves them stuck.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && <div className="text-tertiary [&>svg]:size-8">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium text-primary">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-xs text-tertiary">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
