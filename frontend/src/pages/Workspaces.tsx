import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ClipboardList,
  Cpu,
  HardHat,
  Lock,
  Microscope,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { roleLabel, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import {
  admits,
  WORKSPACES,
  workspaceById,
  workspaceIntent,
  workspacesFor,
  type Workspace,
} from "@/lib/access";

/**
 * "Who are you signing in as?" — the first screen after the landing page.
 *
 * It runs *before* sign-in, which is the point: someone states which role they
 * hold, and the credentials they then present either bear that out or do not.
 * Stating it is not a grant. Nothing here is checked here; the roles that come
 * back from the server decide, and the server re-checks every request after.
 *
 * So the cards are not disabled before sign-in. Disabling them would leak the
 * shape of the organisation to an anonymous visitor, and would also be a lie:
 * this page genuinely does not know who is looking at it yet.
 *
 * After sign-in the same screen has a different job — it shows the identities
 * this account actually holds, and it is where a refused claim lands with the
 * reason.
 */

const ICONS: Record<string, typeof HardHat> = {
  engineer: HardHat,
  analyst: Microscope,
  manager: ClipboardList,
  security: ShieldCheck,
  admin: Cpu,
};

export function Workspaces() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [params] = useSearchParams();

  const denied = workspaceById(params.get("denied"));

  // Nothing is decided until the stored session has been checked, or the page
  // paints its anonymous half and then rearranges itself.
  if (loading) return null;

  const signedIn = Boolean(user);
  const held = user?.roles ?? [];
  const offered = signedIn ? workspacesFor(held) : WORKSPACES;

  // A signed-in person with one identity and no refusal to explain is not
  // making a choice; they are reading a page with one button on it.
  if (signedIn && !denied && offered.length === 1 && params.get("choose") !== "1") {
    return <Navigate to={offered[0].home} replace />;
  }

  const choose = (workspace: Workspace) => {
    workspaceIntent.set(workspace.id);
    if (!signedIn) {
      // Sign in *as* this. The credentials settle whether it holds.
      navigate(`/login?workspace=${workspace.id}`);
      return;
    }
    workspaceIntent.clear();
    navigate(workspace.home, { replace: true });
  };

  return (
    <div className="choose-wrap">
      {/* Depth without noise: two slow, heavily blurred washes of the accent
          behind the content. It reads as a lit room rather than as decoration,
          and it costs nothing to render. */}
      <div className="choose-aurora" aria-hidden>
        <span className="a1" />
        <span className="a2" />
      </div>

      <div className="choose-inner">
        <motion.header
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-2 flex items-center gap-2.5"
        >
          <div className="grid size-8 place-items-center rounded bg-accent-soft">
            <Lock className="size-4 text-accent" aria-hidden />
          </div>
          <p className="text-sm font-semibold tracking-tight">SOVEREIGN AI</p>
        </motion.header>

        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.05 }}
          className="choose-title"
        >
          {signedIn ? "Continue as" : "Who are you signing in as?"}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.45, delay: 0.12 }}
          className="mt-2 text-sm text-secondary"
        >
          {signedIn
            ? "These are the roles this account holds."
            : "Say which role you hold. You will sign in next, and your credentials decide whether it stands."}
        </motion.p>

        {denied && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-5 flex items-start gap-2.5 rounded-[var(--radius)] px-3.5 py-2.5"
            style={{
              background: "var(--danger-bg)",
              border: "1px solid var(--danger-line)",
              color: "var(--danger-text)",
            }}
          >
            <ShieldX className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="text-[12.5px]">
              This account does not hold{" "}
              <span className="font-semibold">{denied.name}</span>. You are
              signed in as {roleLabel(held)}. What it does hold is below.
            </span>
          </motion.div>
        )}

        {signedIn && (
          <div className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius)] border border-subtle bg-panel px-3 py-1.5">
            <ShieldCheck className="size-3.5 text-accent" aria-hidden />
            <span className="text-xs text-secondary">
              Signed in as{" "}
              <span className="font-medium text-primary">{user?.name}</span>
            </span>
          </div>
        )}

        <div className="choose-grid">
          {offered.map((workspace, index) => (
            <RoleCard
              key={workspace.id}
              workspace={workspace}
              index={index}
              held={signedIn ? held : null}
              onChoose={() => choose(workspace)}
            />
          ))}
        </div>

        <p className="mt-8 max-w-2xl text-[11px] text-tertiary">
          Saying which role you hold decides what this application shows you. It
          does not decide what you are permitted to reach &mdash; permissions are
          assigned by your administrator and enforced by the server on every
          request.
        </p>

        <div className="mt-6 flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
            Back
          </Button>
          {!signedIn && (
            <Link
              to="/login"
              className="text-[12px]"
              style={{ color: "var(--text-mute)" }}
            >
              Or sign in and let your credentials decide
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function RoleCard({
  workspace,
  index,
  held,
  onChoose,
}: {
  workspace: Workspace;
  index: number;
  /** The roles the account holds, once known. Null before sign-in. */
  held: readonly string[] | null;
  onChoose: () => void;
}) {
  const Icon = ICONS[workspace.id] ?? HardHat;
  const confirmed = held !== null && admits(workspace, held as never);

  return (
    <motion.button
      type="button"
      onClick={onChoose}
      aria-label={`Sign in as ${workspace.name}`}
      className="role-card"
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.14 + index * 0.06 }}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.99 }}
    >
      <span className="role-card-sheen" aria-hidden />

      <div className="flex items-start justify-between">
        <div className="role-card-icon">
          <Icon className="size-[18px]" aria-hidden />
        </div>
        {confirmed && (
          <span className="pill ok" style={{ fontSize: "10px" }}>
            held
          </span>
        )}
      </div>

      <p className="role-card-name">{workspace.name}</p>

      <ul className="mt-2 space-y-1">
        {workspace.blurb.map((line) => (
          <li key={line} className="text-[11.5px] text-tertiary">
            {line}
          </li>
        ))}
      </ul>

      <span className="role-card-go">
        Continue
        <ArrowRight className="size-3.5" aria-hidden />
      </span>
    </motion.button>
  );
}
