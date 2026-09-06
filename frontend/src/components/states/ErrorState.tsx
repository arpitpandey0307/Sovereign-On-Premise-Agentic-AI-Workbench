import { AlertCircle, Lock, SearchX, ServerCrash, WifiOff } from "lucide-react";
import { ApiError, describeError } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/states/EmptyState";

function iconFor(error: unknown) {
  if (!(error instanceof ApiError)) return <AlertCircle />;
  switch (error.code) {
    case "permission_denied":
    case "unauthenticated":
      return <Lock />;
    case "not_found":
      return <SearchX />;
    case "network_error":
      return <WifiOff />;
    case "internal_error":
      return <ServerCrash />;
    default:
      return <AlertCircle />;
  }
}

/**
 * A failure the user can act on.
 *
 * A denial in particular is information, not an accident: it says the system
 * is governed. It reads better as a stated boundary than as a crash.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const { title, detail } = describeError(error);
  const denied =
    error instanceof ApiError && error.code === "permission_denied";

  return (
    <EmptyState
      icon={iconFor(error)}
      title={title}
      description={detail}
      action={
        onRetry && !denied ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
