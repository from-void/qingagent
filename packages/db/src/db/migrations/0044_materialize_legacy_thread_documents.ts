import { createHash } from "node:crypto";
import type { Client, Row } from "@libsql/client";
import {
  detectDrawioSource,
  detectMermaidSource,
  getDeterministicId,
  getPmContentHash,
  getStablePmJson,
  normalizePmDoc,
  PM_SCHEMA_VERSION,
  pmToPlainText,
  type PmBlockNode,
  type PmDiagramLang,
  type PmDoc,
  type PmInlineNode,
  type PmParagraphNode,
  type PmTableCellNode,
  type PmTableNode,
  type PmTableRowNode,
  type PmTaskListNode,
} from "@qingagent/pm-schema";
import type { Migration } from "./types.js";

const ELIGIBLE_RESOURCE_IDS = ["qingagent-user", "user-default"] as const;

function candidateSql(resourceColumn: "resourceId" | "resource_id", columns: ReadonlySet<string>): string {
  const title = columns.has("title") ? "t.title" : "''";
  const createdAt = columns.has("createdAt") ? 't."createdAt"' : "NULL";
  const updatedAt = columns.has("updatedAt") ? 't."updatedAt"' : "NULL";
  const resource = resourceColumn === "resourceId" ? 't."resourceId"' : "t.resource_id";
  return `SELECT
    t.id AS thread_id,
    ${resource} AS resource_id,
    ${title} AS thread_title,
    t.metadata,
    ${createdAt} AS created_at,
    ${updatedAt} AS updated_at
  FROM mastra_threads t
  WHERE ${resource} IN (?, ?)
    AND json_type(t.metadata, '$.legacySections') = 'array'
    AND json_array_length(t.metadata, '$.legacySections') > 0
    AND (
      json_type(t.metadata, '$.doc') IS NULL
      OR json_type(t.metadata, '$.doc') = 'null'
    )
    AND NOT EXISTS (
      SELECT 1 FROM documents d
      WHERE d.thread_id = t.id
        OR d.id = COALESCE(NULLIF(json_extract(t.metadata, '$.docId'), ''), t.id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM deleted_sessions tombstone
      WHERE tombstone.session_id IN (
        t.id,
        COALESCE(NULLIF(json_extract(t.metadata, '$.docId'), ''), t.id)
      )
    )
  ORDER BY t.id`;
}

type LegacyListSection = {
  ordered?: boolean;
  start?: number;
  items: LegacyListItem[];
};

type LegacyListItem =
  | string
  | {
      text: string;
      children?: LegacyListSectionLike[];
    };

type LegacyTaskItem = {
  text: string;
  checked: boolean;
  children?: Array<LegacyTaskItem | LegacyListSectionLike>;
};

type LegacyListSectionLike =
  | { kind: "list"; data: LegacyListSection }
  | { kind: "taskList"; data: { items: LegacyTaskItem[] } };

type LegacyLegacySection =
  | { kind: "h1"; data: { text: string } }
  | { kind: "h2"; data: { text: string; anchor?: string | null } }
  | { kind: "h3" | "h4" | "h5" | "h6"; data: { text: string } }
  | { kind: "p"; data: { text: string } }
  | { kind: "quote"; data: { text: string } }
  | { kind: "hr"; data?: Record<string, never> }
  | { kind: "list"; data: LegacyListSection }
  | { kind: "taskList"; data: { items: LegacyTaskItem[] } }
  | { kind: "table"; data: { head: string[]; rows: string[][] } }
  | { kind: "code"; data: { body: string; language?: string | null } }
  | { kind: "penNote"; data: { text: string } }
  | {
      kind: "image";
      data: {
        src: string;
        alt?: string | null;
	        caption?: string | null;
	        width?: number | null;
	        height?: number | null;
	        align?: "left" | "center" | "right" | null;
	      };
	    }
  | { kind: "diagram"; data: { lang: PmDiagramLang; source: string; svg?: string | null } };

function materializeLegacySections(sections: readonly LegacyLegacySection[]): PmDoc {
  const content = sections.map((section, index) => sectionToPmBlock(section, index));
  return normalizePmDoc({
    type: "doc",
    attrs: { schemaVersion: PM_SCHEMA_VERSION },
    content,
  });
}

