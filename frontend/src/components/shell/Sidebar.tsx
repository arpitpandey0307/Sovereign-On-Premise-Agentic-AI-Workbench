import { NavLink } from "react-router-dom";
import {
  Boxes,
  ClipboardCheck,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Library,
  ListChecks,
  Lock,
  PanelLeft,
  Settings,
  Shield,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { roleLabel, useAuth, useRole } from "@/lib/auth";
import { canOpen, workspaceRole } from "@/lib/access";
import { ChatHistory } from "@/components/shell/ChatHistory";

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
  const role = workspaceRole(roles);

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

        {!collapsed && <div className="nav-group-label">Oversight</div>}
        {SECONDARY.map((item) => {
          const permitted = canOpen(role, item.to);
          // Security Center stays visible but locked for roles that cannot
          // enter it. Knowing the system *has* oversight is part of what the
          // product is arguing, so hiding it entirely would understate it.
          if (!permitted && item.to !== "/security") return null;
          return permitted ? (
            <Link key={item.to} item={item} collapsed={collapsed} />
          ) : (
            <LockedLink key={item.to} item={item} collapsed={collapsed} />
          );
        })}
      </nav>

      {/* Conversations belong to roles that hold the workbench. For the rest
          the panel is absent, not empty -- an empty history reads as broken
          rather than as the boundary doing its job. */}
      {canOpen(role, "/workbench") ? (
        <ChatHistory collapsed={collapsed} />
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
          {(user?.name ?? "?").slice(0, 1).toUpperCase()}
        </div>
        {!collapsed && (
          <div className="meta">
            <div className="u-name">{user?.name ?? "Signed out"}</div>
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

function LockedLink({ item, collapsed }: { item: Item; collapsed: boolean }) {
  const { Icon, label } = item;
  return (
    <div
      className="nav-item locked"
      title={`${label} — requires an administrator or security role`}
      aria-disabled
    >
      <span className="ico">
        <Icon className="size-4" aria-hidden />
      </span>
      {!collapsed && (
        <>
          <span className="label">{label}</span>
          <Lock className="size-3" aria-hidden />
        </>
      )}
    </div>
  );
}
