import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  // SQLite 不能原地扩展 CHECK；重建删除账本并把旧 completed 会话重新放回
  // documents_deleted，使升级后的续删链路补清 om-sidecar 与其它历史载体。
  await client.execute(`CREATE TABLE deleted_sessions_0037 (
    session_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL CHECK(phase IN (
      'draining',
      'documents_deleted',
      'threads_deleted',
      'database_deleted',
      'assets_deleted',
      'completed'
    )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  await client.execute(`INSERT INTO deleted_sessions_0037 (
      session_id, phase, created_at, updated_at, completed_at
    )
    SELECT session_id,
      CASE WHEN phase = 'completed' THEN 'documents_deleted' ELSE phase END,
      created_at,
      updated_at,
      CASE WHEN phase = 'completed' THEN NULL ELSE completed_at END
    FROM deleted_sessions`);
  await client.execute("DROP TABLE deleted_sessions");
  await client.execute("ALTER TABLE deleted_sessions_0037 RENAME TO deleted_sessions");
  await client.execute(
    "CREATE INDEX idx_deleted_sessions_phase ON deleted_sessions(phase, updated_at)",
  );

  await client.execute(`CREATE TABLE session_resources (
    session_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('upload', 'generated', 'discovered')),
    ref_count INTEGER NOT NULL DEFAULT 1 CHECK(ref_count > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(session_id, resource_id)
  )`);
  await client.execute(
    "CREATE INDEX idx_session_resources_resource ON session_resources(resource_id, session_id)",
  );
}

export const migration0037SessionResourceOwnership: Migration = {
  id: 37,
  name: "session_resource_ownership",
  up,
};