function sectionToPmBlock(section: LegacyLegacySection, index: number): PmBlockNode {
  const blockId = getDeterministicId("block", { index, section });

  switch (section.kind) {
    case "h1":
      return heading(blockId, 1, section.data.text);
    case "h2":
      return heading(blockId, 2, section.data.text, section.data.anchor ?? null);
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return heading(blockId, Number(section.kind.slice(1)) as 3 | 4 | 5 | 6, section.data.text);
    case "p":
      return paragraph(blockId, section.data.text);
    case "quote":
      return {
        type: "blockquote",
        attrs: { blockId },
        content: [paragraph(`${blockId}-p`, section.data.text)],
      };
    case "hr":
      return { type: "horizontalRule", attrs: { blockId } };
    case "list":
      return listBlock(blockId, section.data);
    case "taskList":
      return taskListBlock(blockId, section.data.items);
    case "table":
      return table(blockId, section.data.head, section.data.rows);
    case "code": {
      // 安全网:模型把 Mermaid/drawio 图写成代码块时,转成 diagram 块(同 aiIrToPm)。
      const mermaidSource = detectMermaidSource(section.data.language, section.data.body);
      if (mermaidSource) {
        return { type: "diagram", attrs: { blockId, lang: "mermaid", source: mermaidSource, svg: null } };
      }
      const drawioSource = detectDrawioSource(section.data.language, section.data.body);
      if (drawioSource) {
        return { type: "diagram", attrs: { blockId, lang: "drawio", source: drawioSource, svg: null } };
      }
      return {
        type: "codeBlock",
        attrs: { blockId, language: section.data.language ?? "plaintext" },
        content: section.data.body ? [{ type: "text", text: section.data.body }] : [],
      };
    }
    case "penNote":
      return {
        type: "penNote",
        attrs: { blockId },
        content: textContent(section.data.text),
      };
    case "image":
      return {
        type: "image",
        attrs: {
          blockId,
          src: section.data.src,
          alt: section.data.alt ?? null,
	          caption: section.data.caption ?? null,
	          width: section.data.width ?? null,
	          height: section.data.height ?? null,
	          align: section.data.align ?? "center",
	        },
	      };
    case "diagram":
      return {
        type: "diagram",
        attrs: {
          blockId,
          lang: section.data.lang,
          source: section.data.source,
          // 安全:不信任 legacy section(常来自模型生成)里的 svg,一律 null,
          // 只让前端渲染并加固后回写可信 svg。防存储型 XSS(同 aiIrToPm)。
          svg: null,
        },
      };
  }
}

function listBlock(blockId: string, data: LegacyListSection): PmBlockNode {
  const content = data.items.map((item, itemIndex) => {
    const itemBlockId = `${blockId}-item-${itemIndex + 1}`;
    const text = typeof item === "string" ? item : item.text;
    const children = typeof item === "string" ? [] : item.children ?? [];
    return {
      type: "listItem" as const,
      attrs: { blockId: itemBlockId },
      content: [
        paragraph(`${itemBlockId}-p`, text),
        ...children.map((child, childIndex) =>
          child.kind === "taskList"
            ? taskListBlock(`${itemBlockId}-task-${childIndex + 1}`, child.data.items)
            : listBlock(`${itemBlockId}-list-${childIndex + 1}`, child.data),
        ),
      ],
    };
  });
  if (data.ordered) {
    return {
      type: "orderedList",
      attrs: { blockId, start: data.start ?? 1 },
      content,
    };
  }
  return {
    type: "bulletList",
    attrs: { blockId },
    content,
  };
}

function taskListBlock(blockId: string, items: LegacyTaskItem[]): PmTaskListNode {
  return {
    type: "taskList",
    attrs: { blockId },
    content: items.map((item, itemIndex) => {
      const itemBlockId = `${blockId}-item-${itemIndex + 1}`;
      return {
        type: "taskItem",
        attrs: { blockId: itemBlockId, checked: item.checked },
        content: [
          paragraph(`${itemBlockId}-p`, item.text),
          ...taskItemChildBlocks(itemBlockId, item.children ?? []),
        ],
      };
    }),
  };
}

function taskItemChildBlocks(
  itemBlockId: string,
  children: ReadonlyArray<LegacyTaskItem | LegacyListSectionLike>,
): PmBlockNode[] {
  const blocks: PmBlockNode[] = [];
  let taskRun: LegacyTaskItem[] = [];
  const flushTasks = () => {
    if (taskRun.length === 0) return;
    const suffix = blocks.length === 0 ? "tasks" : `tasks-${blocks.length + 1}`;
    blocks.push(taskListBlock(`${itemBlockId}-${suffix}`, taskRun));
    taskRun = [];
  };

  children.forEach((child, childIndex) => {
    if (!isLegacyListSectionLike(child)) {
      taskRun.push(child);
      return;
    }
    flushTasks();
    blocks.push(
      child.kind === "taskList"
        ? taskListBlock(`${itemBlockId}-task-${childIndex + 1}`, child.data.items)
        : listBlock(`${itemBlockId}-list-${childIndex + 1}`, child.data),
    );
  });
  flushTasks();
  return blocks;
}

