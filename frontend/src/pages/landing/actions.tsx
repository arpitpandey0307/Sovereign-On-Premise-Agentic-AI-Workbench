/**
 * The two real actions on the landing page.
 *
 * "Enter Workbench" goes to the workspace chooser, signed in or not. Someone
 * arriving from the marketing page is telling you what they came to do, not
 * who they are -- so the product asks which part of the plant they work in
 * first, and settles the identity claim at sign-in immediately afterwards.
 * A visitor with a live session lands on the same screen and simply sees the
 * workspaces they already hold.
 */

import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Where "Enter Workbench" goes.
 *
 * The chooser, always. It is the one screen that works the same whether or not
 * there is a session, which is what lets this be a single answer rather than a
 * guess made while the stored token is still being checked.
 */
export function useWorkbenchDestination(): string {
  return "/workspaces";
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
