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
  const pendingDeletionIds = new Set<string>();
  const deletionPollAttempts = new Map<string, number>();
  const deletionPollTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const finalizeDeletion = (id: string) => {
    const timer = deletionPollTimers.get(id);
    if (timer) clearTimeout(timer);
    deletionPollTimers.delete(id);
    deletionPollAttempts.delete(id);
    pendingDeletionIds.delete(id);
    deletedSessionIds.add(id);
    latestFetchRequest += 1;
    set({
      sessions: get().sessions.filter((session) => session.id !== id),
      isLoading: false,
    });
  };

  const scheduleDeletionPoll = (id: string) => {
    if (deletionPollTimers.has(id)) return;
    const attempt = deletionPollAttempts.get(id) ?? 0;
    const delayMs = Math.min(500 * 2 ** attempt, 5_000);
    deletionPollAttempts.set(id, attempt + 1);
    const timer = setTimeout(() => {
      deletionPollTimers.delete(id);
      void requestDeletion(id, true);
    }, delayMs);
    deletionPollTimers.set(id, timer);
  };

  const markDeletionPending = (id: string) => {
    pendingDeletionIds.add(id);
    set((state) => ({
      sessions: state.sessions.map((session) => (
        session.id === id ? { ...session, status: { kind: "Deleting" as const } } : session
      )),
    }));
    scheduleDeletionPoll(id);
  };

  const requestDeletion = async (id: string, isPoll: boolean): Promise<void> => {
    try {
      const res = await fetch(`/api/v1/sessions/${id}`, { method: "DELETE" });
      const payload = await res.json().catch(() => null) as {
        deleted?: unknown;
        status?: unknown;
      } | null;
      if (res.status === 202) {
        if (payload?.deleted !== false || payload.status !== "pending") {
          throw new Error("删除状态响应无效，请稍后重试");
        }
        markDeletionPending(id);
        return;
      }
      if (!res.ok) throw new Error("删除失败，请稍后重试");
      if (payload?.deleted !== true) {
        throw new Error("删除状态响应无效，请稍后重试");
      }
      finalizeDeletion(id);
    } catch (error) {
      if (isPoll && pendingDeletionIds.has(id)) {
        scheduleDeletionPoll(id);
        return;
      }
      throw error;
    }
  };

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
        const serverSessions = (feed.recent_sessions as SessionMeta[])
          .filter((session) => !deletedSessionIds.has(session.id))
          .map((session) => pendingDeletionIds.has(session.id)
            ? { ...session, status: { kind: "Deleting" as const } }
            : session);
        const serverIds = new Set(serverSessions.map((session) => session.id));
        const pendingSessions = get().sessions.filter(
          (session) => pendingDeletionIds.has(session.id) && !serverIds.has(session.id),
        );
        set({
          sessions: [...pendingSessions, ...serverSessions],
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
      if (pendingDeletionIds.has(id)) return;
      await requestDeletion(id, false);
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
