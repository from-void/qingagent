import type { Client, Row } from "@libsql/client";
import {
  getDocumentsClient,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export const CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS =
  60 * 60 * 1_000;

export interface ClientMessageIdempotencyRecord {
  id: string;
  sessionId: string;
  messageId: string;
  createdAt: number;
  lastTouched: number;
  completedAt: number | null;
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
    lastTouched: Number(row.last_touched),
    completedAt:
      row.completed_at === null ? null : Number(row.completed_at),
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
  const completedBefore =
    createdAt - CLIENT_MESSAGE_IDEMPOTENCY_TTL_MS;
  const stuckBefore =
    createdAt - CLIENT_MESSAGE_IDEMPOTENCY_INFLIGHT_STALE_MS;

  await withWriteRetry(() =>
    client.execute({
      sql: `DELETE FROM client_message_idempotency
        WHERE (
          completed_at IS NOT NULL
          AND completed_at <= ?
        ) OR (
          completed_at IS NULL
          AND last_touched <= ?
        )`,
      args: [completedBefore, stuckBefore],
    }),
  );
  const inserted = await withWriteRetry(() =>
    client.execute({
      sql: `INSERT INTO client_message_idempotency (
          id, session_id, message_id, created_at, last_touched, completed_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(session_id, id) DO NOTHING
        RETURNING
          id, session_id, message_id, created_at, last_touched, completed_at`,
      args: [
        input.id,
        input.sessionId,
        input.messageId,
        createdAt,
        createdAt,
      ],
    }),
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return { claimed: true, record: mapRecord(insertedRow) };
  }

  const existing = await client.execute({
    sql: `SELECT
        id, session_id, message_id, created_at, last_touched, completed_at
      FROM client_message_idempotency
      WHERE session_id = ?
        AND id = ?
      LIMIT 1`,
    args: [input.sessionId, input.id],
  });
  const row = existing.rows[0];
  if (!row) {
    throw new Error("client message idempotency claim invariant violated");
  }
  return { claimed: false, record: mapRecord(row) };
}

interface ClientMessageIdempotencyOwnedInput {
  id: string;
  sessionId: string;
  messageId: string;
  createdAt: number;
  now?: number;
  client?: Client;
}

export async function touchClientMessageIdempotency(
  input: ClientMessageIdempotencyOwnedInput,
): Promise<boolean> {
  const client = await readyClient(input.client);
  const touchedAt = input.now ?? Date.now();
  const result = await withWriteRetry(() =>
    client.execute({
      sql: `UPDATE client_message_idempotency
        SET last_touched = MAX(last_touched, ?)
        WHERE session_id = ?
          AND id = ?
          AND message_id = ?
          AND created_at = ?
          AND completed_at IS NULL`,
      args: [
        touchedAt,
        input.sessionId,
        input.id,
        input.messageId,
        input.createdAt,
      ],
    }),
  );
  return Number(result.rowsAffected) === 1;
}

export async function completeClientMessageIdempotency(
  input: ClientMessageIdempotencyOwnedInput,
): Promise<boolean> {
  const client = await readyClient(input.client);
  const completedAt = input.now ?? Date.now();
  const result = await withWriteRetry(() =>
    client.execute({
      sql: `UPDATE client_message_idempotency
        SET last_touched = MAX(last_touched, ?),
            completed_at = ?
        WHERE session_id = ?
          AND id = ?
          AND message_id = ?
          AND created_at = ?
          AND completed_at IS NULL`,
      args: [
        completedAt,
        completedAt,
        input.sessionId,
        input.id,
        input.messageId,
        input.createdAt,
      ],
    }),
  );
  return Number(result.rowsAffected) === 1;
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
        WHERE session_id = ?
          AND id = ?
          AND message_id = ?
          AND created_at = ?`,
      args: [
        input.sessionId,
        input.id,
        input.messageId,
        input.createdAt,
      ],
    }),
  );
  return Number(result.rowsAffected) === 1;
}
