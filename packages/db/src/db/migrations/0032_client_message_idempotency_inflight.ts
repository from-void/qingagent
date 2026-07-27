import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(
    `ALTER TABLE client_message_idempotency
      ADD COLUMN last_touched INTEGER NOT NULL DEFAULT 0`,
  );
  await client.execute(
    `ALTER TABLE client_message_idempotency
      ADD COLUMN completed_at INTEGER`,
  );
  // 升级发生在服务启动前，0031 遗留行不可能仍由当前进程执行，按已完成回填。
  await client.execute(
    `UPDATE client_message_idempotency
      SET last_touched = created_at,
          completed_at = created_at`,
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

export const migration0032ClientMessageIdempotencyInflight: Migration = {
  id: 32,
  name: "client_message_idempotency_inflight",
  up,
};
