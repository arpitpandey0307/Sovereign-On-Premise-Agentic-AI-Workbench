/**
 * Timestamp parsing.
 *
 * The backend sends two shapes: values it builds by hand carry an offset
 * (`+00:00`, or `Z` on the event stream), and values that come straight off a
 * SQLAlchemy column are naive — `2026-09-07T14:36:01.746814` — and those are
 * UTC.
 *
 * ECMAScript reads a date-time string with no offset as *local* time. That is
 * how a task created seconds earlier came to render as "6 hr ago" in India, and
 * would render in the future west of Greenwich. Every relative and absolute
 * time in the product runs through this, so it is pinned rather than left to
 * whichever timezone the next person happens to test in.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelative, formatTimestamp, parseApiDate } from "@/lib/format";

afterEach(() => {
  vi.useRealTimers();
});

describe("parsing a timestamp from the API", () => {
  it("reads a naive timestamp as UTC, not as local time", () => {
    // The bug: without the Z this parsed as local, shifting by the offset.
    expect(parseApiDate("2026-09-07T14:36:01.746814").toISOString()).toBe(
      "2026-09-07T14:36:01.746Z",
    );
  });

  it("leaves an explicit offset alone", () => {
    expect(parseApiDate("2026-09-07T14:36:01.746814+00:00").toISOString()).toBe(
      "2026-09-07T14:36:01.746Z",
    );
    expect(parseApiDate("2026-09-07T09:32:51.023372Z").toISOString()).toBe(
      "2026-09-07T09:32:51.023Z",
    );
  });

  it("honours a non-UTC offset rather than overriding it", () => {
    expect(parseApiDate("2026-09-07T20:06:01+05:30").toISOString()).toBe(
      "2026-09-07T14:36:01.000Z",
    );
  });

  it("leaves a date-only string alone, which is already UTC", () => {
    expect(parseApiDate("2026-09-07").toISOString()).toBe(
      "2026-09-07T00:00:00.000Z",
    );
  });
});

describe("relative time", () => {
  it("calls a record written seconds ago 'just now', in any timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T14:36:10Z"));
    // Naive UTC, nine seconds earlier. This is the exact string the sidebar
    // was rendering as "6 hr ago".
    expect(formatRelative("2026-09-07T14:36:01.746814")).toBe("just now");
  });

  it("still reports real age correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T20:36:01Z"));
    expect(formatRelative("2026-09-07T14:36:01.746814")).toBe("6 hr ago");
  });

  it("does not render a slightly-future record as a fault", () => {
    // Clock skew between browser and server can put a fresh record ahead.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T14:36:00Z"));
    expect(formatRelative("2026-09-07T14:36:02")).toBe("just now");
  });

  it("survives a value it cannot read", () => {
    expect(formatRelative("not a date")).toBe("--");
    expect(formatTimestamp("not a date")).toBe("--");
  });
});
