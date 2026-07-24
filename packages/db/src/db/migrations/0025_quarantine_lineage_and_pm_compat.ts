import type { Client } from "@libsql/client";
import {
  getPmContentHash,
  getStablePmJson,
  normalizeLegacyListItemFirstChildPmDoc,
  normalizeStoredPmDoc,
} from "@qingagent/pm-schema";
import type { Migration } from "./types.js";

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function createRecoveryTables(client: Client): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS document_write_blocks (
      doc_id            TEXT PRIMARY KEY,
      reason            TEXT NOT NULL,
      source_doc_id     TEXT NOT NULL,
      source_thread_id  TEXT NOT NULL,
      version_id        TEXT NOT NULL,
      detected_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS document_recovery_audits (
      doc_id                  TEXT NOT NULL,
      version_id              TEXT NOT NULL,
      reason                  TEXT NOT NULL,
      source_doc_id           TEXT NOT NULL,
      source_thread_id        TEXT NOT NULL,
      current_doc_version     INTEGER,
      isolated_doc_version    INTEGER NOT NULL,
      current_content_hash    TEXT,
      snapshot_content_hash   TEXT,
      stored_version_hash     TEXT NOT NULL,
      exact_snapshot_match    INTEGER NOT NULL DEFAULT 0,
      native_snapshot_match   INTEGER NOT NULL DEFAULT 0,
      native_op_match         INTEGER NOT NULL DEFAULT 0,
      review_status           TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'confirmed', 'dismissed')),
      reviewed_at             TEXT,
      review_note             TEXT,
      detected_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (doc_id, version_id, reason)
    )`,
    `CREATE TABLE IF NOT EXISTS document_versions_quarantine_0025 (
      version_id        TEXT PRIMARY KEY,
      doc_id            TEXT NOT NULL,
      doc_version       INTEGER NOT NULL,
      content_hash      TEXT NOT NULL,
      schema_version    INTEGER NOT NULL,
      actor_type        TEXT NOT NULL,
      summary           TEXT,
      snapshot_pm       TEXT NOT NULL,
      parent_version    INTEGER,
      created_at        TEXT NOT NULL,
      restored_doc_id   TEXT NOT NULL,
      source_doc_id     TEXT NOT NULL,
      source_thread_id  TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS document_ops_quarantine_0025 (
      op_id               TEXT PRIMARY KEY,
      doc_id              TEXT NOT NULL,
      op_kind             TEXT NOT NULL,
      client_mutation_id  TEXT,
      steps               TEXT,
      from_version        INTEGER NOT NULL,
      to_version          INTEGER NOT NULL,
      actor_type          TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      restored_doc_id     TEXT NOT NULL,
      source_doc_id       TEXT NOT NULL,
      source_thread_id    TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS document_drafts_quarantine_0025 (
      restored_doc_id     TEXT NOT NULL,
      doc_id              TEXT NOT NULL,
      thread_id           TEXT NOT NULL,
      base_version        INTEGER NOT NULL,
      base_hash           TEXT NOT NULL,
      draft_pm            TEXT NOT NULL,
      status              TEXT NOT NULL,
      conflict_json       TEXT,
      review_batch_id     TEXT,
      group_mode          TEXT,
      source_stream_id    TEXT,
      source_tool_call_id TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      batch_id            TEXT NOT NULL,
      source_doc_id       TEXT NOT NULL,
      source_thread_id    TEXT NOT NULL,
      PRIMARY KEY (
        restored_doc_id, source_doc_id, base_version, base_hash, created_at
      )
    )`,
    `CREATE TABLE IF NOT EXISTS document_suggestions_quarantine_0025 (
      id                  TEXT NOT NULL,
      doc_id              TEXT NOT NULL,
      base_version        INTEGER NOT NULL,
      batch_id            TEXT NOT NULL,
      status              TEXT NOT NULL,
      anchor_json         TEXT NOT NULL,
      steps_json          TEXT,
      preview_json        TEXT,
      summary             TEXT NOT NULL,
      conflict_json       TEXT,
      kind                TEXT NOT NULL,
      note                TEXT,
      origin              TEXT,
      group_id            TEXT,
      group_meta_json     TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      severity            TEXT,
      restored_doc_id     TEXT NOT NULL,
      source_doc_id       TEXT NOT NULL,
      source_thread_id    TEXT NOT NULL,
      PRIMARY KEY (
        restored_doc_id, source_doc_id, base_version, batch_id, id
      )
    )`,
    `CREATE INDEX IF NOT EXISTS idx_document_write_blocks_reason
      ON document_write_blocks (reason, doc_id)`,
    `CREATE INDEX IF NOT EXISTS idx_document_recovery_audits_status
      ON document_recovery_audits (review_status, reason, doc_id)`,
    `CREATE INDEX IF NOT EXISTS idx_document_versions_quarantine_0025_source
      ON document_versions_quarantine_0025 (source_doc_id, doc_version)`,
    `CREATE INDEX IF NOT EXISTS idx_document_ops_quarantine_0025_source
      ON document_ops_quarantine_0025 (source_doc_id, to_version)`,
    `CREATE INDEX IF NOT EXISTS idx_document_drafts_quarantine_0025_source
      ON document_drafts_quarantine_0025 (source_doc_id)`,
    `CREATE INDEX IF NOT EXISTS idx_document_suggestions_quarantine_0025_source
      ON document_suggestions_quarantine_0025 (source_doc_id, base_version)`,
  ];
  for (const sql of statements) await client.execute(sql);
}

interface ForeignVersionIsolationEvidence {
  versionId: string;
  restoredDocId: string;
  docVersion: number;
  storedContentHash: string;
  snapshotPm: string;
  sourceDocId: string;
  sourceThreadId: string;
}

interface PmEvidence {
  stableJson: string;
  contentHash: string;
}

function getPmEvidence(value: unknown): PmEvidence | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return {
      stableJson: getStablePmJson(parsed),
      contentHash: getPmContentHash(parsed),
    };
  } catch {
    return null;
  }
}

async function classifyRemovedForeignVersions(
  client: Client,
  removed: readonly ForeignVersionIsolationEvidence[],
): Promise<void> {
  for (const evidence of removed) {
    const currentResult = await client.execute({
      sql: `SELECT doc_version, doc_pm
        FROM documents
        WHERE id = ?
        LIMIT 1`,
      args: [evidence.restoredDocId],
    });
    const current = currentResult.rows[0];
    const currentVersion = current?.doc_version == null
      ? null
      : Number(current.doc_version);
    const currentPm = getPmEvidence(current?.doc_pm);
    const snapshotPm = getPmEvidence(evidence.snapshotPm);
    const nativeSnapshots = currentVersion == null
      ? { rows: [] }
      : await client.execute({
          sql: `SELECT native.snapshot_pm
            FROM document_versions native
            WHERE native.doc_id = ?
              AND native.doc_version = ?
              AND NOT EXISTS (
                SELECT 1 FROM document_version_restore_origins origin
                WHERE origin.version_id = native.version_id
                  AND origin.restored_doc_id = native.doc_id
                  AND origin.source_doc_id <> native.doc_id
              )`,
          args: [evidence.restoredDocId, currentVersion],
        });
    const nativeSnapshotMatch = currentPm !== null
      && nativeSnapshots.rows.some((row) => {
        const nativePm = getPmEvidence(row.snapshot_pm);
        return nativePm !== null && nativePm.stableJson === currentPm.stableJson;
      });
    const nativeOpMatch = currentVersion != null
      && (await client.execute({
        sql: `SELECT 1
          FROM document_ops
          WHERE doc_id = ? AND to_version = ?
          LIMIT 1`,
        args: [evidence.restoredDocId, currentVersion],
      })).rows.length > 0;
    const exactSnapshotMatch = currentPm !== null
      && snapshotPm !== null
      && currentPm.stableJson === snapshotPm.stableJson;
    const computedHashesMatch = currentPm !== null
      && snapshotPm !== null
      && currentPm.contentHash === snapshotPm.contentHash
      && snapshotPm.contentHash === evidence.storedContentHash;
    const positiveOverwriteEvidence = currentVersion === evidence.docVersion
      && exactSnapshotMatch
      && computedHashesMatch
      && !nativeSnapshotMatch
      && !nativeOpMatch;

    if (positiveOverwriteEvidence) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO document_write_blocks (
          doc_id, reason, source_doc_id, source_thread_id, version_id
        ) VALUES (?, 'quarantine_0002_foreign_snapshot', ?, ?, ?)`,
        args: [
          evidence.restoredDocId,
          evidence.sourceDocId,
          evidence.sourceThreadId,
          evidence.versionId,
        ],
      });
      continue;
    }

    // 仅有版本号、旧 content_hash 或相似正文都不足以永久锁写。保留隔离证据，
    // 交由人工明确确认或驳回；审计本身不参与写门。
    await client.execute({
      sql: `INSERT OR IGNORE INTO document_recovery_audits (
        doc_id, version_id, reason, source_doc_id, source_thread_id,
        current_doc_version, isolated_doc_version, current_content_hash,
        snapshot_content_hash, stored_version_hash, exact_snapshot_match,
        native_snapshot_match, native_op_match
      ) VALUES (
        ?, ?, 'quarantine_0002_foreign_version_needs_confirmation', ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )`,
      args: [
        evidence.restoredDocId,
        evidence.versionId,
        evidence.sourceDocId,
        evidence.sourceThreadId,
        currentVersion,
        evidence.docVersion,
        currentPm?.contentHash ?? null,
        snapshotPm?.contentHash ?? null,
        evidence.storedContentHash,
        exactSnapshotMatch ? 1 : 0,
        nativeSnapshotMatch ? 1 : 0,
        nativeOpMatch ? 1 : 0,
      ],
    });
  }
}

