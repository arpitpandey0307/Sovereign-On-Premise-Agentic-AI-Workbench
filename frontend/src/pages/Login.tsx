import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Info, Lock, ShieldCheck } from "lucide-react";
import { describeError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export function Login() {
  const { signIn, user, loading, endedReason, clearEndedReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) {
    const to =
      (location.state as { from?: string } | null)?.from ?? "/workspaces";
    return <Navigate to={to} replace />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    clearEndedReason();
    try {
      await signIn(email.trim(), password);
      navigate("/workspaces", { replace: true });
    } catch (caught) {
      // Deliberately not saying which half was wrong. The backend already
      // answers identically for an unknown account and a bad password, and
      // throttles repeated attempts -- the UI must not undo that by being
      // helpful. The throttle message is worth passing through, though.
      const { title, detail } = describeError(caught);
      setError(title === "Too many attempts" ? detail : "Those credentials were not accepted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen bg-base lg:grid-cols-2">
      {/* Left: what kind of place this is. */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-subtle bg-panel p-12 lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(var(--accent) 1px, transparent 1px), linear-gradient(90deg, var(--accent) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
          aria-hidden
        />

        <div className="relative flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded bg-accent-soft">
            <Lock className="size-4 text-accent" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">SOVEREIGN AI</p>
            <p className="text-[10px] text-tertiary">Industrial Intelligence</p>
          </div>
        </div>

        <div className="relative max-w-md space-y-8">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Secure access to your organization&rsquo;s AI environment.
          </h2>
          <div className="flex gap-8">
            {["LOCAL", "PRIVATE", "CONTROLLED"].map((word) => (
              <div key={word}>
                <p className="mono text-xs font-semibold tracking-widest text-accent-text">
                  {word}
                </p>
              </div>
            ))}
          </div>
          <p className="text-sm leading-relaxed text-secondary">
            Your organization controls the models, data, tools and network
            access used in this workspace.
          </p>
        </div>

        <p className="relative text-[11px] text-tertiary">
          Sovereign AI &mdash; Private Industrial Intelligence
        </p>
      </div>

      {/* Right: the form. */}
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <p className="text-sm font-semibold tracking-tight">SOVEREIGN AI</p>
            <p className="text-[10px] text-tertiary">Industrial Intelligence</p>
          </div>

          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-xs text-tertiary">
            On-premise authentication. No external identity provider is
            contacted.
          </p>

          {endedReason && (
            <p
              role="status"
              className="mt-4 flex items-start gap-2 rounded-[var(--radius)] border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning"
            >
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              {endedReason}
            </p>
          )}

          <form onSubmit={submit} className="mt-6 space-y-4">
            <Input
              label="Corporate ID"
              name="email"
              type="email"
              autoComplete="username"
              required
              placeholder="you@organisation.local"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            <label className="flex items-center gap-2 text-xs text-secondary">
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--accent)]"
                name="remember"
              />
              Remember this workstation
            </label>

            {error && (
              <p
                role="alert"
                className="rounded-[var(--radius)] border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" loading={busy}>
              Sign In
            </Button>

            {/* There is no SSO behind this. A live-looking button that does
                nothing is worse than one that says why. */}
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled
              title="Enterprise SSO is configured per deployment and is not enabled here."
            >
              Use Enterprise SSO
            </Button>
          </form>

          <div className="mt-6 space-y-1.5 border-t border-subtle pt-4">
            <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
              <ShieldCheck className="size-3 text-positive" aria-hidden />
              On-Premise Authentication
            </p>
            <p className="mono text-[11px] text-tertiary">
              Network: Internal Only
            </p>
          </div>

          <p className="mt-6 text-center text-[11px] text-tertiary">
            Need an account?{" "}
            <Link to="/signup" className="text-accent-text hover:underline">
              Request access
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
