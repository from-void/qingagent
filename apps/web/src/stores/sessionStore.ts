import { create } from "zustand";
import type { SessionMeta } from "@qingagent/contract-ts";

interface SessionStore {
  /** All sessions for the home page */
  sessions: SessionMeta[];
  /** Currently active session ID (set when entering workspace) */
  currentSessionId: string | null;
  /** Current workspace title for actions mounted outside the workspace tree. */
  currentSessionTitle: string | null;
  /** Loading state for the session list */
  isLoading: boolean;
  /** Error from the last fetch */
  error: string | null;

  /** Fetch sessions from the server */
  fetchSessions: () => Promise<void>;
  /** Set the current session ID (when navigating to workspace) */
  setCurrentSession: (id: string | null, title?: string | null) => void;
  /** Remove a session from the list and delete it on the server */
  removeSession: (id: string) => Promise<void>;
  /** Update a session's title in the list (from SSE sessionMeta frame) */
  updateSessionTitle: (id: string, title: string) => void;
  /** Add a new session to the top of the list */
  addSession: (session: SessionMeta) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => {
  let latestFetchRequest = 0;
  const deletedSessionIds = new Set<string>();

  return {
    sessions: [],
    currentSessionId: null,
    currentSessionTitle: null,
    isLoading: false,
    error: null,

    fetchSessions: async () => {
      const requestId = ++latestFetchRequest;
      set({ isLoading: true, error: null });
      try {
        const res = await fetch("/api/v1/home");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const feed = await res.json();
        if (requestId !== latestFetchRequest) return;
        set({
          sessions: (feed.recent_sessions as SessionMeta[]).filter(
            (session) => !deletedSessionIds.has(session.id),
          ),
          isLoading: false,
        });
      } catch (err) {
        if (requestId !== latestFetchRequest) return;
        set({
          error: err instanceof Error ? err.message : "Failed to load sessions",
          isLoading: false,
        });
      }
    },

    setCurrentSession: (id, title) =>
      set({
        currentSessionId: id,
        currentSessionTitle: title ?? null,
      }),

    removeSession: async (id) => {
      const res = await fetch(`/api/v1/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error("删除失败，请稍后重试");
      }
      deletedSessionIds.add(id);
      latestFetchRequest += 1;
      set({
        sessions: get().sessions.filter((s) => s.id !== id),
        isLoading: false,
      });
    },

    updateSessionTitle: (id, title) =>
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, title } : s,
        ),
        currentSessionTitle:
          state.currentSessionId === id ? title : state.currentSessionTitle,
      })),

    addSession: (session) =>
      set({ sessions: [session, ...get().sessions] }),
  };
});
