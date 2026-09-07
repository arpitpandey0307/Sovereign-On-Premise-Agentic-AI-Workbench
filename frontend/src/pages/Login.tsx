import { useState, type FormEvent } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { describeError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Input } from "@/components/ui/Input";
import {
  homeFor,
  workspaceById,
  workspaceIntent,
  workspaceRole,
} from "@/lib/access";

/**
 * Sign in.
 *
 * Reached from the workspace chooser, which passes the workspace someone said
 * they work in. That claim is settled here and nowhere earlier: the credentials
 * come back with a role, and the role either admits them to that workspace or
 * it does not. A refusal goes back to the chooser with the reason, rather than
 * dropping them somewhere they did not ask for with no explanation.
 */
export function Login() {
  const { signIn, user, loading, endedReason, clearEndedReason } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The query parameter is the live intent; the stored one survives a reload
  // of this page.
  const wanted = workspaceById(params.get("workspace") ?? workspaceIntent.get());

  // A session that already exists -- restored on load, or established by the
  // submit below, which sets it before that handler's own navigate runs. This
  // has to make the same workspace decision, or arriving here with a live
  // session would silently drop the workspace that was asked for.
  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from;
    if (from) return <Navigate to={from} replace />;

    const role = workspaceRole(user.roles);
    if (!wanted) return <Navigate to={homeFor(role)} replace />;
    return (
      <Navigate
        to={wanted.roles.includes(role) ? wanted.home : `/workspaces?denied=${wanted.id}`}
        replace
      />
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    clearEndedReason();
    try {
      const identity = await signIn(email.trim(), password);
      const role = workspaceRole(identity.roles);
      workspaceIntent.clear();

      // No workspace was asked for: the role decides where to land.
      if (!wanted) {
        navigate(homeFor(role), { replace: true });
        return;
      }

      navigate(
        wanted.roles.includes(role)
          ? wanted.home
          : `/workspaces?denied=${wanted.id}`,
        { replace: true },
      );
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

        {wanted && (
          <p
            className="text-[12px]"
            style={{ color: "var(--text-mute)", marginBottom: "14px" }}
          >
            Signing in to{" "}
            <span className="font-semibold" style={{ color: "var(--text)" }}>
              {wanted.name}
            </span>
            . Your role decides whether you are admitted.
          </p>
        )}

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