function isLegacyListSectionLike(value: LegacyTaskItem | LegacyListSectionLike): value is LegacyListSectionLike {
  return typeof value === "object" && value !== null && "kind" in value;
}

function heading(
  blockId: string,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  text: string,
  anchor?: string | null,
): PmBlockNode {
  return {
    type: "heading",
    attrs: anchor === undefined ? { blockId, level } : { blockId, level, anchor },
    content: textContent(text),
  };
}

function paragraph(blockId: string, text: string): PmParagraphNode {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: textContent(text),
  };
}

function textContent(text: string): PmInlineNode[] {
  return text ? [{ type: "text", text }] : [];
}

function table(blockId: string, head: string[], rows: string[][]): PmTableNode {
  const columnCount = Math.max(head.length, ...rows.map((row) => row.length));
  const padRow = (row: string[]) => [
    ...row,
    ...Array.from({ length: columnCount - row.length }, () => ""),
  ];
  const normalizedHead = head.length > 0 ? padRow(head) : head;
  const normalizedRows = rows.map(padRow);
  const headerRow: PmTableRowNode | null = normalizedHead.length
    ? {
        type: "tableRow",
        content: normalizedHead.map((cell, cellIndex) =>
          tableCell("tableHeader", `${blockId}-h-${cellIndex + 1}`, cell)
        ),
      }
    : null;

  const bodyRows: PmTableRowNode[] = normalizedRows.map((row, rowIndex) => ({
    type: "tableRow",
    content: row.map((cell, cellIndex) => tableCell("tableCell", `${blockId}-r-${rowIndex + 1}-${cellIndex + 1}`, cell)),
  }));

  return {
    type: "table",
    attrs: { blockId },
    content: headerRow ? [headerRow, ...bodyRows] : bodyRows,
  };
}

function tableCell(type: "tableCell" | "tableHeader", blockId: string, text: string): PmTableCellNode {
  return {
    type,
    content: [paragraph(`${blockId}-p`, text)],
  };
}


type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(value: unknown): JsonRecord {
  const decoded = value instanceof Uint8Array
    ? new TextDecoder().decode(value)
    : value;
  const parsed = typeof decoded === "string"
    ? JSON.parse(decoded) as unknown
    : decoded;
  if (!isRecord(parsed)) {
    throw new Error("0044 thread metadata must be a JSON object");
  }
  return parsed;
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`0044 invalid legacy section field: ${field}`);
  }
  return value;
}

function legacyListText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error("0044 invalid legacy list");
  }
  return data.items.map((item, itemIndex) => {
    if (typeof item === "string") return item;
    if (!isRecord(item)) throw new Error(`0044 invalid legacy list item ${itemIndex}`);
    const text = requireString(item.text, `list.items[${itemIndex}].text`);
    const children = item.children;
    if (children === undefined) return text;
    if (!Array.isArray(children)) {
      throw new Error(`0044 invalid legacy list item children ${itemIndex}`);
    }
    return [text, ...children.map(legacyNestedBlockText)].join("\n");
  }).join("\n");
}

function legacyTaskItemText(item: unknown, itemIndex: number): string {
  if (!isRecord(item)) throw new Error(`0044 invalid legacy task item ${itemIndex}`);
  const text = requireString(item.text, `taskList.items[${itemIndex}].text`);
  if (typeof item.checked !== "boolean") {
    throw new Error(`0044 invalid legacy task item checked ${itemIndex}`);
  }
  const children = item.children;
  if (children !== undefined && !Array.isArray(children)) {
    throw new Error(`0044 invalid legacy task item children ${itemIndex}`);
  }
  const childText = (children ?? []).map((child, childIndex) =>
    isRecord(child) && typeof child.kind === "string"
      ? legacyNestedBlockText(child)
      : legacyTaskItemText(child, childIndex)
  );
  const content = [text, ...childText].join("\n");
  return `${item.checked ? "[x]" : "[ ]"} ${content}`;
}

