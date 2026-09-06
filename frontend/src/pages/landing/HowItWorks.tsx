/**
 * "How It Works" -- the seven stages a request passes through.
 *
 * The track fills as the section scrolls into view, and each stage lands
 * behind it. That is the mechanism being animated: it is the actual order of
 * operations inside the orchestrator, not a decorative sequence.
 */

import { motion, useReducedMotion } from "framer-motion";
import {
  CheckCircle2,
  Cpu,
  FileOutput,
  ListChecks,
  Play,
  ScanSearch,
  Upload,
} from "lucide-react";
import { RevealGroup, RevealItem, Section, SectionHeading } from "@/pages/landing/motion";

const STEPS = [
  { Icon: Upload, label: "Upload", detail: "Documents, images, drawings" },
  { Icon: ScanSearch, label: "Understand", detail: "OCR, parsing, classification" },
  { Icon: ListChecks, label: "Plan", detail: "Steps, tools, approvals" },
  { Icon: Cpu, label: "Select model", detail: "Smallest one that fits" },
  { Icon: Play, label: "Execute", detail: "Retrieval, reasoning, sandbox" },
  { Icon: CheckCircle2, label: "Verify", detail: "Checked against evidence" },
  { Icon: FileOutput, label: "Deliver", detail: "A file, with citations" },
];

export function HowItWorks() {
  const reduced = useReducedMotion();

  return (
    <Section id="workflows" label="How it works">
      <SectionHeading
        eyebrow="Workflows"
        title="How It Works"
        blurb="Every request follows the same seven stages, and the workbench shows you each one as it happens rather than returning an answer from nowhere."
      />

      <div className="relative mt-12">
        {/* The track. Horizontal from 768px up, vertical below -- the seven
            labels do not survive being squeezed onto a phone in a row. */}
        <div
          aria-hidden
          className="absolute left-5 top-0 h-full w-px bg-subtle md:left-5 md:top-5 md:h-px md:w-auto md:right-[calc((100%-4.5rem)/7-1.25rem)]"
        />
        {/* Two elements rather than one: the fill sweeps downward on a phone
            and rightward on a desktop, and a single element cannot do both --
            scaling Y on a one-pixel-high line is invisible. */}
        <motion.div
          aria-hidden
          className="absolute left-5 top-0 h-full w-px bg-accent md:hidden"
          style={{ transformOrigin: "top center" }}
          initial={reduced ? false : { scaleY: 0 }}
          whileInView={reduced ? undefined : { scaleY: 1 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />
        <motion.div
          aria-hidden
          className="absolute left-5 top-5 hidden h-px bg-accent md:block md:right-[calc((100%-4.5rem)/7-1.25rem)]"
          style={{ transformOrigin: "left center" }}
          initial={reduced ? false : { scaleX: 0 }}
          whileInView={reduced ? undefined : { scaleX: 1 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />

        <RevealGroup
          step={0.05}
          className="relative grid gap-6 md:grid-cols-7 md:gap-3"
        >
          {STEPS.map(({ Icon, label, detail }, index) => (
            <RevealItem key={label}>
              <div className="flex items-start gap-4 md:block">
                <div className="grid size-10 shrink-0 place-items-center rounded-full border border-accent/40 bg-canvas md:size-10">
                  <Icon className="size-4 text-accent" aria-hidden />
                </div>
                <div className="md:mt-4">
                  <p className="mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
                    {String(index + 1).padStart(2, "0")}
                  </p>
                  <p className="mt-1 text-[14px] font-medium text-primary">{label}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-tertiary">
                    {detail}
                  </p>
                </div>
              </div>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </Section>
  );
}
