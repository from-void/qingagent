import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(`CREATE TABLE deleted_sessions (
    session_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL CHECK(phase IN ('draining', 'documents_deleted', 'completed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  await client.execute(
    "CREATE INDEX idx_deleted_sessions_phase ON deleted_sessions(phase, updated_at)",
  );
}

export const migration0021DeletedSessions: Migration = {
  id: 21,
  name: "deleted_sessions",
  up,
};
