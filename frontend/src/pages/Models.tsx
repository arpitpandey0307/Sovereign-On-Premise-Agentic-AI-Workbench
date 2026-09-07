/**
 * The Model Center.
 *
 * The cards show what the registry and the runtime actually report, including
 * `status_detail` verbatim on anything unavailable — that one line ("not
 * pulled: run `ollama pull qwen3:8b`") saves more time than any UI.
 *
 * The routing playground runs `POST /api/v1/models/route`, which reasons about
 * a request without generating anything, and shows the four stages with what
 * fell out at each. It is the cheapest way to show that model selection is a
 * considered decision rather than a hard-coded name.
 *
 * Adding a model needs a backend endpoint that does not exist, so the form
 * produces the exact catalogue entry to paste into `app/models/catalog.py`
 * rather than pretending to POST. `Refresh Registry` is wired — that endpoint
 * is real.
 */

import { useState, type FormEvent } from "react";
import { Cpu, RefreshCw } from "lucide-react";
import { describeError } from "@/lib/api";
import { useRole } from "@/lib/auth";
import {
  useModels,
  usePreviewRouting,
  useRefreshRegistry,
} from "@/lib/queries";
import type { Classification, ModelDescriptor, RoutingDecision } from "@/lib/types";
import { StatusPill } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";

export function Models() {
  const { can } = useRole();
  const models = useModels();
  const refresh = useRefreshRegistry();
  const isAdmin = can("model", "admin");

  return (
    <div className="view-pad" style={{ maxWidth: "1100px" }}>
      <div className="view-head">
        <div className="flex flex-wrap items-center gap-3">
          <h2>Model Center</h2>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginLeft: "auto" }}
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              className={"size-3.5" + (refresh.isPending ? " animate-spin" : "")}
              aria-hidden
            />
            Refresh registry
          </button>
        </div>
        <div className="sub">
          Open-weight models on the local runtime. The router picks the smallest
          one that fits the job.
        </div>
      </div>

      {refresh.isSuccess && (
        <p className="hint" style={{ marginBottom: "12px", color: "var(--ok-text)" }}>
          Registry reconciled with the runtime.
        </p>
      )}
      {refresh.isError && (
        <p className="error-note" style={{ marginBottom: "12px" }}>
          {describeError(refresh.error).detail}
        </p>
      )}

      {models.isError ? (
        <ErrorState error={models.error} onRetry={() => models.refetch()} />
      ) : models.isLoading ? (
        <LoadingState rows={3} label="Loading models" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(models.data?.models ?? []).map((model) => (
            <ModelCard key={model.model_id} model={model} />
          ))}
        </div>
      )}

      <RoutingPlayground />

      {isAdmin && <AddModelForm />}
    </div>
  );
}

function ModelCard({ model }: { model: ModelDescriptor }) {
  const ready = model.status === "ready";
  return (
    <div className="card">
      <div className="flex items-start gap-2">
        <Cpu className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-primary">{model.name}</p>
          <p className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
            {model.model_id} · {model.provider} · {model.quantization}
          </p>
        </div>
        <StatusPill tone={ready ? "positive" : model.status === "loading" ? "info" : "inactive"}>
          {model.status}
        </StatusPill>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[12px]">
        <Fact label="Type" value={model.type} />
        <Fact label="Context" value={`${model.context_length.toLocaleString()} tok`} />
        <Fact label="VRAM" value={`${model.vram_required_gb} GB`} />
        <Fact label="Capabilities" value={model.capabilities.join(", ") || "—"} />
      </div>

      {model.status_detail && !ready && (
        <p
          className="mono mt-3 rounded-[var(--r-sm)] px-2 py-1.5 text-[11.5px]"
          style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--text-dim)" }}
        >
          {model.status_detail}
        </p>
      )}
      {model.notes && (
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-mute)" }}>
          {model.notes}
        </p>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ color: "var(--text-faint)" }}>{label}: </span>
      <span style={{ color: "var(--text-dim)" }}>{value}</span>
    </div>
  );
}

// --- routing playground ----------------------------------------------------

const TASK_TYPES = ["qa", "analysis", "coding", "summarisation", "vision"];
const CLASSIFICATIONS: Classification[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "HIGHLY_CONFIDENTIAL",
];

