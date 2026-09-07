import { useMemo, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import { useConversations } from "@/lib/queries";
import { formatRelative } from "@/lib/format";

/**
 * Recent conversations, in the sidebar.
 *
 * The shape `front` draws: a "New session" action, a search box, then the list.
 * Only shown to roles that hold the workbench — a security administrator has no
 * conversations by design, and an empty history panel would read as a fault
 * rather than as the boundary working.
 *
 * Each entry reopens its conversation rebuilt from the tasks it produced, which
 * is why the list is useful after a restart: the event stream's buffer is gone
 * by then, but the runs are not.
 */
export function ChatHistory({ collapsed }: { collapsed: boolean }) {
  const [params] = useSearchParams();
  const active = params.get("conversation");
  const [query, setQuery] = useState("");
  const conversations = useConversations();

  const items = useMemo(() => {
    const all = conversations.data?.items ?? [];
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? all.filter((c) => (c.title ?? "").toLowerCase().includes(needle))
      : all;
    return [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [conversations.data, query]);

  if (collapsed) return <div className="sidebar-scroll" />;

  return (
    <div className="sidebar-scroll">
      <NavLink
        to="/workbench"
        end
        className="btn btn-sm"
        style={{ width: "100%", justifyContent: "center", marginBottom: "10px" }}
      >
        <MessageSquarePlus className="size-3.5" aria-hidden />
        New session
      </NavLink>

      <div className="nav-group-label">Chat history</div>

      <input
        className="input session-search"
        type="search"
        placeholder="Search sessions…"
        aria-label="Search chat history"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {conversations.isLoading ? (
        <p className="hint" style={{ padding: "4px 10px" }}>
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="hint" style={{ padding: "4px 10px" }}>
          {query ? "No sessions match." : "No sessions yet."}
        </p>
      ) : (
        <div className="recent-list">
          {items.map((conversation) => (
            <NavLink
              key={conversation.id}
              to={`/workbench?conversation=${conversation.id}`}
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
          ))}
        </div>
      )}
    </div>
  );
}