function legacyTaskListText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error("0044 invalid legacy task list");
  }
  return data.items.map(legacyTaskItemText).join("\n");
}

function legacyNestedBlockText(value: unknown): string {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("0044 invalid nested legacy block");
  }
  if (value.kind === "list") return legacyListText(value.data);
  if (value.kind === "taskList") return legacyTaskListText(value.data);
  throw new Error(`0044 unsupported nested legacy block: ${value.kind}`);
}

function legacyTableText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.head) || !Array.isArray(data.rows)) {
    throw new Error("0044 invalid legacy table");
  }
  const head = data.head.map((cell, index) => requireString(cell, `table.head[${index}]`));
  const rows = data.rows.map((row, rowIndex) => {
    if (!Array.isArray(row)) throw new Error(`0044 invalid legacy table row ${rowIndex}`);
    return row.map((cell, cellIndex) =>
      requireString(cell, `table.rows[${rowIndex}][${cellIndex}]`)
    );
  });
  const columnCount = Math.max(head.length, ...rows.map((row) => row.length));
  const pad = (row: string[]): string[] => [
    ...row,
    ...Array.from({ length: columnCount - row.length }, () => ""),
  ];
  return [
    ...(head.length > 0 ? [pad(head)] : []),
    ...rows.map(pad),
  ].map((row) => row.join("\t")).join("\n");
}

function legacySectionText(value: unknown, index: number): string {
  if (!isRecord(value) || typeof value.kind !== "string" || !isRecord(value.data)) {
    throw new Error(`0044 invalid legacy section ${index}`);
  }
  const data = value.data;
  switch (value.kind) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "p":
    case "quote":
    case "penNote":
      return requireString(data.text, `legacySections[${index}].data.text`);
    case "code":
      return requireString(data.body, `legacySections[${index}].data.body`);
    case "image": {
      const caption = data.caption;
      const alt = data.alt;
      if (caption != null) return requireString(caption, `legacySections[${index}].data.caption`);
      if (alt != null) return requireString(alt, `legacySections[${index}].data.alt`);
      return "";
    }
    case "diagram":
      return requireString(data.source, `legacySections[${index}].data.source`);
    case "hr":
      return "";
    case "list":
      return legacyListText(data);
    case "taskList":
      return legacyTaskListText(data);
    case "table":
      return legacyTableText(data);
    default:
      throw new Error(`0044 unsupported legacy section kind: ${value.kind}`);
  }
}

function legacySectionsPlainText(sections: readonly unknown[]): string {
  return sections.map(legacySectionText).filter(Boolean).join("\n");
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeDocumentState(value: unknown): "empty" | "editing" | "pendingReview" {
  const kind = isRecord(value) ? value.kind : undefined;
  switch (kind) {
    case "plan":
    case "drafting":
    case "draft":
    case "locked":
    case "editing":
    case "committed":
    case "history":
      return "editing";
    case "review":
    case "pendingReview":
      return "pendingReview";
    default:
      return "empty";
  }
}

function dateText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

async function resolveThreadTableLayout(client: Client): Promise<{
  sql: string;
} | null> {
  const result = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mastra_threads' LIMIT 1",
  );
  if (result.rows.length === 0) return null;

  const tableInfo = await client.execute("PRAGMA table_info(mastra_threads)");
  const columns = new Set(tableInfo.rows.map((row) => String(row.name)));
  // 某些 repo 单测只建立供 JOIN 使用的 id-only 线程桩。没有 metadata 时不可能
  // 存在本迁移候选，语义上仍是零候选；生产表只要有 metadata，就必须能解析资源归属。
  if (!columns.has("metadata")) return null;
  if (!columns.has("id")) throw new Error("0044 mastra_threads.id column is missing");
  const resourceColumn = columns.has("resourceId")
    ? "resourceId"
    : columns.has("resource_id")
      ? "resource_id"
      : null;
  if (!resourceColumn) throw new Error("0044 mastra_threads resource column is missing");
  return { sql: candidateSql(resourceColumn, columns) };
}

async function listCandidates(client: Client, sql: string): Promise<Row[]> {
  const result = await client.execute({
    sql,
    args: [...ELIGIBLE_RESOURCE_IDS],
  });
  return result.rows;
}

