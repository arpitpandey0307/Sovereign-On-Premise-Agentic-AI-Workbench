/**
 * Motion primitives for the landing page.
 *
 * The rule this page follows is "animate the mechanism, not the decoration":
 * everything that moves is a real thing -- a document travelling a pipeline, a
 * stage lighting up, a connection being refused. Nothing loops ambiently for
 * its own sake.
 *
 * Reduced motion is handled here rather than in each section, because the
 * requirement is not "skip the animation" but "the page is complete and
 * comprehensible with every animation disabled". A `Reveal` that started at
 * `opacity: 0` and relied on an animation to become visible would leave a
 * reader with reduced motion looking at empty boxes. So under that setting
 * these render as plain elements in their final state, with no animation to
 * fail.
 */

import { motion, useReducedMotion, type Variants } from "framer-motion";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Nothing on this page animates for much longer than this. It must feel fast. */
export const DURATION = 0.5;

export const EASE = [0.16, 1, 0.3, 1] as const;

const revealVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  shown: { opacity: 1, y: 0 },
};

/**
 * Whether scroll-triggered reveals should animate at all.
 *
 * They start from `opacity: 0` and depend on something arriving to make them
 * visible, so if the mechanism that would trigger them is absent the content
 * must simply be rendered instead. Showing content is never the wrong
 * failure; hiding it behind a feature the browser does not have is.
 */
function useAnimatedReveal(): boolean {
  const reduced = useReducedMotion();
  return !reduced && typeof IntersectionObserver !== "undefined";
}

/**
 * Fade and lift a block as it enters the viewport, once.
 *
 * `once` matters: a section that re-animates every time it scrolls past reads
 * as a toy. The reader has already seen it.
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "section" | "li" | "p" | "h2";
}) {
  const animated = useAnimatedReveal();
  const Component = motion[as];

  if (!animated) {
    const Plain = as;
    return <Plain className={className}>{children}</Plain>;
  }

  return (
    <Component
      className={className}
      variants={revealVariants}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: DURATION, delay, ease: EASE }}
    >
      {children}
    </Component>
  );
}

/** A stagger container, for lists of cards. */
export function RevealGroup({
  children,
  className,
  step = 0.06,
}: {
  children: ReactNode;
  className?: string;
  step?: number;
}) {
  const animated = useAnimatedReveal();

  if (!animated) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount: 0.15 }}
      variants={{
        hidden: {},
        shown: { transition: { staggerChildren: step } },
      }}
    >
      {children}
    </motion.div>
  );
}

/** A child of `RevealGroup`. Inherits the parent's stagger. */
export function RevealItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const animated = useAnimatedReveal();

  if (!animated) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      variants={revealVariants}
      transition={{ duration: DURATION, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Section shell: consistent rhythm, and an id the navbar can scroll-spy. */
export function Section({
  id,
  children,
  className,
  label,
}: {
  id: string;
  children: ReactNode;
  className?: string;
  /** Names the section for screen readers and the scroll-spy. */
  label?: string;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className={cn("scroll-mt-20 px-6 py-24 sm:py-28", className)}
    >
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  blurb,
  align = "left",
}: {
  eyebrow?: string;
  title: ReactNode;
  blurb?: ReactNode;
  align?: "left" | "center";
}) {
  return (
    <Reveal className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}>
      {eyebrow && (
        <p className="mono mb-3 text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
          {eyebrow}
        </p>
      )}
      <h2 className="text-balance text-3xl font-semibold tracking-tight text-primary sm:text-4xl">
        {title}
      </h2>
      {blurb && (
        <p className="mt-4 text-pretty text-[15px] leading-relaxed text-secondary">
          {blurb}
        </p>
      )}
    </Reveal>
  );
}
