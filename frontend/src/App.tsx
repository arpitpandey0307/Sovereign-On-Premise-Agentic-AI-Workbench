import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Suspense, lazy, type ReactNode } from "react";
import { useAuth, useRole } from "@/lib/auth";
import { canOpen, homeFor, workspaceRole } from "@/lib/access";
import { NoAccess } from "@/components/states/NoAccess";
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
const Workbench = lazy(() =>
  import("@/pages/Workbench").then((m) => ({ default: m.Workbench })),
);
const Tasks = lazy(() =>
  import("@/pages/Tasks").then((m) => ({ default: m.Tasks })),
);
const TaskTrace = lazy(() =>
  import("@/pages/TaskTrace").then((m) => ({ default: m.TaskTrace })),
);
const Approvals = lazy(() =>
  import("@/pages/Approvals").then((m) => ({ default: m.Approvals })),
);
const Coding = lazy(() =>
  import("@/pages/Coding").then((m) => ({ default: m.Coding })),
);
const Documents = lazy(() =>
  import("@/pages/Documents").then((m) => ({ default: m.Documents })),
);
const DocumentViewer = lazy(() =>
  import("@/pages/DocumentViewer").then((m) => ({ default: m.DocumentViewer })),
);
const Knowledge = lazy(() =>
  import("@/pages/Knowledge").then((m) => ({ default: m.Knowledge })),
);
const Artifacts = lazy(() =>
  import("@/pages/Artifacts").then((m) => ({ default: m.Artifacts })),
);
const Security = lazy(() =>
  import("@/pages/Security").then((m) => ({ default: m.Security })),
);
const Models = lazy(() =>
  import("@/pages/Models").then((m) => ({ default: m.Models })),
);
const Settings = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.Settings })),
);
const Profile = lazy(() =>
  import("@/pages/Profile").then((m) => ({ default: m.Profile })),
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

/**
 * The boundary the sidebar only *describes*.
 *
 * Hiding a link is presentation; without this, typing `/security` as an
 * engineer still rendered the Security Center and left it to the API to refuse
 * each request piecemeal. The screen is refused as a whole instead, and says
 * which workspace the person actually holds.
 *
 * This is not the security boundary — the server is, and it re-checks every
 * request. It is the interface agreeing with the server instead of contradicting
 * it.
 */
function RequireAccess() {
  const { roles } = useRole();
  const location = useLocation();
  const role = workspaceRole(roles);

  if (!canOpen(role, location.pathname)) {
    return <NoAccess role={role} pathname={location.pathname} home={homeFor(role)} />;
  }

  return <Outlet />;
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

      {/* Deliberately outside RequireAuth: choosing where you work comes
          before proving who you are. The choice grants nothing -- sign-in
          settles it. */}
      <Route
        path="/workspaces"
        element={
          <Suspense fallback={<RouteFallback />}>
            <Workspaces />
          </Suspense>
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
        <Route element={<RequireAccess />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/coding" element={<Coding />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:id" element={<TaskTrace />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/documents/:id" element={<DocumentViewer />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/artifacts" element={<Artifacts />} />
          <Route path="/models" element={<Models />} />
          <Route path="/security" element={<Security />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile" element={<Profile />} />
        </Route>
      </Route>

      {/* An unknown path lands on the chooser, not on a dashboard a security
          administrator has no data for. */}
      <Route path="*" element={<Navigate to="/workspaces" replace />} />
    </Routes>
  );
}
