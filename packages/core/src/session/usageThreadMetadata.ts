import type { LegacySection } from "@qingagent/contract-ts";
import {
  countDocVisibleChars,
  legacySectionsToPm,
  type PmDoc,
} from "@qingagent/pm-schema";
import {
  getDocumentsClient,
  isMissingMastraThreadsTableError,
} from "@qingagent/db";

const QINGAGENT_RESOURCE_ID = "qingagent-user";
const TITLE_QUERY_BATCH_SIZE = 200;

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    output.push(values.slice(start, start + size));
  }
  return output;
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function resolveSelectedThreadDoc(docValue: unknown, legacyValue: unknown): PmDoc | null {
  const doc = parseJsonColumn(docValue);
  if (doc && typeof doc === "object") return doc as PmDoc;
  const legacySections = parseJsonColumn(legacyValue);
  if (!Array.isArray(legacySections) || legacySections.length === 0) return null;
  try {
    return legacySectionsToPm(legacySections as LegacySection[]);
  } catch {
    return null;
  }
}

/**
 * usage 标题兜底只查询聚合结果真正引用的 thread id，并只投影标题字段。
 * 避免 listThreads(perPage:false) 读取、解析每个历史线程的完整 metadata。
 */
export async function getSessionThreadTitles(
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(sessionIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const client = getDocumentsClient();
  const titles = new Map<string, string>();
  try {
    for (const batch of chunks(uniqueIds, TITLE_QUERY_BATCH_SIZE)) {
      const placeholders = batch.map(() => "?").join(", ");
      const result = await client.execute({
        sql: `SELECT id, title,
            json_extract(metadata, '$.title') AS metadata_title
          FROM mastra_threads
          WHERE resourceId = ?
            AND id IN (${placeholders})`,
        args: [QINGAGENT_RESOURCE_ID, ...batch],
      });
      for (const row of result.rows) {
        const id = String(row.id ?? "");
        if (!id) continue;
        const metadataTitle = row.metadata_title == null ? "" : String(row.metadata_title);
        const threadTitle = row.title == null ? "" : String(row.title);
        titles.set(id, metadataTitle || threadTitle || "");
      }
    }
    return titles;
  } catch (error) {
    if (isMissingMastraThreadsTableError(error)) return new Map();
    throw error;
  }
}

/**
 * 文档统计只读取时间窗内 thread 的 doc / legacySections 两个 JSON 子字段。
 * 返回值保持旧路由“近期 thread 数 + 可见字符数”的语义。
 */
export async function getSessionDocumentStatsSince(
  cutoffMs: number,
): Promise<{ docs: number; words: number }> {
  const cutoff = new Date(cutoffMs).toISOString();
  const client = getDocumentsClient();
  try {
    const result = await client.execute({
      sql: `SELECT
          json_extract(metadata, '$.doc') AS doc,
          json_extract(metadata, '$.legacySections') AS legacy_sections
        FROM mastra_threads
        WHERE resourceId = ?
          AND createdAt >= ?`,
      args: [QINGAGENT_RESOURCE_ID, cutoff],
    });
    let words = 0;
    for (const row of result.rows) {
      const doc = resolveSelectedThreadDoc(row.doc, row.legacy_sections);
      if (doc) words += countDocVisibleChars(doc);
    }
    return { docs: result.rows.length, words };
  } catch (error) {
    if (isMissingMastraThreadsTableError(error)) return { docs: 0, words: 0 };
    throw error;
  }
}
