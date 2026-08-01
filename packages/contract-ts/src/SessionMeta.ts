import type { SessionStatus } from "./SessionStatus";

export type SessionMeta = { id: string, title: string, created_at: string, updated_at?: string, summary: string, imageUrl?: string | null, status: SessionStatus, generating: boolean, };
