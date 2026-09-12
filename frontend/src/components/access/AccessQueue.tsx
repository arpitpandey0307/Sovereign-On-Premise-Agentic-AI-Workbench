/**
 * The administrator's side of an access request.
 *
 * Two things are on the screen deliberately. The asker's **own words** are the
 * whole basis for the decision — an approver with nothing to weigh is a rubber
 * stamp with extra steps. And the **duration** is chosen here rather than
 * assumed, because a grant that never ends is how a clearance model gets taken
 * apart by a year of small favours nobody remembers.
 */

import { useState } from "react";
import { Check, Clock, ShieldQuestion, X } from "lucide-react";
import { describeError } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useAccessRequests, useDecideAccessRequest } from "@/lib/queries";
import type { AccessRequest } from "@/lib/types";

const DURATIONS = [
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
];

export function AccessQueue() {
  const { data, isError, error } = useAccessRequests();
  const items = data?.items ?? [];
  const pending = items.filter((item) => item.state === "pending");
  const decided = items.filter((item) => item.state !== "pending");

  if (isError) {
    return <p className="error-note">{describeError(error).detail}</p>;
  }

  return (
    <section className="access-queue">
      <div className="view-head">
        <h3>
          <ShieldQuestion size={16} aria-hidden /> Access requests
        </h3>
        <div className="sub">
          People asking for a permission their role does not carry. Every
          decision, and the reason given for it, is written to the audit ledger.
        </div>
      </div>

      {pending.length === 0 ? (
        <p className="muted">Nothing waiting.</p>
      ) : (
        <ul className="access-queue__list">
          {pending.map((item) => (
            <PendingRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      {decided.length > 0 && (
        <details className="access-queue__history">
          <summary>Decided ({decided.length})</summary>
          <ul>
            {decided.map((item) => (
              <li key={item.id}>
                <span className={`pill pill--${item.state}`}>{item.state}</span>
                <strong>{item.user_email}</strong>
                <span className="muted"> · {item.scope}</span>
                {item.expires_at && item.state === "approved" && (
                  <span className="muted">
                    {item.active
                      ? ` · expires ${formatRelative(item.expires_at)}`
                      : " · expired"}
                  </span>
                )}
                {item.decision_note && (
                  <p className="muted">“{item.decision_note}”</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PendingRow({ item }: { item: AccessRequest }) {
  const [note, setNote] = useState("");
  const [hours, setHours] = useState(DURATIONS[0].hours);
  const decide = useDecideAccessRequest();

  return (
    <li className="card access-queue__row">
      <div className="access-queue__who">
        <strong>{item.user_email}</strong>
        <span className="muted">
          {item.user_roles.join(", ") || "no role"} · asked{" "}
          {formatRelative(item.created_at ?? "")}
        </span>
        <span className="pill">{item.scope}</span>
      </div>

      {/* Their words, not a summary of them. */}
      <blockquote className="access-queue__why">{item.justification}</blockquote>

      <div className="access-queue__decide">
        <label>
          <Clock size={13} aria-hidden /> Grant for
          <select
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            {DURATIONS.map((option) => (
              <option key={option.hours} value={option.hours}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          value={note}
          placeholder="Note for the record (optional)"
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate({ id: item.id, approved: true, note, hours })
          }
        >
          <Check size={14} aria-hidden /> Approve
        </button>
        <button
          type="button"
          className="btn"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate({ id: item.id, approved: false, note })
          }
        >
          <X size={14} aria-hidden /> Decline
        </button>
      </div>

      {decide.isError && (
        <p className="error-note">{describeError(decide.error).detail}</p>
      )}
    </li>
  );
}
