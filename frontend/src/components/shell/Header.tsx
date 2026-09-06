import { LogOut, Moon, Sun } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/lib/theme";
import { SovereigntyBadge } from "@/components/shell/SovereigntyBadge";

export function Header({ title }: { title?: string }) {
  const { signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-subtle bg-panel px-5">
      <h1 className="truncate text-sm font-semibold text-primary">
        {title ?? ""}
      </h1>

      <div className="flex items-center gap-2">
        <SovereigntyBadge />

        <button
          type="button"
          onClick={toggle}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className="grid size-8 place-items-center rounded-[var(--radius)] text-tertiary transition-colors hover:bg-elevated hover:text-secondary"
        >
          {theme === "dark" ? (
            <Sun className="size-4" aria-hidden />
          ) : (
            <Moon className="size-4" aria-hidden />
          )}
        </button>

        <button
          type="button"
          onClick={async () => {
            await signOut();
            navigate("/login", { replace: true });
          }}
          aria-label="Sign out"
          className="grid size-8 place-items-center rounded-[var(--radius)] text-tertiary transition-colors hover:bg-elevated hover:text-secondary"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </header>
  );
}
