import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import {
  ClipboardList,
  Cpu,
  HardHat,
  Lock,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { roleLabel, useAuth, useRole } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import {
  ROLE_LABEL,
  WORKSPACES,
  workspaceById,
  workspaceIntent,
  workspaceRole,
  workspacesFor,
  type Workspace,
} from "@/lib/access";

/**
 * The workspace chooser — the first screen after the landing page.
 *
 * It runs *before* sign-in, which is the point: someone says which part of the
 * plant they work in, and the credentials they then present either bear that
 * out or do not. Choosing is a statement of intent, never a grant. Nothing here
 * is a permission and nothing here is checked here; the role that comes back
 * from the server decides, and the server re-checks every request afterwards.
 *
 * So the cards are not disabled before sign-in. Disabling them would leak the
 * shape of the organisation to an anonymous visitor, and would also be a lie:
 * this page genuinely does not know who is looking at it yet.
 *
 * After sign-in the same screen has a different job — it shows what this person
 * actually holds, and it is where a refused choice lands with the reason.
 */

const ICONS: Record<string, typeof HardHat> = {
  engineering: HardHat,
  management: ClipboardList,
  security: ShieldCheck,
  administration: Cpu,
};

export function Workspaces() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const { roles } = useRole();
  const [params] = useSearchParams();

  const denied = workspaceById(params.get("denied"));

  // Nothing is decided until the stored session has been checked, or the page
  // paints its anonymous half and then rearranges itself.
  if (loading) return null;

  const signedIn = Boolean(user);
  const role = workspaceRole(roles);
  const permitted = signedIn ? workspacesFor(role) : WORKSPACES;

  // A signed-in person with exactly one workspace and no refusal to explain is
  // not making a choice; they are reading a page with one button on it.
  if (signedIn && !denied && permitted.length === 1 && params.get("choose") !== "1") {
    return <Navigate to={permitted[0].home} replace />;
  }

  const choose = (workspace: Workspace) => {
    workspaceIntent.set(workspace.id);
    if (!signedIn) {
      // Sign in *to* this workspace. The credentials settle whether it holds.
      navigate(`/login?workspace=${workspace.id}`);
      return;
    }
    workspaceIntent.clear();
    navigate(workspace.home, { replace: true });
  };

  return (
    <div className="min-h-screen bg-canvas px-6 py-16">
      <div className="mx-auto max-w-4xl">
        <header className="mb-2 flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded bg-accent-soft">
            <Lock className="size-4 text-accent" aria-hidden />
          </div>
          <p className="text-sm font-semibold tracking-tight">SOVEREIGN AI</p>
        </header>

        <h1 className="mt-8 text-2xl font-semibold tracking-tight">
          Choose your workspace
        </h1>
        <p className="mt-1.5 text-sm text-secondary">
          {signedIn
            ? "These are the workspaces your role admits you to."
            : "Pick where you work. You will sign in next, and your credentials decide whether you are admitted."}
        </p>

        {denied && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-2.5 rounded-[var(--radius)] px-3.5 py-2.5"
            style={{
              background: "var(--danger-bg)",
              border: "1px solid var(--danger-line)",
              color: "var(--danger-text)",
            }}
          >
            <ShieldX className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="text-[12.5px]">
              Your account is not admitted to{" "}
              <span className="font-semibold">{denied.name}</span>. You are
              signed in as {roleLabel(roles)} — {ROLE_LABEL[role]}. What you can
              enter is below.
            </span>
          </div>
        )}

        {signedIn && (
          <div className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius)] border border-subtle bg-panel px-3 py-1.5">
            <ShieldCheck className="size-3.5 text-accent" aria-hidden />
            <span className="text-xs text-secondary">
              Signed in as{" "}
              <span className="font-medium text-primary">{user?.name}</span>{" "}
              &mdash; {roleLabel(roles)}
            </span>
          </div>
        )}

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {permitted.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              onChoose={() => choose(workspace)}
            />
          ))}
        </div>

        <p className="mt-8 text-[11px] text-tertiary">
          Choosing a workspace decides what this application shows you. It does
          not decide what you are permitted to reach &mdash; permissions are
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
              Or sign in and let your role decide
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspaceCard({
  workspace,
  onChoose,
}: {
  workspace: Workspace;
  onChoose: () => void;
}) {
  const Icon = ICONS[workspace.id] ?? HardHat;

  return (
    <button
      type="button"
      onClick={onChoose}
      aria-label={`Enter the ${workspace.name} workspace`}
      className={cn(
        "group rounded-[var(--radius)] border p-4 text-left transition-colors",
        "border-subtle bg-panel hover:border-accent/50 hover:bg-elevated",
      )}
    >
      <div className="grid size-8 place-items-center rounded bg-accent-soft">
        <Icon className="size-4 text-accent" aria-hidden />
      </div>

      <p className="mt-3 text-sm font-medium text-primary">{workspace.name}</p>

      <ul className="mt-1.5 space-y-0.5">
        {workspace.blurb.map((line) => (
          <li key={line} className="text-[11px] text-tertiary">
            {line}
          </li>
        ))}
      </ul>

      <p className="mt-3 border-t border-subtle pt-2 text-[10px] text-tertiary">
        For {workspace.roles.map((role) => ROLE_LABEL[role]).join(", ")}
      </p>
    </button>
  );
}
