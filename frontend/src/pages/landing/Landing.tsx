/**
 * The public landing page.
 *
 * This is the one surface in the product where the expressive register is
 * deliberate; everything behind the login stays restrained. The rule holding
 * the two together is that motion here has a subject -- a document moving
 * through the pipeline, a boundary being crossed, a track filling as the
 * process runs. Nothing loops ambiently, and the page is complete and
 * comprehensible with every animation switched off.
 *
 * It is route-split from the application so a visitor who never signs in does
 * not download the workbench, and someone using the workbench does not carry
 * this page's animation code around with them.
 */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { Navbar, NAV_SECTIONS } from "@/pages/landing/Navbar";
import { Hero } from "@/pages/landing/Hero";
import { WhySovereign } from "@/pages/landing/WhySovereign";
import { Capabilities } from "@/pages/landing/Capabilities";
import { HowItWorks } from "@/pages/landing/HowItWorks";
import { IndustrialWork } from "@/pages/landing/IndustrialWork";
import { SovereigntyMetrics } from "@/pages/landing/SovereigntyMetrics";
import { Transformation } from "@/pages/landing/Transformation";
import { Deployment } from "@/pages/landing/Deployment";
import { EnterWorkbenchButton } from "@/pages/landing/actions";
import { Reveal, Section } from "@/pages/landing/motion";

export default function Landing() {
  // The application shell owns the scroll inside itself; this page owns the
  // window's. Without releasing it the landing page cannot scroll at all after
  // navigating back from the workbench.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "auto";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="min-h-screen bg-canvas">
      <Navbar />

      <main>
        <Hero />
        <WhySovereign />
        <Capabilities />
        <HowItWorks />
        <IndustrialWork />
        <SovereigntyMetrics />
        <Transformation />
        <Deployment />
        <FinalCta />
      </main>

      <Footer />
    </div>
  );
}

function FinalCta() {
  return (
    <Section id="enter" label="Enter the workbench">
      <Reveal className="relative overflow-hidden rounded-[var(--radius)] border border-subtle bg-panel px-6 py-14 text-center sm:px-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(70% 120% at 50% 0%, var(--accent-soft) 0%, transparent 65%)",
          }}
        />
        <div className="relative">
          <h2 className="text-balance text-3xl font-semibold tracking-tight text-primary sm:text-4xl">
            Enter the Sovereign Workbench
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-secondary">
            Confidential work, done on your own hardware, with a record of
            everything the system did and every source it used.
          </p>
          <div className="mt-8 flex justify-center">
            <EnterWorkbenchButton size="lg" />
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-subtle px-6 py-12">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="grid size-7 place-items-center rounded bg-accent-soft">
              <Lock className="size-3.5 text-accent" aria-hidden />
            </div>
            <span className="text-[13px] font-semibold tracking-tight text-primary">
              Sovereign AI
            </span>
          </div>
          <p className="mt-2 text-[12px] text-tertiary">
            Private Industrial Intelligence
          </p>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap gap-x-8 gap-y-3">
          <ul className="space-y-2">
            {NAV_SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="text-[12px] text-secondary transition-colors hover:text-primary"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
          <ul className="space-y-2">
            <li>
              <Link
                to="/login"
                className="text-[12px] text-secondary transition-colors hover:text-primary"
              >
                Sign In
              </Link>
            </li>
            <li>
              <a
                href="#architecture"
                className="text-[12px] text-secondary transition-colors hover:text-primary"
              >
                Download
              </a>
            </li>
          </ul>
        </nav>
      </div>

      <p className="mx-auto mt-10 w-full max-w-6xl text-[11px] text-tertiary">
        Runs entirely on your own infrastructure. No external AI services, no
        outbound calls.
      </p>
    </footer>
  );
}