async function isolateForeignVersions(
  client: Client,
): Promise<ForeignVersionIsolationEvidence[]> {
  if (!(await tableExists(client, "document_versions_quarantine_0002"))) return [];
  const candidates = await client.execute(`
    SELECT
      active.version_id,
      active.doc_id AS restored_doc_id,
      active.doc_version,
      active.content_hash,
      active.snapshot_pm,
      origin.source_doc_id,
      origin.source_thread_id
    FROM document_versions active
    INNER JOIN document_version_restore_origins origin
      ON origin.version_id = active.version_id
      AND origin.restored_doc_id = active.doc_id
      AND origin.recovery_migration = 23
    INNER JOIN document_versions_quarantine_0002 quarantined
      ON quarantined.version_id = active.version_id
      AND quarantined.doc_id = origin.source_doc_id
      AND quarantined.doc_version = active.doc_version
      AND quarantined.content_hash = active.content_hash
      AND quarantined.schema_version = active.schema_version
      AND quarantined.actor_type = active.actor_type
      AND quarantined.summary IS active.summary
      AND quarantined.snapshot_pm = active.snapshot_pm
      AND quarantined.parent_version IS active.parent_version
      AND quarantined.created_at = active.created_at
    WHERE origin.source_doc_id <> active.doc_id
    ORDER BY active.doc_id, active.doc_version DESC, active.version_id
  `);
  await client.execute(`
    INSERT OR IGNORE INTO document_versions_quarantine_0025 (
      version_id, doc_id, doc_version, content_hash, schema_version,
      actor_type, summary, snapshot_pm, parent_version, created_at,
      restored_doc_id, source_doc_id, source_thread_id
    )
    SELECT
      active.version_id, active.doc_id, active.doc_version, active.content_hash,
      active.schema_version, active.actor_type, active.summary, active.snapshot_pm,
      active.parent_version, active.created_at, active.doc_id,
      origin.source_doc_id, origin.source_thread_id
    FROM document_versions active
    INNER JOIN document_version_restore_origins origin
      ON origin.version_id = active.version_id
      AND origin.restored_doc_id = active.doc_id
      AND origin.recovery_migration = 23
    INNER JOIN document_versions_quarantine_0002 quarantined
      ON quarantined.version_id = active.version_id
      AND quarantined.doc_id = origin.source_doc_id
      AND quarantined.doc_version = active.doc_version
      AND quarantined.content_hash = active.content_hash
      AND quarantined.schema_version = active.schema_version
      AND quarantined.actor_type = active.actor_type
      AND quarantined.summary IS active.summary
      AND quarantined.snapshot_pm = active.snapshot_pm
      AND quarantined.parent_version IS active.parent_version
      AND quarantined.created_at = active.created_at
    WHERE origin.source_doc_id <> active.doc_id
  `);
  await client.execute(`
    DELETE FROM document_versions
    WHERE EXISTS (
      SELECT 1 FROM document_versions_quarantine_0025 quarantined
      WHERE quarantined.version_id = document_versions.version_id
        AND quarantined.doc_id = document_versions.doc_id
        AND quarantined.doc_version = document_versions.doc_version
        AND quarantined.content_hash = document_versions.content_hash
        AND quarantined.schema_version = document_versions.schema_version
        AND quarantined.actor_type = document_versions.actor_type
        AND quarantined.summary IS document_versions.summary
        AND quarantined.snapshot_pm = document_versions.snapshot_pm
        AND quarantined.parent_version IS document_versions.parent_version
        AND quarantined.created_at = document_versions.created_at
    )
  `);

  const removed: ForeignVersionIsolationEvidence[] = [];
  for (const row of candidates.rows) {
    const proof = await client.execute({
      sql: `SELECT 1
        FROM document_versions_quarantine_0025 quarantined
        WHERE quarantined.version_id = ?
          AND quarantined.restored_doc_id = ?
          AND quarantined.source_doc_id = ?
          AND quarantined.doc_version = ?
          AND quarantined.content_hash = ?
          AND quarantined.snapshot_pm = ?
          AND NOT EXISTS (
            SELECT 1 FROM document_versions active
            WHERE active.version_id = quarantined.version_id
              AND active.doc_id = quarantined.restored_doc_id
          )
        LIMIT 1`,
      args: [
        row.version_id as string,
        row.restored_doc_id as string,
        row.source_doc_id as string,
        Number(row.doc_version),
        row.content_hash as string,
        row.snapshot_pm as string,
      ],
    });
    if (proof.rows.length === 0) continue;
    removed.push({
      versionId: String(row.version_id),
      restoredDocId: String(row.restored_doc_id),
      docVersion: Number(row.doc_version),
      storedContentHash: String(row.content_hash),
      snapshotPm: String(row.snapshot_pm),
      sourceDocId: String(row.source_doc_id),
      sourceThreadId: String(row.source_thread_id),
    });
  }
  return removed;
}

