/**
 * The landing page navbar.
 *
 * Transparent over the hero so the pipeline is the first thing seen, then
 * acquiring a background and a hairline as soon as the page scrolls -- without
 * that, the links sit on top of section content and become unreadable.
 *
 * The scroll-spy is written against scroll position rather than an
 * IntersectionObserver. The sections here are taller than the viewport, so
 * "which section is intersecting" is frequently two of them at once, and
 * resolving that ambiguity costs more than simply asking which heading the
 * reader has most recently passed.
 */

import { useEffect, useState } from "react";
import { Lock, Menu, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { EnterWorkbenchButton, SignInLink } from "@/pages/landing/actions";

export const NAV_SECTIONS = [
  { id: "platform", label: "Platform" },
  { id: "capabilities", label: "Capabilities" },
  { id: "security", label: "Security" },
  { id: "workflows", label: "Workflows" },
  { id: "architecture", label: "Architecture" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 12);

      // The heading the reader has most recently passed. A third of the way
      // down the viewport, not the top: a section counts as "current" once
      // its content is what you are actually looking at.
      const line = window.scrollY + window.innerHeight / 3;
      let current: string | null = null;
      for (const section of NAV_SECTIONS) {
        const element = document.getElementById(section.id);
        if (element && element.offsetTop <= line) current = section.id;
      }
      setActive(current);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A sheet that stays open behind a navigation is a trap on a phone.
  useEffect(() => {
    if (!sheetOpen) return;
    const close = () => setSheetOpen(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [sheetOpen]);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-colors duration-300",
        scrolled
          ? "border-b border-subtle bg-canvas/85 backdrop-blur-md"
          : "border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded bg-accent-soft">
            <Lock className="size-4 text-accent" aria-hidden />
          </div>
          <span className="text-sm font-semibold tracking-tight text-primary">
            SOVEREIGN AI
          </span>
        </a>

        <nav aria-label="Sections" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {NAV_SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  aria-current={active === section.id ? "true" : undefined}
                  className={cn(
                    "relative rounded px-3 py-2 text-[13px] transition-colors",
                    active === section.id
                      ? "text-primary"
                      : "text-secondary hover:text-primary",
                  )}
                >
                  {section.label}
                  <span
                    className={cn(
                      "absolute inset-x-3 -bottom-px h-px origin-left bg-accent transition-transform duration-300",
                      active === section.id ? "scale-x-100" : "scale-x-0",
                    )}
                  />
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden items-center gap-2 sm:flex">
          <SignInLink />
          <EnterWorkbenchButton size="sm" />
        </div>

        <button
          type="button"
          onClick={() => setSheetOpen((open) => !open)}
          aria-label={sheetOpen ? "Close menu" : "Open menu"}
          aria-expanded={sheetOpen}
          className="grid size-9 place-items-center rounded-[var(--radius)] text-secondary transition-colors hover:bg-elevated hover:text-primary sm:hidden"
        >
          {sheetOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {sheetOpen && (
        <div className="border-t border-subtle bg-canvas/95 px-6 py-4 backdrop-blur-md sm:hidden">
          <ul className="space-y-1">
            {NAV_SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  onClick={() => setSheetOpen(false)}
                  className="block rounded px-2 py-2 text-sm text-secondary hover:bg-elevated hover:text-primary"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-2 border-t border-subtle pt-4">
            <SignInLink />
            <EnterWorkbenchButton />
          </div>
        </div>
      )}
    </header>
  );
}
