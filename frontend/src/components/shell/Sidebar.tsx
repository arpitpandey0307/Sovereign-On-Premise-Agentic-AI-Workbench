import { NavLink } from "react-router-dom";
import {
  Boxes,
  ChevronLeft,
  FileText,
  FlaskConical,
  LayoutDashboard,
  Library,
  ListChecks,
  Lock,
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
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-subtle bg-panel transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center gap-2 border-b border-subtle px-4",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="grid size-7 shrink-0 place-items-center rounded bg-accent-soft">
          <Lock className="size-3.5 text-accent" aria-hidden />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold tracking-tight text-primary">
              SOVEREIGN AI
            </p>
            <p className="truncate text-[10px] text-tertiary">
              Industrial Intelligence
            </p>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto p-2" aria-label="Main">
        <ul className="space-y-0.5">
          {visible(PRIMARY).map((item) => (
            <li key={item.to}>
              <Link item={item} collapsed={collapsed} />
            </li>
          ))}
        </ul>

        <div className="my-3 border-t border-subtle" />

        <ul className="space-y-0.5">
          {SECONDARY.map((item) => {
            const permitted = !item.needs || can(item.needs[0], item.needs[1]);
            // Security Center stays visible but locked for roles that cannot
            // enter it. Knowing the system *has* oversight is part of what the
            // product is arguing, so hiding it entirely would understate it.
            if (!permitted && item.to !== "/security") return null;
            return (
              <li key={item.to}>
                {permitted ? (
                  <Link item={item} collapsed={collapsed} />
                ) : (
                  <LockedLink item={item} collapsed={collapsed} />
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-subtle p-2">
        <NavLink
          to="/profile"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-[var(--radius)] p-2 transition-colors",
              isActive ? "bg-elevated" : "hover:bg-elevated",
              collapsed && "justify-center",
            )
          }
        >
          <div className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-text">
            {(user?.name ?? "?").slice(0, 1).toUpperCase()}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-primary">
                {user?.name ?? "Signed out"}
              </p>
              <p className="truncate text-[10px] text-tertiary">
                {roleLabel(user?.roles ?? [])}
              </p>
            </div>
          )}
        </NavLink>

        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="mt-1 flex w-full items-center justify-center rounded p-1.5 text-tertiary transition-colors hover:bg-elevated hover:text-secondary"
        >
          <ChevronLeft
            className={cn("size-4 transition-transform", collapsed && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>
    </aside>
  );
}

function Link({ item, collapsed }: { item: Item; collapsed: boolean }) {
  const { Icon, to, label } = item;
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-[13px] transition-colors",
          isActive
            ? "bg-accent-soft font-medium text-accent-text"
            : "text-secondary hover:bg-elevated hover:text-primary",
          collapsed && "justify-center px-0",
        )
      }
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
}

function LockedLink({ item, collapsed }: { item: Item; collapsed: boolean }) {
  const { Icon, label } = item;
  return (
    <div
      title={`${label} — requires an administrator or security role`}
      aria-disabled
      className={cn(
        "flex cursor-not-allowed items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-2 text-[13px] text-tertiary/60",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {!collapsed && (
        <>
          <span className="truncate">{label}</span>
          <Lock className="ml-auto size-3" aria-hidden />
        </>
      )}
    </div>
  );
}
