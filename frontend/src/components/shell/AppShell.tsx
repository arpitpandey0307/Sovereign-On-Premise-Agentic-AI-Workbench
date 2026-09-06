import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "@/components/shell/Sidebar";
import { Header } from "@/components/shell/Header";

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/workbench": "AI Workbench",
  "/documents": "Documents",
  "/knowledge": "Knowledge Base",
  "/tasks": "Tasks",
  "/artifacts": "Artifacts",
  "/models": "Model Center",
  "/security": "Security & Sovereignty Center",
  "/settings": "Settings",
  "/profile": "Profile",
};

const COLLAPSED_KEY = "sovereign.sidebar.collapsed";

export function AppShell() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  const toggle = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        /* the choice simply will not persist */
      }
      return next;
    });
  };

  const title =
    TITLES[location.pathname] ??
    TITLES[`/${location.pathname.split("/")[1] ?? ""}`];

  return (
    <div className="flex h-screen overflow-hidden bg-base">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header title={title} />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
