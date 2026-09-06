import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Suspense, lazy, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { LoadingState } from "@/components/states/LoadingState";
import { Login } from "@/pages/Login";
import { Signup } from "@/pages/Signup";

// Three bundles, not one. A visitor who never signs in should not download the
// workbench, and someone working in the workbench should not be carrying the
// landing page's animation code around with them. Login and Signup stay in the
// entry chunk deliberately: they are small, and one of them is where almost
// every visitor goes next.
const Landing = lazy(() => import("@/pages/landing/Landing"));
const AppShell = lazy(() =>
  import("@/components/shell/AppShell").then((m) => ({ default: m.AppShell })),
);
const Workspaces = lazy(() =>
  import("@/pages/Workspaces").then((m) => ({ default: m.Workspaces })),
);
const Dashboard = lazy(() =>
  import("@/pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const Placeholder = lazy(() =>
  import("@/pages/Placeholder").then((m) => ({ default: m.Placeholder })),
);

/** Held while a route chunk arrives. */
function RouteFallback() {
  return (
    <div className="grid h-screen place-items-center bg-canvas">
      <LoadingState rows={2} label="Loading" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Nothing renders until the stored token has been checked, or the shell
  // flashes and then bounces to login.
  if (loading) {
    return (
      <div className="grid h-screen place-items-center bg-canvas">
        <LoadingState rows={2} label="Restoring session" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          // A bare ground rather than a spinner: the chunk arrives in a few
          // hundred milliseconds and a spinner that flashes is worse than a
          // brief hold on the page's own background colour.
          <Suspense fallback={<div className="min-h-screen bg-canvas" />}>
            <Landing />
          </Suspense>
        }
      />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />

      <Route
        path="/workspaces"
        element={
          <RequireAuth>
            <Suspense fallback={<RouteFallback />}>
              <Workspaces />
            </Suspense>
          </RequireAuth>
        }
      />

      {/* One boundary around the whole authenticated area: the shell and the
          page inside it arrive together, so the chrome does not paint and then
          wait for its contents. */}
      <Route
        element={
          <RequireAuth>
            <Suspense fallback={<RouteFallback />}>
              <AppShell />
            </Suspense>
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route
          path="/workbench"
          element={<Placeholder name="The AI Workbench" part="Part 03" />}
        />
        <Route
          path="/tasks"
          element={<Placeholder name="Tasks" part="Part 03" />}
        />
        <Route
          path="/documents"
          element={<Placeholder name="Documents" part="Part 04" />}
        />
        <Route
          path="/knowledge"
          element={<Placeholder name="The Knowledge Base" part="Part 04" />}
        />
        <Route
          path="/artifacts"
          element={<Placeholder name="Artifacts" part="Part 04" />}
        />
        <Route
          path="/models"
          element={<Placeholder name="The Model Center" part="Part 05" />}
        />
        <Route
          path="/security"
          element={<Placeholder name="The Security Center" part="Part 05" />}
        />
        <Route
          path="/settings"
          element={<Placeholder name="Settings" part="Part 05" />}
        />
        <Route
          path="/profile"
          element={<Placeholder name="Profile" part="Part 05" />}
        />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
