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
import {
  commitTransaction,
  getDocumentsClient,
  rollbackTransaction,
  withTransaction,
  withWriteRetry,
} from "./documentsClient.js";
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
  existsByIds(resourceId: string, ids: string[]): Promise<Set<string>>;
  save(input: DocumentSaveInput): Promise<void>;
  saveMany(inputs: DocumentSaveInput[]): Promise<void>;
  list(opts: {
    resourceId: string;
    page?: number;
    perPage?: number;
    offset?: number;
  }): Promise<{ rows: DocumentRow[]; total: number }>;
  listWithExistingThreads(opts: {
    resourceId: string;
    page?: number;
    perPage?: number;
    offset?: number;
  }): Promise<{ rows: DocumentRow[]; total: number }>;
  countByResourceId(resourceId: string): Promise<number>;
}

const MAX_EXISTS_BY_IDS = 50;

/**
 * Mastra 的 memory domain 会在首次存储调用时创建 threads 表。新库初始化完成前，
 * documents 读路径应把缺表视为“还没有任何 thread”，不能吞掉其他 SQL 错误。
 */
export function isMissingMastraThreadsTableError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current != null && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error
      ? current.message
      : typeof current === "string"
        ? current
        : "";
    if (/no such table:\s*(?:[\w-]+\.)?mastra_threads\b/i.test(message)) {
      return true;
    }
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return false;
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
  invalidRowsQuarantined: number;
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

type InvalidPmReason = "missing_pm" | "invalid_pm";

function invalidPmReason(row: Row): InvalidPmReason {
  return typeof row.doc_pm !== "string" || row.doc_pm.trim().length === 0
    ? "missing_pm"
    : "invalid_pm";
}

interface InvalidPmCandidate {
  id: string;
  version: number;
  docPm: string | null;
  reason: InvalidPmReason;
}

const QUARANTINE_BATCH_SIZE = 200;
const MAX_LIST_PAGE_FETCH_ROUNDS = 2;

function invalidPmCandidate(row: Row): InvalidPmCandidate {
  return {
    id: valueAsString(row.id),
    version: valueAsNumber(row.version),
    docPm: typeof row.doc_pm === "string" ? row.doc_pm : null,
    reason: invalidPmReason(row),
  };
}

function invalidPmCandidateKey(candidate: Pick<InvalidPmCandidate, "id" | "version">): string {
  return `${candidate.id}\u0000${candidate.version}`;
}

function sqlInvalidPmCondition(alias: string): string {
  return `(
    ${alias}.doc_pm IS NULL
    OR trim(${alias}.doc_pm) = ''
    OR NOT json_valid(${alias}.doc_pm)
  )`;
}

function sqlValidPmCondition(alias: string): string {
  return `(
    ${alias}.doc_pm IS NOT NULL
    AND trim(${alias}.doc_pm) <> ''
    AND json_valid(${alias}.doc_pm)
  )`;
}

async function quarantineInvalidPmRows(rows: Row[]): Promise<Set<string>> {
  const candidates = [...new Map(rows.map((row) => {
    const candidate = invalidPmCandidate(row);
    return [invalidPmCandidateKey(candidate), candidate];
  })).values()];
  if (candidates.length === 0) return new Set();

  return withTransaction(async (client) => {
    const quarantined = new Set<string>();
    for (let start = 0; start < candidates.length; start += QUARANTINE_BATCH_SIZE) {
      const chunk = candidates.slice(start, start + QUARANTINE_BATCH_SIZE);
      const values = chunk.map(() => "(?, ?, ?, ?)").join(", ");
      const args = chunk.flatMap((candidate) => [
        candidate.id,
        candidate.version,
        candidate.docPm,
        candidate.reason,
      ]);
      const inserted = await client.execute({
        sql: `WITH candidates(id, version, doc_pm, reason) AS (
            VALUES ${values}
          )
          INSERT INTO documents_quarantine_invalid_pm (
            id, thread_id, resource_id, title, doc_state, doc_version,
            last_synced_version, doc_pm, doc_schema_version, content_hash,
            doc_format, version, created_at, updated_at, role, reason
          )
          SELECT
            d.id, d.thread_id, d.resource_id, d.title, d.doc_state, d.doc_version,
            d.last_synced_version, d.doc_pm, d.doc_schema_version, d.content_hash,
            d.doc_format, d.version, d.created_at, d.updated_at, d.role, candidates.reason
          FROM documents d
          INNER JOIN candidates
            ON candidates.id = d.id
            AND candidates.version = d.version
            AND d.doc_pm IS candidates.doc_pm`,
        args,
      });
      const deleted = await client.execute({
        sql: `WITH candidates(id, version, doc_pm, reason) AS (
            VALUES ${values}
          )
          DELETE FROM documents
          WHERE EXISTS (
            SELECT 1
            FROM candidates
            WHERE candidates.id = documents.id
              AND candidates.version = documents.version
              AND documents.doc_pm IS candidates.doc_pm
          )
          RETURNING id, version`,
        args,
      });
      if (inserted.rowsAffected !== deleted.rows.length) {
        return rollbackTransaction(new Set<string>());
      }
      for (const row of deleted.rows) {
        quarantined.add(invalidPmCandidateKey({
          id: valueAsString(row.id),
          version: valueAsNumber(row.version),
        }));
      }
    }
    return commitTransaction(quarantined);
  });
}

