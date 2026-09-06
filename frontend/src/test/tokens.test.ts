/**
 * The design tokens, checked against Tailwind's own utility names.
 *
 * This exists because of a bug that was invisible in code review and in every
 * unit test: a colour token named `base` made `text-base` compile to
 * `color: var(--bg-base)` instead of a font size, so any element using it was
 * painted in the page's background colour. The landing page's subheadline was
 * rendered, positioned and sized correctly, and simply could not be seen. It
 * was found by screenshotting the built page and sampling pixels.
 *
 * A colour whose name collides with a font-size, font-weight or tracking
 * utility will do the same thing again, so the collision is checked here
 * rather than trusted to memory.
 */

import { describe, expect, it } from "vitest";
// The stylesheet as text. Read through the bundler rather than the filesystem
// so the test needs no Node types and no path arithmetic.
import css from "@/styles/globals.css?raw";

/**
 * Names Tailwind already uses for `text-*` utilities. A colour with one of
 * these names wins over the built-in meaning, silently.
 */
const RESERVED = new Set([
  // font sizes
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl",
  "8xl", "9xl",
  // text-wrap and alignment share the `text-` prefix too
  "left", "center", "right", "justify", "start", "end",
  "wrap", "nowrap", "balance", "pretty", "ellipsis", "clip",
]);

function themeColourNames(): string[] {
  const block = css.slice(css.indexOf("@theme inline"));
  return [...block.matchAll(/--color-([a-z0-9-]+):/g)].map((match) => match[1]);
}

describe("the design tokens", () => {
  it("defines colours", () => {
    // If the extraction breaks, every assertion below passes vacuously.
    expect(themeColourNames().length).toBeGreaterThan(10);
  });

  it("gives no colour a name Tailwind already uses for text-*", () => {
    const colliding = themeColourNames().filter((name) => RESERVED.has(name));
    expect(colliding).toEqual([]);
  });

  it("ships a single theme", () => {
    // The `front` design system is dark only -- this is an instrument panel in
    // a control room. There is deliberately no light palette and no theme
    // toggle, so a `[data-theme="light"]` override block would be a stray
    // half-finished feature rather than a supported mode.
    expect(css).not.toContain('data-theme="light"');
    expect(css).toContain("color-scheme: dark");
  });

  it("resolves every Tailwind colour token to a defined variable", () => {
    // `@theme inline` maps utilities onto `var(--x)` references. A typo in one
    // of those names compiles to nothing and paints the element transparent.
    const block = css.slice(css.indexOf("@theme inline"));
    const referenced = [...block.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(
      (m) => m[1],
    );
    const defined = new Set(
      [...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]),
    );
    const missing = referenced.filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });
});
