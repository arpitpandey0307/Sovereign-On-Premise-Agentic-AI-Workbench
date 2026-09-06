import { LayoutGrid, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { SovereigntyBadge } from "@/components/shell/SovereigntyBadge";

export function Header({ title }: { title?: string }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="topbar">
      <div className="title truncate">{title ?? ""}</div>
      <div className="spacer" />

      <SovereigntyBadge />

      {/* The way back to the selector once a workspace is remembered. */}
      <button
        type="button"
        className="icon-btn"
        onClick={() => navigate("/workspaces?choose=1")}
        aria-label="Switch workspace"
        title="Switch workspace"
      >
        <LayoutGrid className="size-4" aria-hidden />
      </button>

      <div className="divider" />

      <button
        type="button"
        className="icon-btn"
        onClick={async () => {
          await signOut();
          navigate("/login", { replace: true });
        }}
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="size-4" aria-hidden />
      </button>
    </header>
  );
}