async function isolateForeignOps(client: Client): Promise<void> {
  if (
    !(await tableExists(client, "document_ops_quarantine_0002"))
    || !(await tableExists(client, "documents_quarantine_0002"))
  ) return;
  await client.execute(`
    INSERT OR IGNORE INTO document_ops_quarantine_0025 (
      op_id, doc_id, op_kind, client_mutation_id, steps, from_version,
      to_version, actor_type, created_at, restored_doc_id, source_doc_id,
      source_thread_id
    )
    SELECT
      active.op_id, active.doc_id, active.op_kind, active.client_mutation_id,
      active.steps, active.from_version, active.to_version, active.actor_type,
      active.created_at, active.doc_id, quarantined.doc_id, source.thread_id
    FROM document_ops active
    INNER JOIN document_ops_quarantine_0002 quarantined
      ON quarantined.op_id = active.op_id
      AND quarantined.doc_id <> active.doc_id
      AND quarantined.op_kind = active.op_kind
      AND quarantined.client_mutation_id IS active.client_mutation_id
      AND quarantined.steps IS active.steps
      AND quarantined.from_version = active.from_version
      AND quarantined.to_version = active.to_version
      AND quarantined.actor_type = active.actor_type
      AND quarantined.created_at = active.created_at
    INNER JOIN documents_quarantine_0002 source
      ON source.id = quarantined.doc_id
  `);
  await client.execute(`
    DELETE FROM document_ops
    WHERE EXISTS (
      SELECT 1 FROM document_ops_quarantine_0025 quarantined
      WHERE quarantined.op_id = document_ops.op_id
        AND quarantined.doc_id = document_ops.doc_id
        AND quarantined.op_kind = document_ops.op_kind
        AND quarantined.client_mutation_id IS document_ops.client_mutation_id
        AND quarantined.steps IS document_ops.steps
        AND quarantined.from_version = document_ops.from_version
        AND quarantined.to_version = document_ops.to_version
        AND quarantined.actor_type = document_ops.actor_type
        AND quarantined.created_at = document_ops.created_at
    )
  `);
}

