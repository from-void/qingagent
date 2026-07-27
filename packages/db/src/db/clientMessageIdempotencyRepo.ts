import type { Client, Row } from "@libsql/client";
import {
  getDocumentsClient,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export const CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;

export interface ClientMessageIdempotencyRecord {
  id: string;
  sessionId: string;
  messageId: string;
  createdAt: number;
}

export interface ClientMessageIdempotencyClaim {
  claimed: boolean;
  record: ClientMessageIdempotencyRecord;
}

function mapRecord(row: Row): ClientMessageIdempotencyRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    createdAt: Number(row.created_at),
  };
}

async function readyClient(client?: Client): Promise<Client> {
  if (!client) await ensureMigrated();
  return client ?? getDocumentsClient();
}

export async function claimClientMessageIdempotency(input: {
  id: string;
  sessionId: string;
  messageId: string;
  now?: number;
  client?: Client;
}): Promise<ClientMessageIdempotencyClaim> {
  const client = await readyClient(input.client);
  const createdAt = input.now ?? Date.now();
  const expiresBefore =
    createdAt - CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS;

  await withWriteRetry(() =>
    client.execute({
      sql: "DELETE FROM client_message_idempotency WHERE created_at <= ?",
      args: [expiresBefore],
    }),
  );
  const inserted = await withWriteRetry(() =>
    client.execute({
      sql: `INSERT INTO client_message_idempotency (
          id, session_id, message_id, created_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
        RETURNING id, session_id, message_id, created_at`,
      args: [
        input.id,
        input.sessionId,
        input.messageId,
        createdAt,
      ],
    }),
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return { claimed: true, record: mapRecord(insertedRow) };
  }

  const existing = await client.execute({
    sql: `SELECT id, session_id, message_id, created_at
      FROM client_message_idempotency
      WHERE id = ?
      LIMIT 1`,
    args: [input.id],
  });
  const row = existing.rows[0];
  if (!row) {
    // 唯一键竞争后记录只可能存在；若外部进程恰好删除，重试整次 claim。
    return claimClientMessageIdempotency(input);
  }
  return { claimed: false, record: mapRecord(row) };
}

export async function releaseClientMessageIdempotency(input: {
  id: string;
  sessionId: string;
  messageId: string;
  createdAt: number;
  client?: Client;
}): Promise<boolean> {
  const client = await readyClient(input.client);
  const result = await withWriteRetry(() =>
    client.execute({
      sql: `DELETE FROM client_message_idempotency
        WHERE id = ?
          AND session_id = ?
          AND message_id = ?
          AND created_at = ?`,
      args: [
        input.id,
        input.sessionId,
        input.messageId,
        input.createdAt,
      ],
    }),
  );
  return Number(result.rowsAffected) === 1;
}
