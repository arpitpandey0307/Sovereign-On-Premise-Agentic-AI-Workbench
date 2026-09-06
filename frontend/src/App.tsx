import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { LoadingState } from "@/components/states/LoadingState";
import { Login } from "@/pages/Login";
import { Signup } from "@/pages/Signup";
import { Workspaces } from "@/pages/Workspaces";
import { Dashboard } from "@/pages/Dashboard";
import { Placeholder } from "@/pages/Placeholder";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Nothing renders until the stored token has been checked, or the shell
  // flashes and then bounces to login.
  if (loading) {
    return (
      <div className="grid h-screen place-items-center bg-base">
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
      {/* The landing page arrives in Part 02; until then the root goes to
          the application. */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />

      <Route
        path="/workspaces"
        element={
          <RequireAuth>
            <Workspaces />
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell />
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
