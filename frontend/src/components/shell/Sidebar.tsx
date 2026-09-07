import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Boxes,
  ClipboardCheck,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Library,
  ListChecks,
  PanelLeft,
  Settings,
  Shield,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { roleLabel, useAuth, useRole } from "@/lib/auth";
import { canOpen, workspaceRole } from "@/lib/access";
import { ChatHistory } from "@/components/shell/ChatHistory";
import { loadProfile, type Profile } from "@/lib/profile";

/**
 * The navigation.
 *
 * What is shown comes from the one access table in `lib/access`, the same one
 * the router enforces. Two lists that had to be kept in agreement is how a
 * sidebar ends up hiding a link the router still serves.
 */
type Item = {
  to: string;
  label: string;
  Icon: typeof LayoutDashboard;
};

const PRIMARY: Item[] = [
  { to: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { to: "/workbench", label: "AI Workbench", Icon: FlaskConical },
  { to: "/coding", label: "Coding Workspace", Icon: Terminal },
  { to: "/documents", label: "My Documents", Icon: FileText },
  { to: "/knowledge", label: "Knowledge Base", Icon: Library },
  { to: "/tasks", label: "Tasks", Icon: ListChecks },
  { to: "/approvals", label: "Approval Requests", Icon: ClipboardCheck },
  { to: "/artifacts", label: "Artifacts", Icon: Boxes },
  { to: "/models", label: "Models", Icon: Boxes },
];

const SECONDARY: Item[] = [
  { to: "/security", label: "Security Center", Icon: Shield },
  { to: "/settings", label: "Settings", Icon: Settings },
];

export function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { user } = useAuth();
  const { roles } = useRole();
  const location = useLocation();
  const role = workspaceRole(roles);

  // Personal settings live in this browser and are edited on another screen,
  // so the sidebar listens rather than reading once.
  const [profile, setProfile] = useState<Profile>(() => loadProfile(user?.id));
  useEffect(() => {
    const reload = () => setProfile(loadProfile(user?.id));
    reload();
    window.addEventListener("sovereign:profile", reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener("sovereign:profile", reload);
      window.removeEventListener("storage", reload);
    };
  }, [user?.id]);

  // Which surface's history this is, if any.
  const historyKind = location.pathname.startsWith("/coding")
    ? ("coding" as const)
    : location.pathname.startsWith("/workbench")
      ? ("ai" as const)
      : null;

  // Items this workspace role cannot reach are hidden -- with one exception
  // below. The same predicate the router uses, so the two cannot drift.
  const visible = (items: Item[]) =>
    items.filter((item) => canOpen(role, item.to));

  return (
    <aside className={cn("sidebar", collapsed && "collapsed")}>
      <div className="sidebar-brand">
        <div className="logo" />
        <div className="brand-text">
          <div className="name">SOVEREIGN AI</div>
          <div className="sub">SECURE WORKBENCH</div>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <PanelLeft className="size-4" aria-hidden />
        </button>
      </div>

      <nav className="nav" aria-label="Main">
        {!collapsed && <div className="nav-group-label">Workspace</div>}
        {visible(PRIMARY).map((item) => (
          <Link key={item.to} item={item} collapsed={collapsed} />
        ))}

        {!collapsed && visible(SECONDARY).length > 0 && (
          <div className="nav-group-label">Oversight</div>
        )}
        {/* Nothing a role cannot enter appears at all. An earlier version kept
            the Security Center visible-but-locked, on the argument that knowing
            the system has oversight is part of what the product claims. In a
            plant that reads as a door you are being shown and refused, which is
            worse than not being shown it: the sovereignty badge in the header
            already tells everyone the oversight exists. */}
        {visible(SECONDARY).map((item) => (
          <Link key={item.to} item={item} collapsed={collapsed} />
        ))}
      </nav>

      {/* History belongs to the surface that produced it, and appears only
          while you are standing in that surface: the AI workbench lists its own
          sessions, the coding workspace lists its own. Elsewhere the panel is
          absent rather than empty -- an empty list reads as broken rather than
          as the boundary doing its job. */}
      {historyKind && canOpen(role, location.pathname) ? (
        <ChatHistory kind={historyKind} collapsed={collapsed} />
      ) : (
        <div className="sidebar-scroll" />
      )}

      <NavLink
        to="/profile"
        className="sidebar-user"
        style={({ isActive }) =>
          isActive ? { background: "var(--panel-2)" } : undefined
        }
      >
        <div className="avatar">
          {profile.avatar ? (
            <img src={profile.avatar} alt="" />
          ) : (
            (profile.displayName || user?.name || "?").slice(0, 1).toUpperCase()
          )}
        </div>
        {!collapsed && (
          <div className="meta">
            <div className="u-name">
              {profile.displayName || user?.name || "Signed out"}
            </div>
            <div className="u-role">{roleLabel(user?.roles ?? [])}</div>
          </div>
        )}
      </NavLink>
    </aside>
  );
}

function Link({ item, collapsed }: { item: Item; collapsed: boolean }) {
  const { Icon, to, label } = item;
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) => cn("nav-item", isActive && "active")}
    >
      <span className="ico">
        <Icon className="size-4" aria-hidden />
      </span>
      {!collapsed && <span className="label">{label}</span>}
    </NavLink>
  );
}
