import { Link } from "react-router-dom";
import { Info, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/**
 * Account request.
 *
 * The backend has no registration endpoint -- accounts are provisioned by an
 * administrator. The form is built so it is ready the day POST /auth/register
 * exists, but it does not pretend to work: a sign-up that appears to succeed
 * and creates nothing is the worst of the available options, especially in a
 * product whose entire argument is about being trustworthy.
 */
export function Signup() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-base p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded bg-accent-soft">
            <Lock className="size-4 text-accent" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">SOVEREIGN AI</p>
            <p className="text-[10px] text-tertiary">Industrial Intelligence</p>
          </div>
        </div>

        <h1 className="text-xl font-semibold tracking-tight">Request access</h1>

        <p
          role="status"
          className="mt-4 flex items-start gap-2 rounded-[var(--radius)] border border-info/30 bg-info-soft px-3 py-2 text-xs text-info"
        >
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            Accounts on this deployment are provisioned by an administrator,
            who also assigns your role and clearance. Self-registration is
            disabled by design &mdash; this form is not yet connected.
          </span>
        </p>

        <fieldset disabled className="mt-6 space-y-4 opacity-60">
          <Input label="Full name" name="name" placeholder="Arpit Pandey" />
          <Input
            label="Corporate ID"
            name="email"
            type="email"
            placeholder="you@organisation.local"
          />
          <Input
            label="Department"
            name="department"
            placeholder="Engineering"
          />
          <Input
            label="Reason for access"
            name="reason"
            placeholder="Inspection review and reporting"
          />
          <Button type="button" className="w-full">
            Submit request
          </Button>
        </fieldset>

        <p className="mt-6 text-center text-[11px] text-tertiary">
          Already have an account?{" "}
          <Link to="/login" className="text-accent-text hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
