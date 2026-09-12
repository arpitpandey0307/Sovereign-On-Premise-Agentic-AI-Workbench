/**
 * What a refusal offers instead of a dead end.
 *
 * A 403 never redirects in this product, because bouncing somebody hides the
 * reason and makes a governed system feel broken. This takes that one step
 * further: the panel that explains the refusal is also where you ask for what
 * you need, in your own words, and it shows you what happened to the ask.
 *
 * A system that can only say no gets worked around — people email documents to
 * each other and the control becomes the reason for the leak. This keeps the
 * work inside the part of the system that writes everything down.
 */

import { useState, type FormEvent } from "react";
import { Lock, Clock, CheckCircle2, XCircle, Send } from "lucide-react";
import { describeError } from "@/lib/api";
import { useMyAccessRequests, useRequestAccess } from "@/lib/queries";
import type { AccessRequest } from "@/lib/types";

const MIN_JUSTIFICATION = 20;

interface Props {
  /** The scope to ask for, e.g. `knowledge.search`. */
  scope: string;
  /** What the user was trying to reach, in the product's own words. */
  title: string;
  /** Why it is restricted. Shown before the form, never hidden. */
  reason: string;
}

export function RequestAccess({ scope, title, reason }: Props) {
  const [justification, setJustification] = useState("");
  const requests = useMyAccessRequests();
  const submit = useRequestAccess();

  const mine = (requests.data?.items ?? []).filter(
    (item) => item.scope === scope,
  );
  const open = mine.find((item) => item.state === "pending");
  const granted = mine.find((item) => item.active);
  const refused = mine.find((item) => item.state === "denied");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (justification.trim().length < MIN_JUSTIFICATION) return;
    submit.mutate(
      { scope, justification: justification.trim() },
      { onSuccess: () => setJustification("") },
    );
  }

  return (
    <section className="card request-access" aria-labelledby="request-access-title">
      <header className="request-access__head">
        <Lock size={18} aria-hidden />
        <div>
          <h2 id="request-access-title">{title}</h2>
          <p className="muted">{reason}</p>
        </div>
      </header>

      {granted ? (
        <p className="notice notice--ok">
          <CheckCircle2 size={14} aria-hidden /> Access granted until{" "}
          <strong>{formatWhen(granted.expires_at)}</strong>. Reload the page to
          use it.
        </p>
      ) : open ? (
        <p className="notice">
          <Clock size={14} aria-hidden /> Your request is with an administrator.
          Asked {formatWhen(open.created_at)}.
        </p>
      ) : (
        <form className="request-access__form" onSubmit={onSubmit}>
          <label htmlFor="justification">
            Why do you need this? An administrator reads exactly what you write
            here.
          </label>
          <textarea
            id="justification"
            rows={3}
            value={justification}
            placeholder="e.g. Preparing the CDU-3 shutdown pack and need to trace the isolation procedure across the corpus."
            onChange={(event) => setJustification(event.target.value)}
          />
          <div className="request-access__actions">
            <span className="muted">
              {justification.trim().length < MIN_JUSTIFICATION
                ? `${MIN_JUSTIFICATION - justification.trim().length} more characters`
                : "Ready to send"}
            </span>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                justification.trim().length < MIN_JUSTIFICATION ||
                submit.isPending
              }
            >
              <Send size={14} aria-hidden />
              {submit.isPending ? "Sending…" : "Request access"}
            </button>
          </div>
        </form>
      )}

      {submit.isError && (
        <p className="error-note">{describeError(submit.error).detail}</p>
      )}

      {refused && !open && !granted && (
        <p className="notice notice--bad">
          <XCircle size={14} aria-hidden /> A previous request was declined
          {refused.decision_note ? `: “${refused.decision_note}”` : "."}
        </p>
      )}

      {mine.length > 0 && <History items={mine} />}
    </section>
  );
}

function History({ items }: { items: AccessRequest[] }) {
  return (
    <details className="request-access__history">
      <summary>Your requests ({items.length})</summary>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <span className={`pill pill--${item.state}`}>{item.state}</span>
            <span className="muted">{formatWhen(item.created_at)}</span>
            <p>{item.justification}</p>
            {item.decision_note && (
              <p className="muted">Decision: {item.decision_note}</p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function formatWhen(value: string | null): string {
  if (!value) return "—";
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return "—";
  return when.toLocaleString();
}
