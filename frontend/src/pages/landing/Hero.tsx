import { useReducedMotion } from "framer-motion";
import { Lock, ShieldCheck, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EnterWorkbenchButton } from "@/pages/landing/actions";
import { HeroPipeline } from "@/pages/landing/HeroPipeline";

const TRUST = [
  { Icon: Lock, label: "LOCAL ONLY" },
  { Icon: Zap, label: "GPU POWERED" },
  { Icon: ShieldCheck, label: "ZERO EGRESS" },
];

/**
 * The hero entrance is a CSS animation, not a scripted one.
 *
 * Everything else on this page animates on scroll, where a script is the only
 * thing that knows the scroll position. The hero is different: it is the first
 * impression, it is above the fold, and it must never depend on a frame loop
 * to become visible. `.rise-in` starts from the visible state and the
 * animation reveals it, so the content is there even if nothing runs.
 */
function enter(delayMs: number) {
  return { style: { animationDelay: `${delayMs}ms` } };
}

export function Hero() {
  const reduced = useReducedMotion();

  return (
    <section id="top" className="relative overflow-hidden px-6 pb-20 pt-32 sm:pt-36">
      {/* A single soft wash behind the hero. One accent doing the work, not
          six gradients competing. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-60"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 0%, var(--accent-soft) 0%, transparent 70%)",
        }}
      />
      <GridBackdrop />

      <div className="relative mx-auto w-full max-w-6xl">
        <div {...enter(0)} className="rise-in mx-auto max-w-3xl text-center">
          <p className="mono mb-5 inline-flex items-center gap-2 rounded-full border border-subtle bg-panel/60 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-accent-text">
            <span className="size-1.5 rounded-full bg-positive" aria-hidden />
            On-premise · air-gapped · open-weight models
          </p>

          <h1 className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-primary sm:text-5xl lg:text-6xl">
            Private intelligence for confidential industrial work.
          </h1>
        </div>

        <p
          {...enter(80)}
          className="rise-in mx-auto mt-6 max-w-2xl text-pretty text-center text-[15px] leading-relaxed text-secondary sm:text-base"
        >
          Run powerful open-weight AI locally. Analyze sensitive documents,
          execute controlled workflows, and generate real industrial
          deliverables without sending confidential data to external AI
          services.
        </p>

        <div
          {...enter(140)}
          className="rise-in mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <EnterWorkbenchButton size="lg">Enter Secure Workbench</EnterWorkbenchButton>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              document
                .getElementById("platform")
                ?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
            }}
          >
            Explore Platform
          </Button>
        </div>

        <ul
          {...enter(200)}
          className="rise-in mt-8 flex flex-wrap items-center justify-center gap-2.5"
        >
          {TRUST.map(({ Icon, label }) => (
            <li
              key={label}
              className="mono inline-flex items-center gap-2 rounded-full border border-subtle bg-panel/70 px-3 py-1.5 text-[11px] tracking-[0.12em] text-secondary"
            >
              <Icon className="size-3.5 text-accent" aria-hidden />
              {label}
            </li>
          ))}
        </ul>

        <div {...enter(280)} className="rise-in mt-12 sm:mt-14">
          <HeroPipeline />
        </div>
      </div>
    </section>
  );
}

/** A faint technical grid. Static: it is a ground, not an effect. */
function GridBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[720px] opacity-[0.35]"
      style={{
        backgroundImage:
          "linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px)",
        backgroundSize: "64px 64px",
        maskImage:
          "radial-gradient(70% 55% at 50% 12%, #000 0%, transparent 78%)",
        WebkitMaskImage:
          "radial-gradient(70% 55% at 50% 12%, #000 0%, transparent 78%)",
      }}
    />
  );
}
