import {
  BarChart3,
  ClipboardCheck,
  FileSpreadsheet,
  GitBranch,
  Ruler,
  Terminal,
} from "lucide-react";
import { RevealGroup, RevealItem, Section, SectionHeading } from "@/pages/landing/motion";

const USE_CASES = [
  {
    Icon: ClipboardCheck,
    title: "Inspection Review",
    body: "Read an inspection report against the governing SOP and list the deviations, each one citing the clause it breaches.",
  },
  {
    Icon: Ruler,
    title: "Engineering Analysis",
    body: "Work through calculations and design checks with the standards and datasheets already in context.",
  },
  {
    Icon: GitBranch,
    title: "P&ID Understanding",
    body: "Identify equipment, tags and connections in a piping and instrumentation diagram, and answer questions about the loop.",
  },
  {
    Icon: Terminal,
    title: "Code Generation",
    body: "Write and run analysis scripts in a sandbox with no network, and return the output with the code that produced it.",
  },
  {
    Icon: BarChart3,
    title: "Data Analysis",
    body: "Summarise operational data, find the outliers, and produce the chart alongside the numbers behind it.",
  },
  {
    Icon: FileSpreadsheet,
    title: "Report Generation",
    body: "Turn the finished work into a document or spreadsheet in the format the recipient already expects.",
  },
];

export function IndustrialWork() {
  return (
    <Section id="industrial" label="Built for industrial work" className="bg-panel/30">
      <SectionHeading
        eyebrow="In practice"
        title="Built for Industrial Work"
        blurb="Not a general assistant pointed at a plant. These are the tasks the workbench was shaped around."
      />

      <RevealGroup className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {USE_CASES.map(({ Icon, title, body }) => (
          <RevealItem key={title}>
            <article className="h-full rounded-[var(--radius)] border border-subtle bg-canvas p-5 transition-[transform,border-color] duration-300 hover:-translate-y-0.5 hover:border-accent/40">
              <div className="flex items-center gap-2.5">
                <Icon className="size-4 text-accent" aria-hidden />
                <h3 className="text-[14px] font-semibold text-primary">{title}</h3>
              </div>
              <p className="mt-2.5 text-[13px] leading-relaxed text-secondary">{body}</p>
            </article>
          </RevealItem>
        ))}
      </RevealGroup>
    </Section>
  );
}
