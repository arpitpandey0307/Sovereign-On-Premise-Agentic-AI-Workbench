/**
 * The hero visual: a document travelling the workbench's pipeline.
 *
 * Inline SVG rather than a video, a Lottie file or an illustration library.
 * This page gets shown on unfamiliar hardware and over conference wifi: SVG
 * scales to a projector without artefacts, weighs a few kilobytes, themes
 * itself from the same CSS variables as the rest of the product, and needs no
 * decoder. It is also the only format where the diagram stays legible when
 * someone zooms in on a 1080p projector.
 *
 * It animates by advancing one integer. The travelling glyph and the stage
 * lighting both read from that index, so they cannot drift apart -- which is
 * what happens when two independent loops are each given their own duration.
 *
 * Everything moved here is a transform or an opacity. Nothing triggers layout,
 * because a stutter in the first thing a visitor sees is expensive.
 */

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

type Stage = {
  id: string;
  label: string;
  /** Second line of the label, so long names do not shrink the type. */
  label2?: string;
  /** Shown on narrow screens, where the pipeline drops to three stages. */
  compact: boolean;
};

const STAGES: Stage[] = [
  { id: "document", label: "Confidential", label2: "Document", compact: true },
  { id: "runtime", label: "Local AI", label2: "Runtime", compact: false },
  { id: "orchestration", label: "Agentic", label2: "Orchestration", compact: true },
  { id: "analysis", label: "Analysis", compact: false },
  { id: "deliverable", label: "Validated", label2: "Deliverable", compact: true },
];

/** How long each stage holds before the document moves on. */
const DWELL_MS = 1400;

const VIEW_W = 960;
const VIEW_H = 192;
const TRACK_Y = 104;
const FIRST_X = 96;

export function HeroPipeline() {
  const reduced = useReducedMotion();
  const [narrow, setNarrow] = useState(false);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  // Below 768px the pipeline drops to three stages rather than shrinking to
  // illegibility. Five labels at that width are a grey smear.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const stages = narrow ? STAGES.filter((stage) => stage.compact) : STAGES;
  const spacing = (VIEW_W - FIRST_X * 2) / (stages.length - 1);
  const xFor = (index: number) => FIRST_X + index * spacing;

  // Advance the pipeline. Paused on hover so someone can actually read it --
  // a diagram that carries the product's core claim and never stops moving is
  // a diagram nobody reads.
  useEffect(() => {
    if (reduced || paused) return;
    const timer = window.setInterval(
      () => setActive((index) => (index + 1) % (stages.length + 1)),
      DWELL_MS,
    );
    return () => window.clearInterval(timer);
  }, [reduced, paused, stages.length]);

  // The extra step past the last stage is a beat where the deliverable rests
  // complete before the loop restarts. Under reduced motion every stage is
  // simply lit: the diagram is the message, and it is all true at once.
  const reached = (index: number) => reduced || index <= active;
  const travelIndex = Math.min(active, stages.length - 1);
  const progress = reduced ? 1 : travelIndex / (stages.length - 1);

  return (
    <div
      className="relative w-full"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* The pipeline states the product's central claim, so it is not
          decorative and must reach a screen reader as text. */}
      <p className="sr-only">
        How the workbench handles a document, in {stages.length} stages:{" "}
        {stages
          .map((stage) => [stage.label, stage.label2].filter(Boolean).join(" "))
          .join(", then ")}
        . Every stage runs on the organisation's own hardware.
      </p>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        role="presentation"
        aria-hidden
      >
        <defs>
          <linearGradient id="track-fade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        <BoardMotif />

        {/* The track, and the accent that fills along it. */}
        <line
          x1={FIRST_X}
          y1={TRACK_Y}
          x2={VIEW_W - FIRST_X}
          y2={TRACK_Y}
          stroke="var(--border-strong)"
          strokeWidth="1.5"
          strokeDasharray="4 6"
        />
        <motion.line
          x1={FIRST_X}
          y1={TRACK_Y}
          x2={VIEW_W - FIRST_X}
          y2={TRACK_Y}
          stroke="url(#track-fade)"
          strokeWidth="2"
          style={{ transformBox: "fill-box", transformOrigin: "left center" }}
          initial={false}
          animate={{ scaleX: progress }}
          transition={{ duration: reduced ? 0 : 0.55, ease: [0.16, 1, 0.3, 1] }}
        />

        {stages.map((stage, index) => (
          <PipelineStage
            key={stage.id}
            stage={stage}
            x={xFor(index)}
            lit={reached(index)}
            current={!reduced && index === travelIndex && active < stages.length}
          />
        ))}

        {!reduced && (
          <motion.g
            initial={false}
            animate={{ x: xFor(travelIndex) - FIRST_X }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <DocumentGlyph x={FIRST_X} y={TRACK_Y} />
          </motion.g>
        )}
      </svg>
    </div>
  );
}

/**
 * One stage. Unlit stages stay clearly visible rather than fading out --
 * the diagram has to be readable at any moment of the loop, including in a
 * screenshot.
 */
