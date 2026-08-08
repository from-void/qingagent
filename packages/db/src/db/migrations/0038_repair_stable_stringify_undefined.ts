import {
  getPmContentHash,
  getStablePmJson,
  safeParsePmDoc,
  type PmDoc,
} from "@qingagent/pm-schema";
import type { Row } from "@libsql/client";
import type { Migration } from "./types.js";

interface RecoveredPm {
  doc: PmDoc;
  json: string;
  hash: string;
}

function replaceBareUndefinedTokens(
  input: string,
  replacement: string,
): { json: string; replacements: number } | null {
  let json = "";
  let inString = false;
  let replacements = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (inString) {
      json += char;
      if (char === "\\") {
        index += 1;
        if (index < input.length) json += input[index]!;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      json += char;
      continue;
    }
    if (!input.startsWith("undefined", index)) {
      json += char;
      continue;
    }

    let previousIndex = index - 1;
    while (previousIndex >= 0 && /\s/.test(input[previousIndex]!)) previousIndex -= 1;
    let nextIndex = index + "undefined".length;
    while (nextIndex < input.length && /\s/.test(input[nextIndex]!)) nextIndex += 1;
    const previous = input[previousIndex];
    const next = input[nextIndex];
    if (
      previous !== ":"
      && previous !== "["
      && previous !== ","
    ) {
      json += char;
      continue;
    }
    if (next !== "," && next !== "}" && next !== "]") {
      json += char;
      continue;
    }

    json += replacement;
    replacements += 1;
    index += "undefined".length - 1;
  }

  return replacements > 0 ? { json, replacements } : null;
}

function countSentinel(value: unknown, sentinel: string): number {
  if (value === sentinel) return 1;
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countSentinel(item, sentinel), 0);
  }
  if (value === null || typeof value !== "object") return 0;
  return Object.values(value).reduce(
    (count, item) => count + countSentinel(item, sentinel),
    0,
  );
}

function restoreUndefinedSemantics(value: unknown, sentinel: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === sentinel ? null : restoreUndefinedSemantics(item, sentinel)
    );
  }
  if (value === null || typeof value !== "object") return value;
  const restored: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === sentinel) continue;
    restored[key] = restoreUndefinedSemantics(item, sentinel);
  }
  return restored;
}

/**
 * 修复旧 stableStringify 写出的裸 undefined。只接受“替换后整体可被 JSON.parse”
 * 的输入；围栏、前后散文、截断或其他损坏一律返回 null，交由隔离机制保留。
 */
function repairLegacyStableJsonUndefined(input: string): unknown | null {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    // 候选哨兵若也存在于用户字符串中，计数会大于裸 token 数，换下一个即可；
    // 因此不会误删正文里转义得到的同名字符串。
    const sentinel = `\u0000qingagent-stable-undefined-${attempt}\u0000`;
    const replaced = replaceBareUndefinedTokens(input, JSON.stringify(sentinel));
    if (!replaced) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(replaced.json) as unknown;
    } catch {
      return null;
    }
    if (countSentinel(parsed, sentinel) !== replaced.replacements) continue;
    return restoreUndefinedSemantics(parsed, sentinel);
  }
  return null;
}


function recoverPm(raw: unknown): RecoveredPm | null {
  if (typeof raw !== "string") return null;
  const repaired = repairLegacyStableJsonUndefined(raw);
  if (repaired === null) return null;
  const parsed = safeParsePmDoc(repaired);
  if (!parsed.success) return null;
  const doc = parsed.data as PmDoc;
  return {
    doc,
    json: getStablePmJson(doc),
    hash: getPmContentHash(doc),
  };
}

async function repairLiveRows(
  client: Parameters<Migration["up"]>[0],
): Promise<void> {
  const result = await client.execute(`SELECT id,version,doc_pm
    FROM documents
    WHERE doc_pm IS NOT NULL
      AND trim(doc_pm) <> ''
      AND NOT json_valid(doc_pm)`);
  for (const row of result.rows) {
    const recovered = recoverPm(row.doc_pm);
    if (!recovered) continue;
    await client.execute({
      sql: `UPDATE documents SET
          doc_pm=?,doc_schema_version=?,content_hash=?,doc_format='pm'
        WHERE id=? AND version=? AND doc_pm IS ?`,
      args: [
        recovered.json,
        recovered.doc.attrs.schemaVersion,
        recovered.hash,
        String(row.id),
        Number(row.version),
        String(row.doc_pm),
      ],
    });
  }
}

async function eligibleQuarantineRows(
  client: Parameters<Migration["up"]>[0],
): Promise<Row[]> {
  const mastraThreads = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mastra_threads' LIMIT 1",
  );
  if (mastraThreads.rows.length === 0) return [];
  const result = await client.execute(`SELECT q.*
    FROM documents_quarantine_invalid_pm q
    INNER JOIN mastra_threads t ON t.id=q.thread_id
    WHERE q.reason='invalid_pm'
      AND NOT EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id=q.id OR d.thread_id=q.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM deleted_sessions deleted
        WHERE deleted.session_id IN (q.id,q.thread_id)
      )
    ORDER BY q.id,q.doc_version DESC,q.version DESC,q.quarantine_id DESC`);
  return result.rows;
}

async function restoreQuarantineRows(
  client: Parameters<Migration["up"]>[0],
): Promise<void> {
  const restoredDocumentIds = new Set<string>();
  for (const row of await eligibleQuarantineRows(client)) {
    const id = String(row.id);
    if (restoredDocumentIds.has(id)) continue;
    const recovered = recoverPm(row.doc_pm);
    if (!recovered) continue;
    // 迁移只执行一次；原隔离行保留作审计证据。OR IGNORE 防御同一批隔离数据里
    // 异常的 id/thread 唯一键冲突，绝不覆盖已经存在的用户文档。
    await client.execute({
      sql: `INSERT OR IGNORE INTO documents (
          id,thread_id,resource_id,title,doc_state,doc_version,
          last_synced_version,doc_pm,doc_schema_version,content_hash,
          doc_format,version,created_at,updated_at,role
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        String(row.thread_id),
        String(row.resource_id),
        String(row.title),
        String(row.doc_state),
        Number(row.doc_version),
        Number(row.last_synced_version),
        recovered.json,
        recovered.doc.attrs.schemaVersion,
        recovered.hash,
        "pm",
        Number(row.version),
        String(row.created_at),
        String(row.updated_at),
        String(row.role),
      ],
    });
    restoredDocumentIds.add(id);
  }
}

async function up(client: Parameters<Migration["up"]>[0]): Promise<void> {
  await repairLiveRows(client);
  await restoreQuarantineRows(client);
}

export const migration0038RepairStableStringifyUndefined: Migration = {
  id: 38,
  name: "repair_stable_stringify_undefined",
  up,
};
