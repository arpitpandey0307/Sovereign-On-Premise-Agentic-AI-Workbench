import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { ROLE_LABEL, WORKSPACES, type WorkspaceRole } from "@/lib/access";

/**
 * A screen this role does not hold.
 *
 * It refuses and explains, rather than redirecting. A silent bounce to the
 * dashboard makes a governed system feel broken — the person cannot tell
 * whether the screen is missing, failing, or forbidden, and the one thing the
 * product is arguing is that it can say no clearly and mean it.
 *
 * It also names what they *do* hold, because the useful next action is
 * somewhere else, not this URL again.
 */
export function NoAccess({
  role,
  pathname,
  home,
}: {
  role: WorkspaceRole;
  pathname: string;
  home: string;
}) {
  // Named by rank rather than by the account's own roles: this is rendered
  // inside the shell, where the rank is what the navigation is built from.
  const mine = WORKSPACES.filter((workspace) => workspace.role === role);

  return (
    <div className="view-pad">
      <div className="empty-state" style={{ textAlign: "left", maxWidth: "560px" }}>
        <div className="flex items-start gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded bg-accent-soft">
            <Lock className="size-4 text-accent" aria-hidden />
          </div>
          <div>
            <p className="text-sm font-semibold text-primary">
              This area is not part of your workspace
            </p>
            <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--text-dim)" }}>
              <span className="mono">{pathname}</span> belongs to a different
              role. You are working as{" "}
              <span className="font-semibold">{ROLE_LABEL[role]}</span>, and the
              server would refuse these requests regardless of what this
              interface showed you.
            </p>

            <p className="mt-4 field-label" style={{ margin: "16px 0 6px" }}>
              Your workspaces
            </p>
            <ul className="space-y-1">
              {mine.map((workspace) => (
                <li key={workspace.id}>
                  <Link
                    to={workspace.home}
                    className="text-[13px]"
                    style={{ color: "var(--accent-bright)" }}
                  >
                    {workspace.name}
                  </Link>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex items-center gap-3">
              <Link to={home} className="btn btn-sm btn-accent">
                Go to my workspace
              </Link>
              <Link
                to="/workspaces?choose=1"
                className="text-[12px]"
                style={{ color: "var(--text-mute)" }}
              >
                Choose another
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
