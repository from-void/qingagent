import type { Migration } from "./types.js";

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await client.execute(
    `CREATE TABLE client_message_idempotency (
      id          TEXT    PRIMARY KEY,
      session_id  TEXT    NOT NULL,
      message_id  TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    )`,
  );
  await client.execute(
    `CREATE INDEX idx_client_message_idempotency_created_at
      ON client_message_idempotency(created_at)`,
  );
}

export const migration0031ClientMessageIdempotency: Migration = {
  id: 31,
  name: "client_message_idempotency",
  up,
};