async function isolateForeignDrafts(client: Client): Promise<void> {
  if (
    !(await tableExists(client, "document_drafts_quarantine_0002"))
    || !(await tableExists(client, "documents_quarantine_0002"))
  ) return;
  await client.execute(`
    INSERT OR IGNORE INTO document_drafts_quarantine_0025 (
      restored_doc_id, doc_id, thread_id, base_version, base_hash, draft_pm,
      status, conflict_json, review_batch_id, group_mode, source_stream_id,
      source_tool_call_id, created_at, updated_at, batch_id, source_doc_id,
      source_thread_id
    )
    SELECT
      active.doc_id, active.doc_id, active.thread_id, active.base_version,
      active.base_hash, active.draft_pm, active.status, active.conflict_json,
      active.review_batch_id, active.group_mode, active.source_stream_id,
      active.source_tool_call_id, active.created_at, active.updated_at,
      active.batch_id, quarantined.doc_id, source.thread_id
    FROM document_drafts active
    INNER JOIN document_drafts_quarantine_0002 quarantined
      ON quarantined.doc_id <> active.doc_id
      AND quarantined.thread_id = active.thread_id
      AND quarantined.base_version = active.base_version
      AND quarantined.base_hash = active.base_hash
      AND quarantined.draft_pm = active.draft_pm
      AND quarantined.status = active.status
      AND quarantined.conflict_json IS active.conflict_json
      AND quarantined.review_batch_id IS active.review_batch_id
      AND quarantined.group_mode IS active.group_mode
      AND quarantined.source_stream_id IS active.source_stream_id
      AND quarantined.source_tool_call_id IS active.source_tool_call_id
      AND quarantined.created_at = active.created_at
      AND quarantined.updated_at = active.updated_at
    INNER JOIN documents_quarantine_0002 source
      ON source.id = quarantined.doc_id
  `);
  await client.execute(`
    DELETE FROM document_drafts
    WHERE EXISTS (
      SELECT 1 FROM document_drafts_quarantine_0025 quarantined
      WHERE quarantined.restored_doc_id = document_drafts.doc_id
        AND quarantined.doc_id = document_drafts.doc_id
        AND quarantined.thread_id = document_drafts.thread_id
        AND quarantined.base_version = document_drafts.base_version
        AND quarantined.base_hash = document_drafts.base_hash
        AND quarantined.draft_pm = document_drafts.draft_pm
        AND quarantined.status = document_drafts.status
        AND quarantined.conflict_json IS document_drafts.conflict_json
        AND quarantined.review_batch_id IS document_drafts.review_batch_id
        AND quarantined.group_mode IS document_drafts.group_mode
        AND quarantined.source_stream_id IS document_drafts.source_stream_id
        AND quarantined.source_tool_call_id IS document_drafts.source_tool_call_id
        AND quarantined.created_at = document_drafts.created_at
        AND quarantined.updated_at = document_drafts.updated_at
        AND quarantined.batch_id = document_drafts.batch_id
    )
  `);
}