function PipelineStage({
  stage,
  x,
  lit,
  current,
}: {
  stage: Stage;
  x: number;
  lit: boolean;
  current: boolean;
}) {
  return (
    <g>
      {/* A halo on the current stage. Opacity only. */}
      <motion.circle
        cx={x}
        cy={TRACK_Y}
        r="26"
        fill="var(--accent)"
        initial={false}
        animate={{ opacity: current ? 0.14 : 0 }}
        transition={{ duration: 0.4 }}
      />
      <motion.rect
        x={x - 17}
        y={TRACK_Y - 17}
        width="34"
        height="34"
        rx="9"
        initial={false}
        animate={{
          fill: lit ? "var(--accent-soft)" : "var(--bg-elevated)",
          stroke: lit ? "var(--accent)" : "var(--border-strong)",
        }}
        transition={{ duration: 0.35 }}
        strokeWidth="1.5"
      />
      <StageGlyph id={stage.id} x={x} lit={lit} />

      <text
        x={x}
        y={TRACK_Y + 52}
        textAnchor="middle"
        className="fill-[var(--text-primary)] text-[13px] font-medium"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {stage.label}
      </text>
      {stage.label2 && (
        <text
          x={x}
          y={TRACK_Y + 69}
          textAnchor="middle"
          className="fill-[var(--text-primary)] text-[13px] font-medium"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          {stage.label2}
        </text>
      )}
    </g>
  );
}

/** A small mark per stage, drawn rather than imported, to keep the file light. */
function StageGlyph({ id, x, lit }: { id: string; x: number; lit: boolean }) {
  const stroke = lit ? "var(--accent-text)" : "var(--text-tertiary)";
  const common = {
    stroke,
    strokeWidth: 1.5,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (id) {
    case "document":
      return (
        <g transform={`translate(${x - 6} ${TRACK_Y - 8})`}>
          <path d="M0 0h8l4 4v12H0z" {...common} />
          <path d="M3 8h6M3 11h6" {...common} />
        </g>
      );
    case "runtime": // a GPU die
      return (
        <g transform={`translate(${x - 8} ${TRACK_Y - 8})`}>
          <rect x="3" y="3" width="10" height="10" rx="2" {...common} />
          <path d="M6 0v3M10 0v3M6 13v3M10 13v3M0 6h3M0 10h3M13 6h3M13 10h3" {...common} />
        </g>
      );
    case "orchestration": // a small graph
      return (
        <g transform={`translate(${x - 8} ${TRACK_Y - 8})`}>
          <circle cx="3" cy="3" r="2.2" {...common} />
          <circle cx="13" cy="3" r="2.2" {...common} />
          <circle cx="8" cy="13" r="2.2" {...common} />
          <path d="M5 3h6M4 5l3 6M12 5l-3 6" {...common} />
        </g>
      );
    case "analysis":
      return (
        <g transform={`translate(${x - 8} ${TRACK_Y - 8})`}>
          <path d="M1 15V9M6 15V4M11 15V7M15 15V1" {...common} />
        </g>
      );
    default: // deliverable: a document with a check
      return (
        <g transform={`translate(${x - 8} ${TRACK_Y - 8})`}>
          <path d="M2 0h7l4 4v12H2z" {...common} />
          <path d="M5 9l2.5 2.5L12 7" {...common} />
        </g>
      );
  }
}

/** The document in transit. */
function DocumentGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y - 44})`}>
      <rect
        x="-11"
        y="-14"
        width="22"
        height="28"
        rx="3"
        fill="var(--bg-panel)"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />
      <path
        d="M-6 -7h12M-6 -2h12M-6 3h8"
        stroke="var(--accent-text)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* A short leader down to the track, so the glyph reads as being *on*
          the pipeline rather than floating above it. */}
      <path d="M0 14v16" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="2 3" />
    </g>
  );
}

/**
 * The infrastructure the pipeline runs on, as a board.
 *
 * Faint circuit traces behind the track rather than a row of rack outlines:
 * the first attempt drew racks as boxes of thin horizontal lines, which at low
 * contrast read as blocks of redacted text sitting under the labels. Traces
 * and vias cannot be mistaken for anything but hardware, and they sit *behind*
 * the pipeline instead of competing with it for the same space.
 */
function BoardMotif() {
  // Placed to stay clear of the travelling glyph (which occupies the band
  // just above the track) and of the stage labels below it. A background that
  // crosses the subject is not a background.
  const traces = [
    { y: 22, from: 40, to: 300 },
    { y: 22, from: 660, to: 920 },
    { y: 186, from: 120, to: 420 },
    { y: 186, from: 560, to: 880 },
  ];

  return (
    <g opacity="0.4" aria-hidden>
      {traces.map((trace) => (
        <g key={`${trace.y}-${trace.from}`}>
          <path
            d={`M${trace.from} ${trace.y}h${trace.to - trace.from}`}
            stroke="var(--border-strong)"
            strokeWidth="1"
            fill="none"
          />
          <circle cx={trace.from} cy={trace.y} r="2.5" fill="none" stroke="var(--border-strong)" />
          <circle cx={trace.to} cy={trace.y} r="2.5" fill="none" stroke="var(--border-strong)" />
        </g>
      ))}
      {/* A die outline, centred behind the runtime stage. */}
      <rect
        x="432"
        y="8"
        width="96"
        height="26"
        rx="4"
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth="1"
      />
      <path
        d="M448 8V2M472 8V2M496 8V2M512 8V2M448 34v6M472 34v6M496 34v6M512 34v6"
        stroke="var(--border-strong)"
        strokeWidth="1"
      />
    </g>
  );
}
