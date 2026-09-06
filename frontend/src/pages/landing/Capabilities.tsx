import {
  Boxes,
  BrainCircuit,
  FileCheck2,
  Images,
  Library,
  ShieldCheck,
} from "lucide-react";
import {
  RevealGroup,
  RevealItem,
  Section,
  SectionHeading,
} from "@/pages/landing/motion";

const CAPABILITIES = [
  {
    Icon: BrainCircuit,
    title: "Local Intelligence",
    body: "Open-weight models running on your own GPU. The router picks the smallest model that can do the job, and says which one it chose and why.",
  },
  {
    Icon: Boxes,
    title: "Agentic Workflows",
    body: "The workbench plans, retrieves, reasons, runs code in a sandbox and validates its own output — pausing for approval before anything consequential.",
  },
  {
    Icon: Images,
    title: "Multimodal Understanding",
    body: "Scanned reports, photographs of equipment, and P&ID drawings, read with OCR and a vision model rather than skipped.",
  },
  {
    Icon: Library,
    title: "Enterprise Knowledge",
    body: "Your documents become a searchable knowledge graph. Answers cite the page and clause they came from, so they can be checked.",
  },
  {
    Icon: FileCheck2,
    title: "Real Deliverables",
    body: "Reports, approval notes, spreadsheets and analyses as files you can send onward — not a chat transcript to copy out by hand.",
  },
  {
    Icon: ShieldCheck,
    title: "Sovereign Security",
    body: "Role-based access, document classification, a tamper-evident audit ledger, and outbound network calls blocked and counted.",
  },
];

export function Capabilities() {
  return (
    <Section id="capabilities" label="Capabilities" className="bg-panel/30">
      <SectionHeading
        eyebrow="Capabilities"
        title="One Workbench. Multiple AI Capabilities."
        blurb="Six capabilities in one environment, so a piece of work does not have to leave it halfway through."
      />

      <RevealGroup className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CAPABILITIES.map(({ Icon, title, body }) => (
          <RevealItem key={title}>
            {/* The hover lift is restrained on purpose: a card that jumps is a
                consumer-app gesture, and this is infrastructure. */}
            <article className="group h-full rounded-[var(--radius)] border border-subtle bg-panel p-5 transition-[transform,border-color] duration-300 hover:-translate-y-0.5 hover:border-accent/40">
              <div className="grid size-9 place-items-center rounded-[var(--radius)] bg-accent-soft transition-colors">
                <Icon className="size-4.5 text-accent" aria-hidden />
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-primary">{title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-secondary">{body}</p>
            </article>
          </RevealItem>
        ))}
      </RevealGroup>
    </Section>
  );
}
