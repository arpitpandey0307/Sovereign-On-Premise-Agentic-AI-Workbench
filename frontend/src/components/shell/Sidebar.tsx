import { NavLink } from "react-router-dom";
import {
  Boxes,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Library,
  ListChecks,
  Lock,
  PanelLeft,
  Settings,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { roleLabel, useAuth, useRole } from "@/lib/auth";

type Item = {
  to: string;
  label: string;
  Icon: typeof LayoutDashboard;
  /** Permission required to reach it, checked against the policy engine. */
  needs?: [resource: string, action: string];
};

const PRIMARY: Item[] = [
  { to: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { to: "/workbench", label: "AI Workbench", Icon: FlaskConical, needs: ["task", "create"] },
  { to: "/documents", label: "Documents", Icon: FileText, needs: ["document", "read"] },
  { to: "/knowledge", label: "Knowledge Base", Icon: Library, needs: ["document", "search"] },
  { to: "/tasks", label: "Tasks", Icon: ListChecks, needs: ["task", "read"] },
  { to: "/artifacts", label: "Artifacts", Icon: Boxes, needs: ["artifact", "download"] },
  { to: "/models", label: "Models", Icon: Boxes, needs: ["model", "read"] },
];

const SECONDARY: Item[] = [
  { to: "/security", label: "Security Center", Icon: Shield, needs: ["security", "read"] },
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
  const { can } = useRole();

  // Items the role cannot reach are hidden -- with one exception below.
  const visible = (items: Item[]) =>
    items.filter((item) => !item.needs || can(item.needs[0], item.needs[1]));

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
          const permitted = !item.needs || can(item.needs[0], item.needs[1]);
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

      <div className="sidebar-scroll" />

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
