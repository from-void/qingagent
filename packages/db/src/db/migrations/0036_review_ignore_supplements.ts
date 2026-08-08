import {
  appendReviewIgnoreLines,
  buildReviewIgnoreLine,
  reviewTypeFromAnnotationOrigin,
  type ReviewType,
} from "@qingagent/contract-ts";
import type { Migration } from "./types.js";

interface MigratedGroup {
  docId: string;
  type: ReviewType;
  lines: string[];
  updatedAt: string;
}

function dateFromTimestamp(timestamp: string): string {
  return timestamp.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "日期不详";
}

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  const rows = await client.execute(
    `SELECT id,doc_id,origin,summary,quote,ts
      FROM review_dismissal_signals
      ORDER BY doc_id,ts,id`,
  );
  const groups = new Map<string, MigratedGroup>();
  for (const row of rows.rows) {
    const docId = String(row.doc_id);
    const type = reviewTypeFromAnnotationOrigin(String(row.origin));
    const timestamp = String(row.ts);
    const key = `${docId}\0${type}`;
    const group = groups.get(key) ?? {
      docId,
      type,
      lines: [],
      updatedAt: timestamp,
    };
    group.lines.push(buildReviewIgnoreLine({
      quote: String(row.quote),
      summary: String(row.summary),
      date: dateFromTimestamp(timestamp),
      decisionKey: `migration-0036:${encodeURIComponent(String(row.id))}`,
    }));
    if (timestamp > group.updatedAt) group.updatedAt = timestamp;
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const current = await client.execute({
      sql: "SELECT supplement FROM review_doc_supplements WHERE doc_id=? AND type=?",
      args: [group.docId, group.type],
    });
    const supplement = appendReviewIgnoreLines(
      String(current.rows[0]?.supplement ?? ""),
      group.lines,
    );
    await client.execute({
      sql: `INSERT INTO review_doc_supplements(doc_id,type,supplement,created_at,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(doc_id,type) DO UPDATE SET
        supplement=excluded.supplement,updated_at=excluded.updated_at`,
      args: [group.docId, group.type, supplement, group.updatedAt, group.updatedAt],
    });
  }

  await client.execute("DROP TABLE review_dismissal_signals");
}

export const migration0036ReviewIgnoreSupplements: Migration = {
  id: 36,
  name: "review_ignore_supplements",
  up,
};
