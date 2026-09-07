import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Sidebar } from "@/components/shell/Sidebar";
import { Header } from "@/components/shell/Header";
import { SessionNotice } from "@/components/shell/SessionNotice";

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/workbench": "AI Workbench",
  "/coding": "Coding Workspace",
  "/approvals": "Approval Requests",
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
  const reduced = useReducedMotion();
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
    <div className="shell">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <div className="main">
        <SessionNotice />
        <Header title={title} />
        {/* One short, quiet transition between screens. It marks that the
            content changed -- useful on a dense instrument panel where two
            screens can look alike at a glance -- and is short enough not to
            get in the way of someone moving quickly. Anyone who has asked for
            reduced motion gets the change with no movement. */}
        <main className="view">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
