import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(`CREATE TABLE client_message_idempotency_session_scoped (
    id            TEXT    NOT NULL,
    session_id    TEXT    NOT NULL,
    message_id    TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    last_touched  INTEGER NOT NULL DEFAULT 0,
    completed_at  INTEGER,
    PRIMARY KEY(session_id, id)
  )`);

  // 0031 起 session_id 即为 NOT NULL：有归属的老 TTL 行按原 session_id 原样迁入
  // 复合键。若手工改库留下空 session_id，则无法确定归属，按可丢弃的过期幂等行
  // 处置，不把它扩散到任何会话。
  await client.execute(`INSERT INTO client_message_idempotency_session_scoped(
      id,session_id,message_id,created_at,last_touched,completed_at
    )
    SELECT id,session_id,message_id,created_at,last_touched,completed_at
    FROM client_message_idempotency
    WHERE session_id <> ''`);

  await client.execute("DROP TABLE client_message_idempotency");
  await client.execute(
    `ALTER TABLE client_message_idempotency_session_scoped
      RENAME TO client_message_idempotency`,
  );
  await client.execute(
    `CREATE INDEX idx_client_message_idempotency_created_at
      ON client_message_idempotency(created_at)`,
  );
  await client.execute(
    `CREATE INDEX idx_client_message_idempotency_last_touched
      ON client_message_idempotency(last_touched)`,
  );
  await client.execute(
    `CREATE INDEX idx_client_message_idempotency_completed_at
      ON client_message_idempotency(completed_at)`,
  );
}

export const migration0041ClientMessageIdempotencySessionScope: Migration = {
  id: 41,
  name: "client_message_idempotency_session_scope",
  up,
};
