import type { Client, Row } from "@libsql/client";
import {
  getStablePmJson,
  type PmDoc,
} from "@qingagent/pm-schema";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { parsePmDoc } from "./documentRepo.js";
import { ensureMigrated } from "./migrations.js";

export type DocumentVersionActorType = "user" | "agent" | "system" | "restore-rescue";

export interface DocumentVersionRow {
  versionId: string;
  docId: string;
  docVersion: number;
  contentHash: string;
  schemaVersion: number;
  actorType: DocumentVersionActorType;
  summary: string | null;
  snapshotPm: PmDoc;
  parentVersion: number | null;
  createdAt: string;
}

export interface InsertDocumentVersionInput {
  versionId: string;
  docId: string;
  docVersion: number;
  contentHash: string;
  schemaVersion: number;
  actorType: DocumentVersionActorType;
  summary?: string | null;
  snapshotPm: PmDoc;
  parentVersion: number | null;
  createdAt: string;
}

export interface RollDocumentVersionRowInput {
  versionId: string;
  docId: string;
  docVersion: number;
  contentHash: string;
  schemaVersion: number;
  snapshotPm: PmDoc;
}

function valueAsString(value: unknown): string {
  return value == null ? "" : String(value);
}

function valueAsNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function valueAsNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function valueAsNullableNumber(value: unknown): number | null {
  return value == null ? null : valueAsNumber(value);
}

async function readyClient(client?: Client): Promise<Client> {
  const c = client ?? getDocumentsClient();
  await ensureMigrated();
  return c;
}

function mapVersionRow(row: Row): DocumentVersionRow {
  return {
    versionId: valueAsString(row.version_id),
    docId: valueAsString(row.doc_id),
    docVersion: valueAsNumber(row.doc_version),
    contentHash: valueAsString(row.content_hash),
    schemaVersion: valueAsNumber(row.schema_version),
    actorType: valueAsString(row.actor_type) as DocumentVersionActorType,
    summary: valueAsNullableString(row.summary),
    snapshotPm: parsePmDoc(row.snapshot_pm),
    parentVersion: valueAsNullableNumber(row.parent_version),
    createdAt: valueAsString(row.created_at),
  };
}

export async function insertVersion(
  input: InsertDocumentVersionInput,
  client?: Client,
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    await c.execute({
      sql: `INSERT INTO document_versions (
          version_id, doc_id, doc_version, content_hash, schema_version,
          actor_type, summary, snapshot_pm, parent_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.versionId,
        input.docId,
        input.docVersion,
        input.contentHash,
        input.schemaVersion,
        input.actorType,
        input.summary ?? null,
        getStablePmJson(input.snapshotPm),
        input.parentVersion,
        input.createdAt,
      ],
    });
  });
}

export async function listVersions(
  docId: string,
  client?: Client,
): Promise<DocumentVersionRow[]> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: `SELECT * FROM document_versions
      WHERE doc_id = ?
      ORDER BY doc_version DESC`,
    args: [docId],
  });
  return result.rows.map(mapVersionRow);
}

export async function getLatestVersionSnapshot(
  docId: string,
  client?: Client,
): Promise<DocumentVersionRow | null> {
  return getLatestVersionRow(docId, client);
}

export async function getLatestVersionRow(
  docId: string,
  client?: Client,
): Promise<DocumentVersionRow | null> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: `SELECT * FROM document_versions
      WHERE doc_id = ?
      ORDER BY doc_version DESC
      LIMIT 1`,
    args: [docId],
  });
  const row = result.rows[0];
  return row ? mapVersionRow(row) : null;
}

export async function rollVersionRow(
  input: RollDocumentVersionRowInput,
  client?: Client,
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    const result = await c.execute({
      sql: `UPDATE document_versions SET
          doc_version = ?,
          content_hash = ?,
          schema_version = ?,
          snapshot_pm = ?
        WHERE version_id = ? AND doc_id = ?`,
      args: [
        input.docVersion,
        input.contentHash,
        input.schemaVersion,
        getStablePmJson(input.snapshotPm),
        input.versionId,
        input.docId,
      ],
    });
    if (result.rowsAffected === 0) {
      throw new Error(`document_versions row not found for roll: ${input.versionId}`);
    }
  });
}

export async function getMaxDocumentSnapshotVersion(
  docId: string,
  client?: Client,
): Promise<number | null> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: "SELECT MAX(doc_version) AS max_doc_version FROM document_versions WHERE doc_id = ?",
    args: [docId],
  });
  return valueAsNullableNumber(result.rows[0]?.max_doc_version);
}

export async function getMinDocumentSnapshotVersion(
  docId: string,
  client?: Client,
): Promise<number | null> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: "SELECT MIN(doc_version) AS min_doc_version FROM document_versions WHERE doc_id = ?",
    args: [docId],
  });
  return valueAsNullableNumber(result.rows[0]?.min_doc_version);
}

export async function getVersionSnapshot(
  versionId: string,
  client?: Client,
): Promise<DocumentVersionRow | null> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: `SELECT * FROM document_versions WHERE version_id = ?`,
    args: [versionId],
  });
  const row = result.rows[0];
  return row ? mapVersionRow(row) : null;
}

export async function getVersionSnapshotByDocumentSnapshot(
  docId: string,
  docVersion: number,
  client?: Client,
): Promise<DocumentVersionRow | null> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: `SELECT * FROM document_versions
      WHERE doc_id = ? AND doc_version = ?`,
    args: [docId, docVersion],
  });
  const row = result.rows[0];
  return row ? mapVersionRow(row) : null;
}
