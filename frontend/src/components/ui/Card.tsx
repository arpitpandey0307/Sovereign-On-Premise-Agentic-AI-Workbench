import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A raised panel, from the `front` design system (`.card`): panel-2 ground, a
 * hairline border, 18/20 padding baked in. Pass `p-0` to opt out of the
 * padding when a card wraps its own full-bleed content (a table, a header).
 */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...rest} />;
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-subtle px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-primary">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-tertiary">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
