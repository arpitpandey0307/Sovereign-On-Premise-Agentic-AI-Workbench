/**
 * "From AI Assistant to AI Workbench".
 *
 * The distinction the product rests on: an assistant returns text and stops,
 * a workbench carries the task through to something you can send onward. The
 * first stage is deliberately marked as where the familiar tool ends.
 */

import { ArrowRight } from "lucide-react";
import { RevealGroup, RevealItem, Section, SectionHeading } from "@/pages/landing/motion";
import { cn } from "@/lib/cn";

const STAGES = [
  { label: "Chat", detail: "Ask a question", assistant: true },
  { label: "Reason", detail: "Work through the evidence", assistant: false },
  { label: "Execute", detail: "Run tools and code", assistant: false },
  { label: "Verify", detail: "Check the answer against sources", assistant: false },
  { label: "Deliver", detail: "Produce the file", assistant: false },
];

export function Transformation() {
  return (
    <Section id="transformation" label="From assistant to workbench" className="bg-panel/30">
      <SectionHeading
        eyebrow="The difference"
        title="From AI Assistant to AI Workbench"
        blurb="A chat window hands the work back to you at the first stage. The rest of this sequence is the part that usually stays manual."
      />

      <RevealGroup className="mt-10 flex flex-col gap-3 lg:flex-row lg:items-stretch">
        {STAGES.map((stage, index) => (
          <RevealItem key={stage.label} className="flex flex-1 items-center gap-3">
            <div
              className={cn(
                "h-full flex-1 rounded-[var(--radius)] border p-4",
                stage.assistant
                  ? "border-dashed border-strong bg-canvas"
                  : "border-accent/30 bg-panel",
              )}
            >
              <p
                className={cn(
                  "text-[14px] font-semibold",
                  stage.assistant ? "text-tertiary" : "text-primary",
                )}
              >
                {stage.label}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-tertiary">
                {stage.detail}
              </p>
              {stage.assistant && (
                <p className="mono mt-3 text-[10px] uppercase tracking-[0.12em] text-tertiary">
                  Assistants stop here
                </p>
              )}
            </div>

            {index < STAGES.length - 1 && (
              <ArrowRight
                className="hidden size-4 shrink-0 text-tertiary lg:block"
                aria-hidden
              />
            )}
          </RevealItem>
        ))}
      </RevealGroup>
    </Section>
  );
}
