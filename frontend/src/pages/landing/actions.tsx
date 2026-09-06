/**
 * The two real actions on the landing page.
 *
 * "Enter Workbench" is the only piece of genuine logic here, and it is worth
 * getting right: someone with a live session who is sent back to a login form
 * concludes the session was not real. While the stored session is still being
 * checked the button stays enabled and routes to the app -- `RequireAuth`
 * makes the same decision a moment later with a better answer, and blocking
 * the primary call to action on a network round trip is worse than a redirect
 * the user never notices.
 */

import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/auth";

/** Where "Enter Workbench" should go, given the session. */
export function useWorkbenchDestination(): string {
  const { user, loading } = useAuth();
  if (user) return "/dashboard";
  return loading ? "/dashboard" : "/login";
}

export function EnterWorkbenchButton({
  size = "md",
  children = "Enter Workbench",
  className,
}: {
  size?: "sm" | "md" | "lg";
  children?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const to = useWorkbenchDestination();

  return (
    <Button size={size} className={className} onClick={() => navigate(to)}>
      {children}
      <ArrowRight className="size-4" aria-hidden />
    </Button>
  );
}

export function SignInLink() {
  return (
    <Link
      to="/login"
      className="inline-flex h-8 items-center rounded-[var(--radius)] px-3 text-[13px] text-secondary transition-colors hover:bg-elevated hover:text-primary"
    >
      Sign In
    </Link>
  );
}
