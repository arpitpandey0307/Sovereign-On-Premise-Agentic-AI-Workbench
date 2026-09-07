/** Small formatters, shared so the same value never renders two ways. */

/**
 * Parse a timestamp from the API.
 *
 * The backend sends two shapes. Anything it builds by hand carries an offset
 * (`...+00:00`, or `Z` on the event stream), but values that come straight off
 * a SQLAlchemy column are naive — `2026-09-07T14:36:01.746814` — and those are
 * UTC.
 *
 * ECMAScript reads a date-time string with no offset as *local* time, so a task
 * created seconds ago rendered as "6 hr ago" in India and would render in the
 * future west of Greenwich. Every relative and absolute time in the product ran
 * through that, which is why this is one function rather than a fix at each
 * call site.
 */
export function parseApiDate(iso: string): Date {
  // A date-only string ("2026-09-07") is already UTC by specification.
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const hasTime = iso.includes("T");
  return new Date(hasTime && !hasOffset ? `${iso}Z` : iso);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} sec`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Absolute time for the audit log; relative time reads as evasive there. */
export function formatTimestamp(iso: string): string {
  const date = parseApiDate(iso);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatRelative(iso: string): string {
  const then = parseApiDate(iso).getTime();
  if (Number.isNaN(then)) return "--";
  const seconds = Math.round((Date.now() - then) / 1000);
  // Clock skew between the browser and the server can put a fresh record a
  // second or two in the future. "in 2 seconds" reads as a fault.
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