async function isolateForeignSuggestions(client: Client): Promise<void> {
  if (
    !(await tableExists(client, "document_suggestions_quarantine_0002"))
    || !(await tableExists(client, "documents_quarantine_0002"))
  ) return;
  await client.execute(`
    INSERT OR IGNORE INTO document_suggestions_quarantine_0025 (
      id, doc_id, base_version, batch_id, status, anchor_json, steps_json,
      preview_json, summary, conflict_json, kind, note, origin, group_id,
      group_meta_json, created_at, updated_at, severity, restored_doc_id,
      source_doc_id, source_thread_id
    )
    SELECT
      active.id, active.doc_id, active.base_version, active.batch_id,
      active.status, active.anchor_json, active.steps_json, active.preview_json,
      active.summary, active.conflict_json, active.kind, active.note,
      active.origin, active.group_id, active.group_meta_json, active.created_at,
      active.updated_at, active.severity, active.doc_id, quarantined.doc_id,
      source.thread_id
    FROM document_suggestions active
    INNER JOIN document_suggestions_quarantine_0002 quarantined
      ON quarantined.doc_id <> active.doc_id
      AND quarantined.id = active.id
      AND quarantined.base_version = active.base_version
      AND quarantined.status = active.status
      AND quarantined.anchor_json = active.anchor_json
      AND quarantined.steps_json IS active.steps_json
      AND quarantined.preview_json IS active.preview_json
      AND quarantined.summary = active.summary
      AND quarantined.conflict_json IS active.conflict_json
      AND quarantined.created_at = active.created_at
      AND quarantined.updated_at = active.updated_at
    INNER JOIN documents_quarantine_0002 source
      ON source.id = quarantined.doc_id
    WHERE active.batch_id = 'legacy'
      AND active.kind = 'revision'
  `);
  await client.execute(`
    DELETE FROM document_suggestions
    WHERE EXISTS (
      SELECT 1
      FROM document_suggestions_quarantine_0025 quarantined
      WHERE quarantined.restored_doc_id = document_suggestions.doc_id
        AND quarantined.base_version = document_suggestions.base_version
        AND quarantined.batch_id = document_suggestions.batch_id
        AND quarantined.id = document_suggestions.id
        AND quarantined.status = document_suggestions.status
        AND quarantined.anchor_json = document_suggestions.anchor_json
        AND quarantined.steps_json IS document_suggestions.steps_json
        AND quarantined.preview_json IS document_suggestions.preview_json
        AND quarantined.summary = document_suggestions.summary
        AND quarantined.conflict_json IS document_suggestions.conflict_json
        AND quarantined.kind = document_suggestions.kind
        AND quarantined.note IS document_suggestions.note
        AND quarantined.origin IS document_suggestions.origin
        AND quarantined.group_id IS document_suggestions.group_id
        AND quarantined.group_meta_json IS document_suggestions.group_meta_json
        AND quarantined.created_at = document_suggestions.created_at
        AND quarantined.updated_at = document_suggestions.updated_at
        AND quarantined.severity IS document_suggestions.severity
    )
  `);
}

