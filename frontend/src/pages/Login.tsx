import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { describeError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
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
      setError(
        title === "Too many attempts"
          ? detail
          : "Those credentials were not accepted.",
      );
    } finally {
      setBusy(false);
    }
  }

  const invalid = error === "Those credentials were not accepted.";

  return (
    <div className="login-wrap">
      <div className="login-org">
        On-premise deployment
        <br />
        Internal network only
      </div>

      <div className="login-card">
        <div className="login-mark">
          <div className="word">SOVEREIGN&nbsp;AI</div>
          <div className="tag">Private Industrial Intelligence</div>
        </div>

        {endedReason && (
          <div className="login-error" role="status">
            <span className="x">i</span>
            {endedReason}
          </div>
        )}

        <form onSubmit={submit} className="login-form">
          <Input
            label="Corporate ID"
            name="email"
            type="email"
            autoComplete="username"
            required
            placeholder="you@organisation.local"
            className={invalid ? "err" : undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={invalid ? "err" : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error && (
            <div className="login-error" role="alert">
              <span className="x">!</span>
              {error}
            </div>
          )}

          <button type="submit" className="login-submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <div className="login-foot">
          On-premise authentication · No external identity provider
        </div>

        <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          Need an account?{" "}
          <Link to="/signup" style={{ color: "var(--accent-bright)" }}>
            Request access
          </Link>
        </p>
      </div>
    </div>
  );
}
