/**
 * The quiet warning before a session ends.
 *
 * Sessions here are short by design -- this is a shared workstation holding
 * confidential material -- so expiry is a normal event rather than an
 * exception, and the interface should say it is coming. The alternative is
 * someone losing a half-written request to a silent 401, which teaches people
 * to distrust the product for a reason that has nothing to do with the model.
 *
 * It stays a strip rather than a modal: it is information, not a decision, and
 * interrupting work to announce that work is about to be interrupted is worse
 * than the problem.
 */

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useAuth } from "@/lib/auth";

export function SessionNotice() {
  const { expiringSoon, expiresAt } = useAuth();
  const [minutes, setMinutes] = useState<number | null>(null);

  // The clock is read here rather than during render, so the component stays
  // a pure function of its props and the countdown updates on a schedule
  // instead of on whatever else happens to re-render the shell. Every 30
  // seconds: the displayed number changes no faster than once a minute.
  useEffect(() => {
    if (!expiringSoon || !expiresAt) {
      setMinutes(null);
      return;
    }
    const update = () =>
      setMinutes(Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 60_000)));
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [expiringSoon, expiresAt]);

  if (!expiringSoon || !expiresAt || minutes === null) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-warning/30 bg-warning-soft px-4 py-1.5 text-xs text-warning"
    >
      <Clock className="size-3.5" aria-hidden />
      <span>
        {minutes > 0
          ? `Your session ends in ${minutes} minute${minutes === 1 ? "" : "s"}. Finish what you are working on and sign in again.`
          : "Your session is ending. Finish what you are working on and sign in again."}
      </span>
    </div>
  );
}