async function quarantineInvalidPmRow(row: Row): Promise<boolean> {
  const candidate = invalidPmCandidate(row);
  const quarantined = await quarantineInvalidPmRows([row]);
  return quarantined.has(invalidPmCandidateKey(candidate));
}

async function mapRowOrQuarantine(
  client: Awaited<ReturnType<typeof readyClient>>,
  rawRow: Row,
): Promise<DocumentRow | null> {
  try {
    return mapRow(rawRow).row;
  } catch {
    if (await quarantineInvalidPmRow(rawRow)) return null;
    const refreshed = await client.execute({
      sql: "SELECT * FROM documents WHERE id = ?",
      args: [valueAsString(rawRow.id)],
    });
    const current = refreshed.rows[0];
    return current ? mapRow(current).row : null;
  }
}

async function mapRowsAndQuarantine(
  client: Awaited<ReturnType<typeof readyClient>>,
  rows: Row[],
): Promise<{ rows: DocumentRow[]; quarantined: number }> {
  const mappedRows: Array<DocumentRow | null> = Array.from(
    { length: rows.length },
    () => null,
  );
  const invalidRows: Array<{ index: number; row: Row; candidate: InvalidPmCandidate }> = [];
  for (const [index, rawRow] of rows.entries()) {
    try {
      mappedRows[index] = mapRow(rawRow).row;
    } catch {
      invalidRows.push({ index, row: rawRow, candidate: invalidPmCandidate(rawRow) });
    }
  }

  const quarantinedKeys = await quarantineInvalidPmRows(
    invalidRows.map(({ row }) => row),
  );
  for (const invalid of invalidRows) {
    if (quarantinedKeys.has(invalidPmCandidateKey(invalid.candidate))) continue;
    const refreshed = await client.execute({
      sql: "SELECT * FROM documents WHERE id = ?",
      args: [invalid.candidate.id],
    });
    const current = refreshed.rows[0];
    mappedRows[invalid.index] = current
      ? await mapRowOrQuarantine(client, current)
      : null;
  }
  return {
    rows: mappedRows.filter((row): row is DocumentRow => row !== null),
    quarantined: quarantinedKeys.size,
  };
}

interface DocumentListScope {
  fromSql: string;
  whereSql: string;
  args: string[];
}

/**
 * 列表 total 对深层坏 PM 采用“单调收敛”契约：隔离是搬迁式的，坏行一经页面读取发现，
 * 就永久移出 documents 查询域；尚未访问到的深层坏行可瞬时计入 total，之后会随对应
 * 页面被访问而自动收敛。这样设计是因为 SQL 可廉价预筛空值和非法 JSON，却无法廉价
 * 判定完整 PM 结构是否合法。
 */
async function listDocumentPage(
  client: Awaited<ReturnType<typeof readyClient>>,
  scope: DocumentListScope,
  offset: number,
  perPage: number,
): Promise<{ rows: DocumentRow[]; total: number }> {
  const invalidResult = await client.execute({
    sql: `SELECT d.id, d.version, d.doc_pm
      FROM ${scope.fromSql}
      WHERE ${scope.whereSql}
        AND ${sqlInvalidPmCondition("d")}`,
    args: scope.args,
  });
  await quarantineInvalidPmRows(invalidResult.rows);

  for (let round = 0; round < MAX_LIST_PAGE_FETCH_ROUNDS; round += 1) {
    const [countResult, rowsResult] = await Promise.all([
      client.execute({
        sql: `SELECT COUNT(*) AS total
          FROM ${scope.fromSql}
          WHERE ${scope.whereSql}
            AND ${sqlValidPmCondition("d")}`,
        args: scope.args,
      }),
      client.execute({
        sql: `SELECT d.*
          FROM ${scope.fromSql}
          WHERE ${scope.whereSql}
            AND ${sqlValidPmCondition("d")}
          ORDER BY d.updated_at DESC, d.id ASC
          LIMIT ? OFFSET ?`,
        args: [...scope.args, perPage, offset],
      }),
    ]);
    const mapped = await mapRowsAndQuarantine(client, rowsResult.rows);
    const total = Math.max(
      0,
      valueAsNumber(countResult.rows[0]?.total) - mapped.quarantined,
    );
    const shouldRefill = mapped.quarantined > 0 &&
      round + 1 < MAX_LIST_PAGE_FETCH_ROUNDS;
    if (!shouldRefill) {
      return {
        rows: mapped.rows,
        total,
      };
    }
  }

  throw new Error("Unreachable document list fetch round");
}

