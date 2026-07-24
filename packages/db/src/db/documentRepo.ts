import type { InStatement, Row } from "@libsql/client";
import type { LegacySection } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  getStablePmJson,
  normalizePmDoc,
  normalizeStoredPmDoc,
  pmToLegacySections,
  type PmDoc,
} from "@qingagent/pm-schema";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import {
  assertDocumentWriteAllowed,
  assertDocumentWriteAllowedPersisted,
} from "./documentWriteGuard.js";

export interface DocumentRow {
  id: string;
  threadId: string;
  resourceId: string;
  title: string;
  docState: string;
  docVersion: number;
  lastSyncedVersion: number;
  legacySections: LegacySection[];
  pmDoc?: PmDoc;
  schemaVersion?: number;
  contentHash?: string;
  docFormat?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSaveInput {
  id: string;
  threadId: string;
  resourceId: string;
  title: string;
  docState: string;
  docVersion: number;
  lastSyncedVersion: number;
  legacySections?: LegacySection[];
  pmDoc: PmDoc;
  schemaVersion?: number;
  contentHash?: string;
  docFormat?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRepo {
  load(id: string): Promise<DocumentRow | null>;
  findIdByThreadId(threadId: string): Promise<string | null>;
  save(input: DocumentSaveInput): Promise<void>;
  saveMany(inputs: DocumentSaveInput[]): Promise<void>;
  list(opts: {
    resourceId: string;
    page?: number;
    perPage?: number;
  }): Promise<{ rows: DocumentRow[]; total: number }>;
  countByResourceId(resourceId: string): Promise<number>;
}

function valueAsString(value: unknown): string {
  return value == null ? "" : String(value);
}

function valueAsNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function parsePmDoc(value: unknown): PmDoc {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid documents.doc_pm: expected JSON string");
  }
  const parsed = JSON.parse(value) as unknown;
  return normalizeStoredPmDoc(parsed);
}

export function projectPmDocToSections(pmDoc: PmDoc): LegacySection[] {
  return pmToLegacySections(pmDoc) as unknown as LegacySection[];
}

interface PmProjection {
  pmDoc: PmDoc;
  pmJson: string;
  legacySections: LegacySection[];
  schemaVersion: number;
  contentHash: string;
  docFormat: string;
}

export function buildPmProjection(input: {
  pmDoc: PmDoc;
}): PmProjection {
  return projectNormalizedPmDoc(normalizePmDoc(input.pmDoc));
}

function projectNormalizedPmDoc(pmDoc: PmDoc): PmProjection {
  const legacySections = projectPmDocToSections(pmDoc);
  return {
    pmDoc,
    pmJson: getStablePmJson(pmDoc),
    legacySections,
    schemaVersion: pmDoc.attrs.schemaVersion,
    contentHash: getPmContentHash(pmDoc),
    docFormat: "pm",
  };
}

interface MappedDocumentRow {
  row: DocumentRow;
  needsPmRepair: boolean;
}

export interface DocumentRepairStats {
  scanned: number;
  versionPointersRepaired: number;
  pmMirrorsRepaired: number;
}

function mapRow(row: Row): MappedDocumentRow {
  const rawDocPm = row.doc_pm;
  const hasPm = typeof rawDocPm === "string" && rawDocPm.trim().length > 0;
  if (!hasPm) {
    throw new Error("Invalid documents.doc_pm: PM document is required");
  }
  const pmDoc = parsePmDoc(rawDocPm);
  const projection = projectNormalizedPmDoc(pmDoc);
  return {
    row: {
      id: valueAsString(row.id),
      threadId: valueAsString(row.thread_id),
      resourceId: valueAsString(row.resource_id),
      title: valueAsString(row.title),
      docState: valueAsString(row.doc_state),
      docVersion: valueAsNumber(row.doc_version),
      lastSyncedVersion: valueAsNumber(row.last_synced_version),
      legacySections: projection.legacySections,
      pmDoc,
      schemaVersion: projection.schemaVersion,
      contentHash: projection.contentHash,
      docFormat: projection.docFormat,
      version: valueAsNumber(row.version),
      createdAt: valueAsString(row.created_at),
      updatedAt: valueAsString(row.updated_at),
    },
    needsPmRepair:
      valueAsString(row.content_hash) !== projection.contentHash ||
      valueAsNumber(row.doc_schema_version) !== projection.schemaVersion ||
      valueAsString(row.doc_format) !== "pm",
  };
}

function upsertStatement(input: DocumentSaveInput): InStatement {
  const projection = buildPmProjection(input);
  return {
    sql: `INSERT INTO documents (
        id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version,
        content_hash, doc_format, version, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM deleted_sessions
        WHERE session_id IN (?, ?)
      )
      ON CONFLICT(id) DO UPDATE SET
        thread_id = excluded.thread_id,
        resource_id = excluded.resource_id,
        title = excluded.title,
        doc_state = excluded.doc_state,
        doc_version = excluded.doc_version,
        last_synced_version = excluded.last_synced_version,
        doc_pm = excluded.doc_pm,
        doc_schema_version = excluded.doc_schema_version,
        content_hash = excluded.content_hash,
        doc_format = excluded.doc_format,
        version = documents.version + 1,
        updated_at = excluded.updated_at
      WHERE
        excluded.doc_version > MAX(
          documents.doc_version,
          COALESCE(
            (SELECT MAX(version.doc_version)
              FROM document_versions version
              WHERE version.doc_id = documents.id
                AND NOT EXISTS (
                  SELECT 1 FROM document_version_restore_origins origin
                  WHERE origin.version_id = version.version_id
                    AND origin.restored_doc_id = version.doc_id
                    AND origin.source_doc_id <> version.doc_id
                )),
            documents.doc_version
          )
        )
        OR (
          excluded.doc_version = documents.doc_version
          AND COALESCE(
            (SELECT MAX(version.doc_version)
              FROM document_versions version
              WHERE version.doc_id = documents.id
                AND NOT EXISTS (
                  SELECT 1 FROM document_version_restore_origins origin
                  WHERE origin.version_id = version.version_id
                    AND origin.restored_doc_id = version.doc_id
                    AND origin.source_doc_id <> version.doc_id
                )),
            documents.doc_version - 1
          ) < excluded.doc_version
          AND (
            excluded.content_hash IS NOT documents.content_hash
            OR excluded.title IS NOT documents.title
            OR excluded.doc_state IS NOT documents.doc_state
            OR excluded.last_synced_version IS NOT documents.last_synced_version
          )
        )`,
    args: [
      input.id,
      input.threadId,
      input.resourceId,
      input.title,
      input.docState,
      input.docVersion,
      input.lastSyncedVersion,
      projection.pmJson,
      projection.schemaVersion,
      projection.contentHash,
      projection.docFormat,
      input.createdAt,
      input.updatedAt,
      input.threadId,
      input.id,
    ],
  };
}

async function readyClient() {
  const client = getDocumentsClient();
  await ensureMigrated();
  return client;
}

async function repairPmMirrorIfNeeded(client: Awaited<ReturnType<typeof readyClient>>, mapped: MappedDocumentRow): Promise<boolean> {
  if (!mapped.needsPmRepair) return false;
  if (!mapped.row.pmDoc) return false;
  const projection = buildPmProjection({ pmDoc: mapped.row.pmDoc });
  return withWriteRetry(async () => {
    const result = await client.execute({
      sql: `UPDATE documents SET
          doc_pm = ?,
          doc_schema_version = ?,
          content_hash = ?,
          doc_format = ?
        WHERE id = ? AND version = ?`,
      args: [
        projection.pmJson,
        projection.schemaVersion,
        projection.contentHash,
        projection.docFormat,
        mapped.row.id,
        mapped.row.version,
      ],
    });
    return result.rowsAffected === 1;
  });
}

/**
 * 在启动后的后台巡检中修复存量 documents 行。
 *
 * 读 API 必须保持纯读：不能为了偶发的旧数据修复，在每次 load/list 上抢写锁。
 * 此处一次查询带回每篇文档的最新版本快照，再按需写回，因此不把逐行 SELECT
 * 带回列表读取路径。
 */
export async function repairStoredDocumentRows(): Promise<DocumentRepairStats> {
  const client = await readyClient();
  const result = await client.execute(`SELECT
      d.*,
      dv.version_id AS latest_version_id,
      dv.doc_version AS latest_doc_version,
      dv.snapshot_pm AS latest_snapshot_pm,
      origin.source_doc_id AS latest_source_doc_id,
      origin.source_thread_id AS latest_source_thread_id,
      EXISTS (
        SELECT 1 FROM document_write_blocks write_block
        WHERE write_block.doc_id = d.id
          AND write_block.reason = 'quarantine_0002_foreign_snapshot'
      ) AS recovery_write_blocked
    FROM documents d
    LEFT JOIN document_versions dv ON dv.doc_id = d.id
      AND NOT EXISTS (
        SELECT 1 FROM document_version_restore_origins foreign_origin
        WHERE foreign_origin.version_id = dv.version_id
          AND foreign_origin.restored_doc_id = dv.doc_id
          AND foreign_origin.source_doc_id <> dv.doc_id
      )
      AND dv.doc_version = (
        SELECT MAX(version.doc_version)
        FROM document_versions version
        WHERE version.doc_id = d.id
          AND NOT EXISTS (
            SELECT 1 FROM document_version_restore_origins foreign_origin
            WHERE foreign_origin.version_id = version.version_id
              AND foreign_origin.restored_doc_id = version.doc_id
              AND foreign_origin.source_doc_id <> version.doc_id
          )
      )
    LEFT JOIN document_version_restore_origins origin
      ON origin.version_id = dv.version_id
      AND origin.restored_doc_id = d.id`);

  let versionPointersRepaired = 0;
  let pmMirrorsRepaired = 0;
  for (const rawRow of result.rows) {
    const mapped = mapRow(rawRow);
    const latestDocVersion = valueAsNumber(rawRow.latest_doc_version);
    const latestSnapshotPm = rawRow.latest_snapshot_pm;
    const sourceDocId = rawRow.latest_source_doc_id == null
      ? null
      : String(rawRow.latest_source_doc_id);
    const sourceThreadId = rawRow.latest_source_thread_id == null
      ? null
      : String(rawRow.latest_source_thread_id);
    const isForeignRestoredFamily = sourceDocId !== null
      && sourceDocId !== mapped.row.id;
    let current = mapped;

    // 0025 已确认正文曾被异源快照覆盖时，巡检也必须遵守持久化写阻断。
    // 读取仍可继续，直到运维从 pre-0023 备份核验恢复并显式解除阻断。
    if (valueAsNumber(rawRow.recovery_write_blocked) === 1) continue;

    if (latestSnapshotPm != null && latestDocVersion > mapped.row.docVersion) {
      if (isForeignRestoredFamily) {
        console.warn("[db:repair] 跳过异历史家族的高版本快照", {
          docId: mapped.row.id,
          threadId: mapped.row.threadId,
          currentDocVersion: mapped.row.docVersion,
          candidateVersionId: String(rawRow.latest_version_id ?? ""),
          candidateDocVersion: latestDocVersion,
          sourceDocId,
          sourceThreadId,
        });
      } else {
        const snapshotPm = parsePmDoc(latestSnapshotPm);
        const projection = buildPmProjection({ pmDoc: snapshotPm });
        await withWriteRetry(async () => {
          await client.execute({
            sql: `UPDATE documents SET
                doc_version = ?, doc_pm = ?, doc_schema_version = ?, content_hash = ?,
                doc_format = ?, version = version + 1
              WHERE id = ? AND doc_version < ?`,
            args: [
              latestDocVersion,
              projection.pmJson,
              projection.schemaVersion,
              projection.contentHash,
              projection.docFormat,
              mapped.row.id,
              latestDocVersion,
            ],
          });
        });
        current = {
          row: {
            ...mapped.row,
            docVersion: latestDocVersion,
            legacySections: projection.legacySections,
            pmDoc: projection.pmDoc,
            schemaVersion: projection.schemaVersion,
            contentHash: projection.contentHash,
            docFormat: projection.docFormat,
            version: mapped.row.version + 1,
          },
          needsPmRepair: false,
        };
        versionPointersRepaired += 1;
      }
    }

    if (current.needsPmRepair) {
      if (await repairPmMirrorIfNeeded(client, current)) {
        pmMirrorsRepaired += 1;
      }
    }
  }
  return { scanned: result.rows.length, versionPointersRepaired, pmMirrorsRepaired };
}

export const documentRepo: DocumentRepo = {
  async load(id) {
    const client = await readyClient();
    const result = await client.execute({
      sql: `SELECT * FROM documents WHERE id = ?`,
      args: [id],
    });
    const row = result.rows[0];
    if (!row) return null;
    return mapRow(row).row;
  },

  async findIdByThreadId(threadId) {
    const client = await readyClient();
    const result = await client.execute({
      sql: `SELECT id FROM documents
        WHERE thread_id = ? AND role = 'main'
        ORDER BY updated_at DESC
        LIMIT 1`,
      args: [threadId],
    });
    return result.rows[0]?.id == null ? null : String(result.rows[0].id);
  },

  async save(input) {
    const client = await readyClient();
    await withWriteRetry(async () => {
      assertDocumentWriteAllowed({
        docId: input.id,
        threadId: input.threadId,
        operation: "document.save",
      });
      await assertDocumentWriteAllowedPersisted(client, {
        docId: input.id,
        threadId: input.threadId,
        operation: "document.save",
      });
      await client.execute(upsertStatement(input));
    });
  },

  async saveMany(inputs) {
    if (inputs.length === 0) return;
    const client = await readyClient();
    await withWriteRetry(async () => {
      for (const input of inputs) {
        assertDocumentWriteAllowed({
          docId: input.id,
          threadId: input.threadId,
          operation: "document.saveMany",
        });
        await assertDocumentWriteAllowedPersisted(client, {
          docId: input.id,
          threadId: input.threadId,
          operation: "document.saveMany",
        });
      }
      await client.batch(inputs.map(upsertStatement), "write");
    });
  },

  async list(opts) {
    const client = await readyClient();
    const page = opts.page ?? 0;
    const perPage = opts.perPage ?? 50;
    const offset = page * perPage;
    const [countResult, rowsResult] = await Promise.all([
      client.execute({
        sql: `SELECT COUNT(*) AS total FROM documents WHERE resource_id = ? AND role = 'main'`,
        args: [opts.resourceId],
      }),
      client.execute({
        sql: `SELECT * FROM documents
          WHERE resource_id = ? AND role = 'main'
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?`,
        args: [opts.resourceId, perPage, offset],
      }),
    ]);
    return {
      rows: rowsResult.rows.map((rawRow) => mapRow(rawRow).row),
      total: valueAsNumber(countResult.rows[0]?.total),
    };
  },

  async countByResourceId(resourceId) {
    const client = await readyClient();
    const result = await client.execute({
      sql: `SELECT COUNT(*) AS total FROM documents WHERE resource_id = ? AND role = 'main'`,
      args: [resourceId],
    });
    return valueAsNumber(result.rows[0]?.total);
  },
};

export async function loadMainDocumentByThread(threadId: string): Promise<DocumentRow | null> {
  const client = await readyClient();
  const result = await client.execute({
    sql: "SELECT * FROM documents WHERE thread_id = ? AND role = 'main' LIMIT 1",
    args: [threadId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return mapRow(row).row;
}
