import type { InStatement, Row } from "@libsql/client";
import type { LegacySection } from "@qingagent/contract-ts";
import {
  getPmContentHash,
  getStablePmJson,
  normalizePmDoc,
  pmToLegacySections,
  type PmDoc,
} from "@qingagent/pm-schema";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

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
  return normalizePmDoc(parsed);
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
  const pmDoc = normalizePmDoc(input.pmDoc);
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

interface LatestDocumentVersionSnapshot {
  docVersion: number;
  snapshotPm: PmDoc;
}

function mapRow(row: Row): MappedDocumentRow {
  const rawDocPm = row.doc_pm;
  const hasPm = typeof rawDocPm === "string" && rawDocPm.trim().length > 0;
  if (!hasPm) {
    throw new Error("Invalid documents.doc_pm: PM document is required");
  }
  const pmDoc = parsePmDoc(rawDocPm);
  const projection = buildPmProjection({ pmDoc });
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
            (SELECT MAX(doc_version) FROM document_versions WHERE doc_id = documents.id),
            documents.doc_version
          )
        )
        OR (
          excluded.doc_version = documents.doc_version
          AND COALESCE(
            (SELECT MAX(doc_version) FROM document_versions WHERE doc_id = documents.id),
            documents.doc_version - 1
          ) < excluded.doc_version
          AND (
            excluded.content_hash IS NOT documents.content_hash
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
    ],
  };
}

async function readyClient() {
  const client = getDocumentsClient();
  await ensureMigrated();
  return client;
}

async function repairPmMirrorIfNeeded(client: Awaited<ReturnType<typeof readyClient>>, mapped: MappedDocumentRow): Promise<void> {
  if (!mapped.needsPmRepair) return;
  if (!mapped.row.pmDoc) return;
  const projection = buildPmProjection({ pmDoc: mapped.row.pmDoc });
  await withWriteRetry(async () => {
    await client.execute({
      sql: `UPDATE documents SET
          doc_pm = ?,
          doc_schema_version = ?,
          content_hash = ?,
          doc_format = ?
        WHERE id = ?`,
      args: [
        projection.pmJson,
        projection.schemaVersion,
        projection.contentHash,
        projection.docFormat,
        mapped.row.id,
      ],
    });
  });
}

async function getLatestVersionSnapshotForDocument(
  client: Awaited<ReturnType<typeof readyClient>>,
  docId: string,
): Promise<LatestDocumentVersionSnapshot | null> {
  const result = await client.execute({
    sql: `SELECT doc_version, content_hash, schema_version, snapshot_pm
      FROM document_versions
      WHERE doc_id = ?
      ORDER BY doc_version DESC
      LIMIT 1`,
    args: [docId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    docVersion: valueAsNumber(row.doc_version),
    snapshotPm: parsePmDoc(row.snapshot_pm),
  };
}

async function repairVersionPointerIfNeeded(
  client: Awaited<ReturnType<typeof readyClient>>,
  mapped: MappedDocumentRow,
): Promise<MappedDocumentRow> {
  const latest = await getLatestVersionSnapshotForDocument(client, mapped.row.id);
  if (!latest || latest.docVersion <= mapped.row.docVersion) return mapped;

  const projection = buildPmProjection({ pmDoc: latest.snapshotPm });
  await withWriteRetry(async () => {
    await client.execute({
      sql: `UPDATE documents SET
          doc_version = ?,
          doc_pm = ?,
          doc_schema_version = ?,
          content_hash = ?,
          doc_format = ?,
          version = version + 1
        WHERE id = ? AND doc_version < ?`,
      args: [
        latest.docVersion,
        projection.pmJson,
        projection.schemaVersion,
        projection.contentHash,
        projection.docFormat,
        mapped.row.id,
        latest.docVersion,
      ],
    });
  });

  return {
    row: {
      ...mapped.row,
      docVersion: latest.docVersion,
      legacySections: projection.legacySections,
      pmDoc: projection.pmDoc,
      schemaVersion: projection.schemaVersion,
      contentHash: projection.contentHash,
      docFormat: projection.docFormat,
      version: mapped.row.version + 1,
    },
    needsPmRepair: false,
  };
}

async function repairDocumentRowIfNeeded(
  client: Awaited<ReturnType<typeof readyClient>>,
  mapped: MappedDocumentRow,
): Promise<DocumentRow> {
  const versionRepaired = await repairVersionPointerIfNeeded(client, mapped);
  await repairPmMirrorIfNeeded(client, versionRepaired);
  return versionRepaired.row;
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
    const mapped = mapRow(row);
    return repairDocumentRowIfNeeded(client, mapped);
  },

  async save(input) {
    const client = await readyClient();
    await withWriteRetry(async () => {
      await client.execute(upsertStatement(input));
    });
  },

  async saveMany(inputs) {
    if (inputs.length === 0) return;
    const client = await readyClient();
    await withWriteRetry(async () => {
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
      rows: await Promise.all(
        rowsResult.rows.map(async (rawRow) => {
          const mapped = mapRow(rawRow);
          return repairDocumentRowIfNeeded(client, mapped);
        }),
      ),
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
  const mapped = await repairVersionPointerIfNeeded(client, mapRow(row));
  await repairPmMirrorIfNeeded(client, mapped);
  return mapped.row;
}