async function normalizePmColumn(
  client: Client,
  tableName: "documents" | "document_versions" | "document_drafts",
  keyColumn: "id" | "version_id" | "doc_id",
  pmColumn: "doc_pm" | "snapshot_pm" | "draft_pm",
  baselineHashChanges: BaselineHashChange[],
): Promise<void> {
  const baselineColumns = tableName === "documents"
    ? ", id AS baseline_doc_id, doc_version AS baseline_version"
    : tableName === "document_versions"
      ? ", doc_id AS baseline_doc_id, doc_version AS baseline_version"
      : "";
  const result = await client.execute(
    `SELECT ${keyColumn} AS row_key, ${pmColumn} AS pm_json${baselineColumns}
      FROM ${tableName}`,
  );
  for (const row of result.rows) {
    if (typeof row.pm_json !== "string" || row.pm_json.trim().length === 0) continue;
    const originalPm = JSON.parse(row.pm_json) as unknown;
    const normalized = normalizeLegacyListItemFirstChildPmDoc(
      originalPm,
    );
    if (!normalized.changed) continue;
    const pmDoc = normalizeStoredPmDoc(normalized.value);
    const normalizedJson = getStablePmJson(pmDoc);
    const normalizedHash = getPmContentHash(pmDoc);
    if (tableName !== "document_drafts") {
      baselineHashChanges.push({
        docId: String(row.baseline_doc_id),
        baseVersion: Number(row.baseline_version),
        previousHash: getPmContentHash(originalPm),
        normalizedHash,
      });
    }
    if (tableName === "documents") {
      await client.execute({
        sql: `UPDATE documents SET
          doc_pm = ?, doc_schema_version = ?, content_hash = ?, doc_format = 'pm'
          WHERE id = ?`,
        args: [
          normalizedJson,
          pmDoc.attrs.schemaVersion,
          normalizedHash,
          row.row_key as string,
        ],
      });
    } else if (tableName === "document_versions") {
      await client.execute({
        sql: `UPDATE document_versions SET
          snapshot_pm = ?, schema_version = ?, content_hash = ?
          WHERE version_id = ?`,
        args: [
          normalizedJson,
          pmDoc.attrs.schemaVersion,
          normalizedHash,
          row.row_key as string,
        ],
      });
    } else {
      await client.execute({
        sql: "UPDATE document_drafts SET draft_pm = ? WHERE doc_id = ?",
        args: [normalizedJson, row.row_key as string],
      });
    }
  }
}

