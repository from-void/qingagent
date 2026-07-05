import type { SessionMeta } from "./SessionMeta";

export type HomeFeed = { recent_sessions: Array<SessionMeta>, pinned_docs: Array<{ id: string, title: string, updated_at: string, }>, };