function materializeCandidate(row: Row): {
  docId: string;
  threadId: string;
  resourceId: string;
  title: string;
  docState: "empty" | "editing" | "pendingReview";
  docVersion: number;
  lastSyncedVersion: number;
  doc: PmDoc;
  pmJson: string;
  contentHash: string;
  sourceTextHash: string;
  createdAt: string;
  updatedAt: string;
} {
  const metadata = parseMetadata(row.metadata);
  if (!Array.isArray(metadata.legacySections) || metadata.legacySections.length === 0) {
    throw new Error(`0044 candidate lost legacy body: ${String(row.thread_id ?? "")}`);
  }
  if (metadata.doc !== undefined && metadata.doc !== null) {
    throw new Error(`0044 candidate unexpectedly has canonical doc: ${String(row.thread_id ?? "")}`);
  }
  const threadId = requireString(row.thread_id, "thread.id");
  const resourceId = requireString(row.resource_id, "thread.resourceId");
  const docId = metadata.docId === undefined || metadata.docId === null || metadata.docId === ""
    ? threadId
    : requireString(metadata.docId, "metadata.docId");
  const doc = materializeLegacySections(metadata.legacySections as LegacyLegacySection[]);
  const sourceTextHash = textHash(legacySectionsPlainText(metadata.legacySections));
  const materializedTextHash = textHash(pmToPlainText(doc));
  if (materializedTextHash !== sourceTextHash) {
    throw new Error(`0044 legacy text verification failed: ${threadId}`);
  }
  const now = new Date().toISOString();
  const fallbackTime = dateText(metadata.lastPersistedAt, now);
  return {
    docId,
    threadId,
    resourceId,
    title: typeof metadata.title === "string"
      ? metadata.title
      : typeof row.thread_title === "string"
        ? row.thread_title
        : "",
    docState: normalizeDocumentState(metadata.docState),
    docVersion: nonNegativeInteger(metadata.docVersion),
    lastSyncedVersion: nonNegativeInteger(metadata.lastSyncedDocumentSnapshot),
    doc,
    pmJson: getStablePmJson(doc),
    contentHash: getPmContentHash(doc),
    sourceTextHash,
    createdAt: dateText(row.created_at, fallbackTime),
    updatedAt: dateText(row.updated_at, fallbackTime),
  };
}

async function insertAndVerify(client: Client, row: Row): Promise<void> {
  const candidate = materializeCandidate(row);
  const inserted = await client.execute({
    sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash,
        doc_format, version, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pm', 1, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM deleted_sessions WHERE session_id IN (?, ?)
      )`,
    args: [
      candidate.docId,
      candidate.threadId,
      candidate.resourceId,
      candidate.title,
      candidate.docState,
      candidate.docVersion,
      candidate.lastSyncedVersion,
      candidate.pmJson,
      candidate.doc.attrs.schemaVersion,
      candidate.contentHash,
      candidate.createdAt,
      candidate.updatedAt,
      candidate.threadId,
      candidate.docId,
    ],
  });
  if (inserted.rowsAffected !== 1) {
    throw new Error(`0044 document materialization was blocked: ${candidate.threadId}`);
  }

  const stored = await client.execute({
    sql: `SELECT thread_id, doc_pm, doc_schema_version, content_hash, doc_format
      FROM documents WHERE id = ?`,
    args: [candidate.docId],
  });
  const storedRow = stored.rows[0];
  if (!storedRow || typeof storedRow.doc_pm !== "string") {
    throw new Error(`0044 materialized document cannot be read: ${candidate.threadId}`);
  }
  const storedDoc = normalizePmDoc(JSON.parse(storedRow.doc_pm) as unknown);
  if (
    String(storedRow.thread_id ?? "") !== candidate.threadId ||
    Number(storedRow.doc_schema_version ?? 0) !== storedDoc.attrs.schemaVersion ||
    String(storedRow.content_hash ?? "") !== getPmContentHash(storedDoc) ||
    String(storedRow.doc_format ?? "") !== "pm" ||
    textHash(pmToPlainText(storedDoc)) !== candidate.sourceTextHash
  ) {
    throw new Error(`0044 materialized document verification failed: ${candidate.threadId}`);
  }
}

async function up(client: Client): Promise<void> {
  const layout = await resolveThreadTableLayout(client);
  if (!layout) return;

  for (const row of await listCandidates(client, layout.sql)) {
    await insertAndVerify(client, row);
  }

  const remaining = await listCandidates(client, layout.sql);
  if (remaining.length > 0) {
    throw new Error(`0044 legacy thread candidates remain: ${remaining.length}`);
  }
}

export const migration0044MaterializeLegacyThreadDocuments: Migration = {
  id: 44,
  name: "materialize_legacy_thread_documents",
  up,
};
