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