interface BaselineHashChange {
  docId: string;
  baseVersion: number;
  previousHash: string;
  normalizedHash: string;
}

async function normalizeStoredPmDocuments(client: Client): Promise<void> {
  const baselineHashChanges: BaselineHashChange[] = [];
  await normalizePmColumn(
    client,
    "documents",
    "id",
    "doc_pm",
    baselineHashChanges,
  );
  await normalizePmColumn(
    client,
    "document_versions",
    "version_id",
    "snapshot_pm",
    baselineHashChanges,
  );
  const uniqueChanges = new Map<string, BaselineHashChange>();
  for (const change of baselineHashChanges) {
    uniqueChanges.set(
      `${change.docId}\u0000${change.baseVersion}\u0000${change.previousHash}`,
      change,
    );
  }
  for (const change of uniqueChanges.values()) {
    await client.execute({
      sql: `UPDATE document_drafts
        SET base_hash = ?
        WHERE doc_id = ? AND base_version = ? AND base_hash = ?`,
      args: [
        change.normalizedHash,
        change.docId,
        change.baseVersion,
        change.previousHash,
      ],
    });
  }
  await normalizePmColumn(
    client,
    "document_drafts",
    "doc_id",
    "draft_pm",
    baselineHashChanges,
  );
}

async function up(client: Client): Promise<void> {
  await createRecoveryTables(client);
  const removedForeignVersions = await isolateForeignVersions(client);
  await isolateForeignOps(client);
  await classifyRemovedForeignVersions(client, removedForeignVersions);
  await isolateForeignDrafts(client);
  await isolateForeignSuggestions(client);
  await normalizeStoredPmDocuments(client);
}

export const migration0025QuarantineLineageAndPmCompat: Migration = {
  id: 25,
  name: "quarantine_lineage_and_pm_compat",
  up,
};
