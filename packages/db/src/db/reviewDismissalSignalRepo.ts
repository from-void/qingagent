import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { isSensitiveReviewOrigin, maskSensitiveValues } from "@qingagent/contract-ts";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export interface ReviewDismissalSignal {
  id: string;
  docId: string;
  origin: string;
  summary: string;
  quote: string;
  ts: string;
}

export async function insertReviewDismissalSignal(
  input: Omit<ReviewDismissalSignal, "id" | "ts">,
  client?: Client,
  ts = new Date().toISOString(),
): Promise<ReviewDismissalSignal> {
  await ensureMigrated();
  const db = client ?? getDocumentsClient();
  const item: ReviewDismissalSignal = {
    id: randomUUID(),
    ...input,
    summary: isSensitiveReviewOrigin(input.origin) ? maskSensitiveValues(input.summary) : input.summary,
    quote: isSensitiveReviewOrigin(input.origin) ? maskSensitiveValues(input.quote) : input.quote,
    ts,
  };
  await withWriteRetry(() => db.execute({
    sql: `INSERT INTO review_dismissal_signals(id,doc_id,origin,summary,quote,ts)
      VALUES(?,?,?,?,?,?)`,
    args: [item.id, item.docId, item.origin, item.summary, item.quote, item.ts],
  }));
  return item;
}

/** 文档内生效的“不再提示”信号；由批注唯一生产入口在写入前读取。 */
export async function listReviewDismissalSignals(
  docId: string,
  client?: Client,
): Promise<ReviewDismissalSignal[]> {
  await ensureMigrated();
  const db = client ?? getDocumentsClient();
  const result = await db.execute({
    sql: `SELECT id,doc_id,origin,summary,quote,ts
      FROM review_dismissal_signals
      WHERE doc_id=?
      ORDER BY ts DESC, id ASC`,
    args: [docId],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    docId: String(row.doc_id),
    origin: String(row.origin),
    summary: String(row.summary),
    quote: String(row.quote),
    ts: String(row.ts),
  }));
}
