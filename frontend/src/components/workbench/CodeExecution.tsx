/**
 * A coding task's execution result.
 *
 * Two failure modes that mean entirely different things are kept apart. The
 * sandbox failing to run is reported by the caller as a distinct banner — the
 * code never executed. Here, a non-zero `exitCode` is the code running and
 * failing on its own terms, and its stderr is shown as the reason. Exit `0` is
 * a clean run.
 */

import type { PipelineState } from "@/lib/pipeline";

export function CodeExecution({ run }: { run: NonNullable<PipelineState["codeRun"]> }) {
  const failed = run.exitCode != null && run.exitCode !== 0;

  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div className="flex items-center justify-between">
        <span className="section-title">Execution</span>
        <span
          className={"pill " + (failed ? "danger" : run.exitCode === 0 ? "ok" : "")}
        >
          {run.exitCode == null ? "RAN" : `EXIT ${run.exitCode}`}
        </span>
      </div>

      {failed && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--danger-text)" }}>
          The code ran and exited non-zero. This is the program failing, not the
          sandbox.
        </p>
      )}

      {run.stdout && (
        <>
          <div className="field-label" style={{ marginTop: "10px" }}>
            stdout
          </div>
          <pre className="code-block">{run.stdout}</pre>
        </>
      )}
      {run.stderr && (
        <>
          <div className="field-label" style={{ marginTop: "10px" }}>
            stderr
          </div>
          <pre className="code-block" style={{ color: "var(--danger-text)" }}>
            {run.stderr}
          </pre>
        </>
      )}
    </div>
  );
}