function RoutingPlayground() {
  const preview = usePreviewRouting();
  const [taskType, setTaskType] = useState("analysis");
  const [classification, setClassification] = useState<Classification>("CONFIDENTIAL");
  const [needsVision, setNeedsVision] = useState(false);

  function run(event: FormEvent) {
    event.preventDefault();
    preview.mutate({
      task_type: taskType,
      classification,
      requirements: needsVision ? ["vision"] : [],
    });
  }

  return (
    <section className="card mt-8">
      <div className="flex items-center gap-2">
        <span className="section-title">Routing playground</span>
        <span className="pill">no GPU time</span>
      </div>
      <p className="mt-1 text-[12px]" style={{ color: "var(--text-mute)" }}>
        Ask the router what it would choose, and why. Nothing is generated.
      </p>

      <form onSubmit={run} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-[12px]">
          <span className="field-label">Task type</span>
          <select
            className="select"
            style={{ maxWidth: "180px" }}
            value={taskType}
            onChange={(event) => setTaskType(event.target.value)}
          >
            {TASK_TYPES.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="text-[12px]">
          <span className="field-label">Classification</span>
          <select
            className="select"
            style={{ maxWidth: "200px" }}
            value={classification}
            onChange={(event) => setClassification(event.target.value as Classification)}
          >
            {CLASSIFICATIONS.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-dim)" }}>
          <input
            type="checkbox"
            checked={needsVision}
            onChange={(event) => setNeedsVision(event.target.checked)}
          />
          Needs vision
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={preview.isPending}>
          {preview.isPending ? "Routing…" : "Preview"}
        </button>
      </form>

      {preview.isError && (
        <p className="error-note" style={{ marginTop: "12px" }}>
          {describeError(preview.error).detail}
        </p>
      )}
      {preview.data && <RoutingResult decision={preview.data} />}
    </section>
  );
}

function RoutingResult({ decision }: { decision: RoutingDecision }) {
  const req = decision.requirements;
  const hw = decision.hardware;
  const ranked = decision.ranked ?? [];
  const rejected = decision.rejected ?? [];

  // The router reports a rejection's stage on the rejection itself, so the
  // stages are recovered by grouping rather than read from a `stages` array.
  const byStage = new Map<string, typeof rejected>();
  for (const entry of rejected) {
    const list = byStage.get(entry.stage) ?? [];
    list.push(entry);
    byStage.set(entry.stage, list);
  }

  return (
    <div className="mt-4">
      {decision.selected ? (
        <p className="text-[13px]">
          Selected:{" "}
          <span className="mono" style={{ color: "var(--accent-bright)" }}>
            {decision.selected.model_id}
          </span>
          {decision.selected.type ? (
            <span className="mono" style={{ color: "var(--text-mute)" }}>
              {" "}
              ({decision.selected.type})
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-[13px]" style={{ color: "var(--danger-text)" }}>
          No model satisfies this request. Every candidate was ruled out below.
        </p>
      )}

      {decision.rationale && (
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--text-dim)" }}>
          {decision.rationale}
        </p>
      )}

      {req && (
        <div
          className="mt-3 rounded-[var(--r-md)] border p-3"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="field-label" style={{ margin: 0 }}>
            What was asked for
          </div>
          <p className="mono mt-1 text-[11px]" style={{ color: "var(--text-mute)" }}>
            task {req.task_type ?? "—"} · type {req.model_type ?? "any"} ·{" "}
            {req.classification ?? "—"} · ~{req.estimated_context_tokens ?? 0} tokens
            {req.needs_vision ? " · vision" : ""}
            {req.needs_structured_output ? " · structured output" : ""}
          </p>
          {(req.required_capabilities?.length ?? 0) > 0 && (
            <p className="mono mt-1 text-[11px]" style={{ color: "var(--text-mute)" }}>
              required: {req.required_capabilities!.join(", ")}
            </p>
          )}
          {hw?.present && (
            <p className="mono mt-1 text-[11px]" style={{ color: "var(--text-faint)" }}>
              {hw.gpu} · {hw.free_vram_gb?.toFixed(1)} GB free of{" "}
              {hw.total_vram_gb?.toFixed(1)} GB · pressure{" "}
              {Math.round((hw.pressure ?? 0) * 100)}%
            </p>
          )}
        </div>
      )}

      {/* Rejections, grouped by the stage that ruled each candidate out. */}
      <div className="mt-3 space-y-3">
        {[...byStage.entries()].map(([stage, entries]) => (
          <div
            key={stage}
            className="rounded-[var(--r-md)] border p-3"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="field-label" style={{ margin: 0 }}>
              Ruled out at: {stage}
            </div>
            <ul className="mt-1 space-y-0.5">
              {entries.map((entry) => (
                <li
                  key={entry.model_id}
                  className="text-[12px]"
                  style={{ color: "var(--danger-text)" }}
                >
                  <span className="mono">{entry.model_id}</span> — {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        ))}

        {ranked.length > 0 && (
          <div
            className="rounded-[var(--r-md)] border p-3"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="field-label" style={{ margin: 0 }}>
              Scored{decision.considered ? ` · ${decision.considered} considered` : ""}
            </div>
            <ul className="mt-1 space-y-1.5">
              {ranked.map((entry) => (
                <li key={entry.model_id} className="text-[12px]">
                  <span
                    className="mono"
                    style={{
                      color:
                        entry.model_id === decision.selected?.model_id
                          ? "var(--ok-text)"
                          : "var(--text-dim)",
                    }}
                  >
                    {entry.model_id}
                  </span>
                  {entry.total != null ? ` · ${entry.total.toFixed(4)}` : ""}
                  {(entry.factors?.length ?? 0) > 0 && (
                    <span className="mono" style={{ color: "var(--text-faint)" }}>
                      {" "}
                      (
                      {entry
                        .factors!.map(
                          (f) => `${f.name} ${(f.contribution ?? f.value ?? 0).toFixed(3)}`,
                        )
                        .join(", ")}
                      )
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {decision.fallback_chain && decision.fallback_chain.length > 0 && (
        <p className="mono mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
          fallback chain: {decision.fallback_chain.join(" → ")}
        </p>
      )}
    </div>
  );
}

// --- add model (catalogue-entry generator) --------------------------------

function AddModelForm() {
  const [form, setForm] = useState({
    model_id: "",
    name: "",
    provider: "ollama",
    identifier: "",
    type: "text",
    capabilities: "qa, analysis",
    context_length: "8192",
    quantization: "Q4_K_M",
    vram_required_gb: "6",
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const entry = `ModelSpec(
    model_id="${form.model_id || "my-model-7b"}",
    name="${form.name || "My Model 7B"}",
    provider="${form.provider}",
    model_identifier="${form.identifier || "my-model:7b"}",
    type="${form.type}",
    capabilities=[${form.capabilities
      .split(",")
      .map((c) => `"${c.trim()}"`)
      .filter((c) => c !== '""')
      .join(", ")}],
    context_length=${Number(form.context_length) || 8192},
    quantization="${form.quantization}",
    vram_required_gb=${Number(form.vram_required_gb) || 6},
)`;

  return (
    <section className="card mt-8">
      <span className="section-title">Add a local model</span>
      <p
        className="mt-2 flex items-start gap-2 rounded-[var(--radius)] px-3 py-2 text-[12.5px]"
        style={{
          background: "var(--warn-bg)",
          border: "1px solid var(--warn-line)",
          color: "var(--warn-text)",
        }}
      >
        Models are defined in the catalogue on this deployment. There is no
        add-model endpoint yet — fill this in and paste the generated entry into{" "}
        <span className="mono">app/models/catalog.py</span>, then Refresh
        Registry.
      </p>

      <fieldset className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Model id" value={form.model_id} onChange={set("model_id")} placeholder="qwen3-8b" />
        <Field label="Display name" value={form.name} onChange={set("name")} placeholder="Qwen3 8B" />
        <Field label="Provider" value={form.provider} onChange={set("provider")} />
        <Field label="Model identifier" value={form.identifier} onChange={set("identifier")} placeholder="qwen3:8b" />
        <Field label="Type" value={form.type} onChange={set("type")} />
        <Field label="Capabilities (comma-sep)" value={form.capabilities} onChange={set("capabilities")} />
        <Field label="Context length" value={form.context_length} onChange={set("context_length")} />
        <Field label="Quantization" value={form.quantization} onChange={set("quantization")} />
        <Field label="VRAM required (GB)" value={form.vram_required_gb} onChange={set("vram_required_gb")} />
      </fieldset>

      <div className="field-label" style={{ marginTop: "14px" }}>
        Catalogue entry
      </div>
      <pre className="code-block">{entry}</pre>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-[12px]">
      <span className="field-label">{label}</span>
      <input className="input" value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  );
}