function contentUpsertStatement(input: DocumentSaveInput): InStatement {
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
          AND excluded.content_hash IS NOT documents.content_hash
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

function metadataUpdateStatement(input: DocumentSaveInput): InStatement {
  const projection = buildPmProjection(input);
  return {
    sql: `UPDATE documents SET
        title = ?,
        doc_state = ?,
        last_synced_version = ?,
        updated_at = ?
      WHERE id = ?
        AND doc_version = ?
        AND content_hash IS ?
        AND (
          title IS NOT ?
          OR doc_state IS NOT ?
          OR last_synced_version IS NOT ?
        )`,
    args: [
      input.title,
      input.docState,
      input.lastSyncedVersion,
      input.updatedAt,
      input.id,
      input.docVersion,
      projection.contentHash,
      input.title,
      input.docState,
      input.lastSyncedVersion,
    ],
  };
}

async function readyClient() {
  const client = getDocumentsClient();
  await ensureMigrated();
  return client;
}

async function assertZeroWriteIsResolved(
  client: Awaited<ReturnType<typeof readyClient>>,
  input: DocumentSaveInput,
): Promise<void> {
  const projection = buildPmProjection(input);
  const result = await client.execute({
    sql: `SELECT title, doc_state, doc_version, last_synced_version, content_hash
      FROM documents WHERE id = ?`,
    args: [input.id],
  });
  const row = result.rows[0];
  if (!row) throw new Error(`文档保存未写入：${input.id}`);
  const currentVersion = valueAsNumber(row.doc_version);
  if (currentVersion > input.docVersion) return;
  if (
    currentVersion === input.docVersion &&
    valueAsString(row.content_hash) === projection.contentHash &&
    valueAsString(row.title) === input.title &&
    valueAsString(row.doc_state) === input.docState &&
    valueAsNumber(row.last_synced_version) === input.lastSyncedVersion
  ) return;
  throw new Error(`文档保存未写入：版本或正文高水位冲突（${input.id}）`);
}

async function saveDocumentInputs(
  client: Awaited<ReturnType<typeof readyClient>>,
  inputs: DocumentSaveInput[],
): Promise<void> {
  const results = await client.batch(
    inputs.flatMap((input) => [
      contentUpsertStatement(input),
      metadataUpdateStatement(input),
    ]),
    "write",
  );
  for (const [index, input] of inputs.entries()) {
    const contentResult = results[index * 2];
    const metadataResult = results[index * 2 + 1];
    if (!contentResult || !metadataResult) {
      throw new Error(`文档保存未返回完整结果：${input.id}`);
    }
    if (contentResult.rowsAffected === 0 && metadataResult.rowsAffected === 0) {
      await assertZeroWriteIsResolved(client, input);
    }
  }
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
  let invalidRowsQuarantined = 0;
  for (const rawRow of result.rows) {
    let mapped: MappedDocumentRow;
    try {
      mapped = mapRow(rawRow);
    } catch {
      if (await quarantineInvalidPmRow(rawRow)) invalidRowsQuarantined += 1;
      continue;
    }
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
  return {
    scanned: result.rows.length,
    versionPointersRepaired,
    pmMirrorsRepaired,
    invalidRowsQuarantined,
  };
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
    return mapRowOrQuarantine(client, row);
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

  async existsByIds(resourceId, ids) {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return new Set();
    if (uniqueIds.length > MAX_EXISTS_BY_IDS) {
      throw new Error(`documentRepo.existsByIds 最多查询 ${MAX_EXISTS_BY_IDS} 个 id`);
    }
    const client = await readyClient();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    try {
      const result = await client.execute({
        // 只取指定资源且 thread 仍存在的主文档主键；禁止退化成 documents 全行扫描。
        sql: `SELECT d.id FROM documents d
          INNER JOIN mastra_threads t ON t.id = d.thread_id
          WHERE d.resource_id = ? AND d.role = 'main' AND d.id IN (${placeholders})`,
        args: [resourceId, ...uniqueIds],
      });
      return new Set(result.rows.map((row) => valueAsString(row.id)));
    } catch (error) {
      if (isMissingMastraThreadsTableError(error)) return new Set();
      throw error;
    }
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
      await saveDocumentInputs(client, [input]);
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
      await saveDocumentInputs(client, inputs);
    });
  },

  async list(opts) {
    const client = await readyClient();
    const page = opts.page ?? 0;
    const perPage = opts.perPage ?? 50;
    const offset = opts.offset ?? page * perPage;
    return listDocumentPage(client, {
      fromSql: "documents d",
      whereSql: "d.resource_id = ? AND d.role = 'main'",
      args: [opts.resourceId],
    }, offset, perPage);
  },

  async listWithExistingThreads(opts) {
    const client = await readyClient();
    const page = opts.page ?? 0;
    const perPage = opts.perPage ?? 50;
    const offset = opts.offset ?? page * perPage;
    try {
      return await listDocumentPage(client, {
        fromSql: `documents d
          INNER JOIN mastra_threads t ON t.id = d.thread_id`,
        whereSql: "d.resource_id = ? AND d.role = 'main'",
        args: [opts.resourceId],
      }, offset, perPage);
    } catch (error) {
      if (isMissingMastraThreadsTableError(error)) {
        return { rows: [], total: 0 };
      }
      throw error;
    }
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
  return mapRowOrQuarantine(client, row);
}
