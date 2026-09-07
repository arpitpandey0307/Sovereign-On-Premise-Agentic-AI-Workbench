import { useMemo, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { motion } from "framer-motion";
import { useConversations, useTasks } from "@/lib/queries";
import { formatRelative } from "@/lib/format";

/**
 * Recent sessions, in the sidebar, for the surface you are standing in.
 *
 * A conversation belongs to whichever workspace produced it: a session whose
 * tasks were `coding` is the coding workspace's, everything else is the AI
 * workbench's. They are kept apart because they are different kinds of work —
 * scrolling past a dozen document questions to find yesterday's script is the
 * problem this avoids.
 *
 * The backend has no conversation *kind*, so it is derived from the tasks each
 * conversation produced. A conversation with no tasks yet is an unused "new
 * session" and belongs to the surface that is asking, which is why the default
 * is the current kind rather than `ai`.
 */

/** The two working surfaces that keep a history. */
export type HistoryKind = "ai" | "coding";

export function ChatHistory({
  kind,
  collapsed,
}: {
  kind: HistoryKind;
  collapsed: boolean;
}) {
  const [params] = useSearchParams();
  const active = params.get("conversation");
  const [query, setQuery] = useState("");

  const conversations = useConversations();
  // Enough recent tasks to classify the conversations on screen. The list is
  // per-user, so this is the caller's own work, not the whole plant's.
  const tasks = useTasks({ limit: 100 });

  const items = useMemo(() => {
    const all = conversations.data?.items ?? [];

    // conversation id -> whether any of its tasks was a coding task.
    const codingByConversation = new Map<string, boolean>();
    for (const task of tasks.data?.items ?? []) {
      const isCoding = task.task_type === "coding";
      codingByConversation.set(
        task.conversation_id,
        (codingByConversation.get(task.conversation_id) ?? false) || isCoding,
      );
    }

    const mine = all.filter((conversation) => {
      const coding = codingByConversation.get(conversation.id);
      // Untouched sessions belong to whoever is looking at them.
      if (coding === undefined) return true;
      return kind === "coding" ? coding : !coding;
    });

    const needle = query.trim().toLowerCase();
    const matched = needle
      ? mine.filter((c) => (c.title ?? "").toLowerCase().includes(needle))
      : mine;

    return [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [conversations.data, tasks.data, kind, query]);

  if (collapsed) return <div className="sidebar-scroll" />;

  const surface = kind === "coding" ? "/coding" : "/workbench";
  const loading = conversations.isLoading || tasks.isLoading;

  return (
    <div className="sidebar-scroll">
      <NavLink
        to={surface}
        end
        className="btn btn-sm"
        style={{ width: "100%", justifyContent: "center", marginBottom: "10px" }}
      >
        <MessageSquarePlus className="size-3.5" aria-hidden />
        New session
      </NavLink>

      <div className="nav-group-label">
        {kind === "coding" ? "Coding sessions" : "Workbench sessions"}
      </div>

      <input
        className="input session-search"
        type="search"
        placeholder="Search sessions…"
        aria-label="Search sessions"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {loading ? (
        <p className="hint" style={{ padding: "4px 10px" }}>
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="hint" style={{ padding: "4px 10px" }}>
          {query
            ? "No sessions match."
            : kind === "coding"
              ? "No coding sessions yet."
              : "No sessions yet."}
        </p>
      ) : (
        <div className="recent-list">
          {items.map((conversation, index) => (
            <motion.div
              key={conversation.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.22, delay: Math.min(index, 8) * 0.02 }}
            >
              <NavLink
                to={`${surface}?conversation=${conversation.id}`}
                title={conversation.title || "Untitled session"}
                className={
                  "recent-item" + (active === conversation.id ? " active" : "")
                }
              >
                <span className="truncate">
                  {conversation.title || "Untitled session"}
                </span>
                <span
                  className="block text-[10px]"
                  style={{ color: "var(--text-faint)" }}
                >
                  {formatRelative(conversation.created_at)}
                </span>
              </NavLink>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
