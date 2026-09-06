/**
 * A data table.
 *
 * Columns are declared rather than written as markup so that every table in
 * the application -- the audit ledger, task history, the document list --
 * shares its empty state, its loading state and its overflow behaviour. Those
 * are the parts that get skipped when each screen writes its own `<table>`,
 * and an audit log that renders nothing when it is empty is indistinguishable
 * from one that is broken.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Numeric columns read better right-aligned and in the mono face. */
  numeric?: boolean;
};

export function Table<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  empty = "Nothing to show.",
  onRowClick,
  className,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Said in the product's voice: why it is empty, not just that it is. */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  className?: string;
}) {
  return (
    // Wide tables scroll inside their own container; the page never does.
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-subtle">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-tertiary",
                  column.numeric && "text-right",
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && <SkeletonRows columns={columns.length} />}

          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-10 text-center text-sm text-tertiary"
              >
                {empty}
              </td>
            </tr>
          )}

          {!loading &&
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-b border-subtle/60 last:border-0",
                  onRowClick && "cursor-pointer transition hover:bg-subtle",
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-3 py-2.5 align-top text-secondary",
                      column.numeric && "text-right font-mono tabular-nums",
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

/** Placeholder rows, so a slow query does not collapse the layout. */
function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <tr key={row} className="border-b border-subtle/60">
          {Array.from({ length: columns }, (_, column) => (
            <td key={column} className="px-3 py-3">
              <div className="h-3 w-full max-w-40 animate-pulse rounded bg-subtle" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
