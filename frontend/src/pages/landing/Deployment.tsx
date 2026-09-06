/**
 * "Architecture" -- what actually gets installed, and the download.
 *
 * The download is deliberately not wired to anything. A button that produces a
 * 404 in front of a reviewer costs far more than the button gains, and on a
 * page whose entire subject is trustworthiness, a dead link is the worst
 * possible detail to be caught on. It opens a modal that says the installer is
 * not published yet, which is honest and unremarkable.
 */

import { useState } from "react";
import { Cpu, Download, HardDrive, Network, Server } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Reveal, Section, SectionHeading } from "@/pages/landing/motion";

const COMPONENTS = [
  {
    Icon: Server,
    title: "Application",
    body: "The workbench API and interface, served from one process on the host.",
  },
  {
    Icon: Cpu,
    title: "Model runtime",
    body: "A local runtime holding the open-weight models, with a GPU-aware router in front of it.",
  },
  {
    Icon: HardDrive,
    title: "Stores",
    body: "A relational database for records, a graph database for knowledge, and object storage for files.",
  },
  {
    Icon: Network,
    title: "Sandbox",
    body: "A container with no network interface, where generated code is allowed to run.",
  },
];

const REQUIREMENTS = [
  ["GPU", "NVIDIA, 8 GB VRAM or more"],
  ["Memory", "32 GB system RAM"],
  ["Storage", "100 GB, mostly model weights"],
  ["Network", "None required — installs and runs air-gapped"],
];

export function Deployment() {
  const [askOpen, setAskOpen] = useState(false);

  return (
    <Section id="architecture" label="Architecture and deployment">
      <SectionHeading
        eyebrow="Architecture"
        title="Deploys inside your perimeter"
        blurb="One installation on hardware you already own. No outbound connection is needed to install it, register it, or run it."
      />

      <div className="mt-10 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Reveal className="grid gap-4 sm:grid-cols-2">
          {COMPONENTS.map(({ Icon, title, body }) => (
            <article
              key={title}
              className="rounded-[var(--radius)] border border-subtle bg-panel p-5"
            >
              <div className="flex items-center gap-2.5">
                <Icon className="size-4 text-accent" aria-hidden />
                <h3 className="text-[14px] font-semibold text-primary">{title}</h3>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-secondary">{body}</p>
            </article>
          ))}
        </Reveal>

        <Reveal delay={0.08} className="rounded-[var(--radius)] border border-subtle bg-panel p-6">
          <h3 className="text-[14px] font-semibold text-primary">
            What it asks of the machine
          </h3>
          <dl className="mt-4 space-y-3">
            {REQUIREMENTS.map(([term, detail]) => (
              <div key={term}>
                <dt className="mono text-[10px] uppercase tracking-[0.14em] text-tertiary">
                  {term}
                </dt>
                <dd className="mt-0.5 text-[13px] text-secondary">{detail}</dd>
              </div>
            ))}
          </dl>

          <Button
            variant="secondary"
            className="mt-6 w-full"
            onClick={() => setAskOpen(true)}
          >
            <Download className="size-4" aria-hidden />
            Download for on-premise
          </Button>
          <p className="mt-2 text-center text-[11px] text-tertiary">
            Installer not yet published
          </p>
        </Reveal>
      </div>

      <Dialog
        open={askOpen}
        onClose={() => setAskOpen(false)}
        title="The installer is not published yet"
        description="Sovereign AI — on-premise deployment"
        footer={
          <Button variant="secondary" onClick={() => setAskOpen(false)}>
            Close
          </Button>
        }
      >
        <p className="text-secondary">
          The on-premise installer is still being packaged, so there is nothing
          to download today. When it is ready it will be a single archive that
          can be carried in on removable media and installed with no network
          connection at all.
        </p>
        <p className="mt-3 text-secondary">
          In the meantime the workbench itself is running and can be explored
          from the sign-in page.
        </p>
      </Dialog>
    </Section>
  );
}
