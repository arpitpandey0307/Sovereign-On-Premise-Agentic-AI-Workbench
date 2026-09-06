/**
 * "Why Sovereign AI?" -- the contrast that is the entire pitch.
 *
 * Two panels showing the same confidential material taking two different
 * paths. The left one crosses a perimeter; the right one does not. The motion
 * is the crossing itself, because that is the thing being argued about, and a
 * reader who watches a document leave the boundary understands the problem
 * faster than one who reads a paragraph about data governance.
 */

import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Cloud, Cpu, ShieldCheck } from "lucide-react";
import { Reveal, Section, SectionHeading } from "@/pages/landing/motion";

const CONFIDENTIAL = [
  "P&IDs",
  "Inspection reports",
  "SOPs",
  "Engineering drawings",
  "Financial documents",
  "Internal code",
  "Business correspondence",
];

const SOVEREIGN_CHAIN = [
  { label: "Your organization", detail: "The plant, the people, the material" },
  { label: "Your GPU", detail: "Hardware you own, in a room you control" },
  { label: "Your models", detail: "Open weights, held on disk, no licence call-home" },
  { label: "Your data", detail: "Never leaves the perimeter" },
];

export function WhySovereign() {
  return (
    <Section id="platform" label="Why Sovereign AI">
      <SectionHeading
        eyebrow="The problem"
        title="Why Sovereign AI?"
        blurb="The documents that would benefit most from AI are exactly the ones an organisation cannot paste into a public model. That is not a policy quibble — it is the reason this category of work has stayed manual."
      />

      <Reveal className="mt-10">
        <p className="mono text-[11px] uppercase tracking-[0.18em] text-tertiary">
          Confidential data
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {CONFIDENTIAL.map((item) => (
            <li
              key={item}
              className="rounded-full border border-subtle bg-panel px-3 py-1.5 text-[13px] text-secondary"
            >
              {item}
            </li>
          ))}
        </ul>
      </Reveal>

      <div className="mt-10 grid gap-4 lg:grid-cols-2">
        <CloudPanel />
        <SovereignPanel />
      </div>
    </Section>
  );
}

function CloudPanel() {
  const reduced = useReducedMotion();

  return (
    <Reveal className="relative overflow-hidden rounded-[var(--radius)] border border-danger/30 bg-panel p-6">
      <header className="flex items-center gap-2.5">
        <Cloud className="size-4 text-danger" aria-hidden />
        <h3 className="text-sm font-semibold text-primary">Public cloud AI</h3>
      </header>
      <p className="mt-2 text-[13px] text-secondary">
        The material leaves the organisation to be processed on hardware it
        does not own, under terms it did not write.
      </p>

      <svg viewBox="0 0 420 150" className="mt-6 w-full" role="presentation" aria-hidden>
        {/* The perimeter, and the document crossing it. */}
        <rect
          x="8"
          y="18"
          width="180"
          height="114"
          rx="8"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
          strokeDasharray="5 5"
        />
        <text
          x="98"
          y="40"
          textAnchor="middle"
          className="fill-[var(--text-tertiary)] text-[10px] uppercase"
          style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.12em" }}
        >
          Your perimeter
        </text>

        <rect x="76" y="58" width="44" height="54" rx="4" fill="var(--bg-elevated)" stroke="var(--border-strong)" />
        <path d="M86 74h24M86 84h24M86 94h16" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" />

        <path
          d="M196 85h150"
          stroke="var(--danger)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          opacity="0.6"
        />
        <path d="M340 79l10 6-10 6z" fill="var(--danger)" opacity="0.8" />

        {/* The document, in transit out of the perimeter. */}
        {/* Under reduced motion the document is drawn where the animation
            would have left it -- outside the perimeter, on its way to the
            cloud. A static diagram showing it still safely inside would say
            the opposite of what this panel is about. */}
        <motion.g
          initial={reduced ? { x: 150, opacity: 0.55 } : { x: 0, opacity: 1 }}
          whileInView={reduced ? undefined : { x: 210, opacity: 0.35 }}
          viewport={{ once: true, amount: 0.5 }}
          transition={{ duration: 0.6, delay: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          <rect x="128" y="66" width="30" height="38" rx="3" fill="var(--bg-panel)" stroke="var(--danger)" strokeWidth="1.5" />
          <path d="M135 78h16M135 86h16M135 94h10" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" opacity="0.8" />
        </motion.g>

        <g transform="translate(352 62)">
          <rect width="60" height="46" rx="8" fill="var(--danger-soft)" stroke="var(--danger)" strokeWidth="1.5" opacity="0.9" />
          <path
            d="M18 26a8 8 0 0 1 1-15 11 11 0 0 1 21 3 7 7 0 0 1-1 12z"
            fill="none"
            stroke="var(--danger)"
            strokeWidth="1.5"
          />
        </g>
      </svg>

      <p className="mt-5 flex items-start gap-2 rounded-[var(--radius)] border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          A security and data-governance problem, before it is ever an AI
          problem. For most industrial documents this ends the conversation.
        </span>
      </p>
    </Reveal>
  );
}

function SovereignPanel() {
  return (
    <Reveal
      delay={0.08}
      className="relative overflow-hidden rounded-[var(--radius)] border border-accent/30 bg-panel p-6"
    >
      <header className="flex items-center gap-2.5">
        <ShieldCheck className="size-4 text-accent" aria-hidden />
        <h3 className="text-sm font-semibold text-primary">Sovereign AI</h3>
      </header>
      <p className="mt-2 text-[13px] text-secondary">
        The same material, the same capability, and nothing crosses the line.
      </p>

      <div className="mt-6 rounded-[var(--radius)] border border-dashed border-accent/40 bg-canvas/40 p-4">
        <p className="mono mb-4 text-center text-[10px] uppercase tracking-[0.12em] text-accent">
          Your perimeter
        </p>
        <ol className="space-y-2.5">
          {SOVEREIGN_CHAIN.map((step, index) => (
            <li key={step.label} className="flex items-start gap-3">
              <span
                className="mono mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-accent-soft text-[10px] text-accent-text"
                aria-hidden
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-primary">{step.label}</p>
                <p className="text-[12px] text-tertiary">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-5 flex items-start gap-2 rounded-[var(--radius)] border border-accent/25 bg-accent-soft/40 px-3 py-2.5 text-[13px] text-accent-text">
        <Cpu className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Enforced rather than promised: the runtime blocks outbound network
          calls and records every attempt, and the workbench can show you the
          count.
        </span>
      </p>
    </Reveal>
  );
}
