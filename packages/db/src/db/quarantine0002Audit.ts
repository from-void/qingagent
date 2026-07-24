import { getPmContentHash, getStablePmJson } from "@qingagent/pm-schema";
import { getDocumentsClient } from "./documentsClient.js";

export interface Quarantine0002OverwriteCandidate {
  currentDocId: string;
  currentThreadId: string;
  sourceDocId: string;
  sourceThreadId: string;
  versionId: string;
  docVersion: number;
  confidence:
    | "exact_snapshot"
    | "matching_hash"
    | "persisted_block"
    | "manual_confirmation_required";
  currentUpdatedAt: string;
}

/**
 * 只读识别 0023 旧实现可能造成的当前正文覆盖。
 *
 * 首次识别报告同时满足以下证据的行：
 * 1. 版本可由 0024 血缘账本追溯到另一 source docId；
 * 2. 当前 documents 指针正落在该隔离版本；
 * 3. 当前 doc_pm 与隔离快照完全一致，或当前 doc_pm 的现算 hash 与版本 hash 一致。
 * 0025 持久化阻断后，即使 PM 兼容规整改变了表示，也继续报告到人工解除为止。
 * 仅有弱证据的 0025 隔离行以 manual_confirmation_required 报告，不参与写门。
 */
export async function identifyQuarantine0002OverwriteCandidates(): Promise<
  Quarantine0002OverwriteCandidate[]
> {
  const client = getDocumentsClient();
  const lineageTable = await client.execute(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'document_version_restore_origins'
    LIMIT 1
  `);
  if (lineageTable.rows.length === 0) {
    throw new Error(
      "缺少 0024 恢复血缘表；请先通过应用启动流程完成迁移，再运行只读识别。",
    );
  }

  const activeResult = await client.execute(`
    SELECT
      d.id AS current_doc_id,
      d.thread_id AS current_thread_id,
      origin.source_doc_id,
      origin.source_thread_id,
      version.version_id,
      version.doc_version,
      d.updated_at AS current_updated_at,
      d.doc_pm AS current_doc_pm,
      version.snapshot_pm,
      version.content_hash AS stored_version_hash
    FROM document_version_restore_origins origin
    INNER JOIN documents d
      ON d.id = origin.restored_doc_id
    INNER JOIN document_versions version
      ON version.version_id = origin.version_id
      AND version.doc_id = d.id
    WHERE origin.source_doc_id <> d.id
      AND d.doc_version = version.doc_version
    ORDER BY d.thread_id, d.id, version.doc_version DESC
  `);

  type Candidate = Quarantine0002OverwriteCandidate;
  const candidates: Candidate[] = [];
  const pmEvidence = (
    value: unknown,
  ): { stableJson: string; contentHash: string } | null => {
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
  };
  const appendCandidate = (
    row: (typeof activeResult.rows)[number],
    confidence: Candidate["confidence"],
  ): void => {
    candidates.push({
      currentDocId: String(row.current_doc_id),
      currentThreadId: String(row.current_thread_id),
      sourceDocId: String(row.source_doc_id),
      sourceThreadId: String(row.source_thread_id),
      versionId: String(row.version_id),
      docVersion: Number(row.doc_version),
      confidence,
      currentUpdatedAt: String(row.current_updated_at),
    });
  };
  for (const row of activeResult.rows) {
    const current = pmEvidence(row.current_doc_pm);
    const snapshot = pmEvidence(row.snapshot_pm);
    if (current && snapshot && current.stableJson === snapshot.stableJson) {
      appendCandidate(row, "exact_snapshot");
    } else if (
      current
      && current.contentHash === String(row.stored_version_hash)
    ) {
      appendCandidate(row, "matching_hash");
    }
  }

  const quarantine0025Table = await client.execute(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'document_versions_quarantine_0025'
    LIMIT 1
  `);
  const writeBlocksTable = await client.execute(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'document_write_blocks'
    LIMIT 1
  `);
  if (
    quarantine0025Table.rows.length > 0
    && writeBlocksTable.rows.length > 0
  ) {
    const isolatedResult = await client.execute(`
      SELECT
        d.id AS current_doc_id,
        d.thread_id AS current_thread_id,
        block.source_doc_id,
        block.source_thread_id,
        version.version_id,
        version.doc_version,
        d.updated_at AS current_updated_at,
        d.doc_pm AS current_doc_pm,
        version.snapshot_pm,
        version.content_hash AS stored_version_hash
      FROM document_write_blocks block
      INNER JOIN documents d ON d.id = block.doc_id
      INNER JOIN document_versions_quarantine_0025 version
        ON version.version_id = block.version_id
      WHERE block.reason = 'quarantine_0002_foreign_snapshot'
      ORDER BY d.thread_id, d.id, version.doc_version DESC
    `);
    for (const row of isolatedResult.rows) {
      const current = pmEvidence(row.current_doc_pm);
      const snapshot = pmEvidence(row.snapshot_pm);
      if (current && snapshot && current.stableJson === snapshot.stableJson) {
        appendCandidate(row, "exact_snapshot");
      } else if (
        current
        && current.contentHash === String(row.stored_version_hash)
      ) {
        appendCandidate(row, "matching_hash");
      } else {
        appendCandidate(row, "persisted_block");
      }
    }
  }

  const recoveryAuditsTable = await client.execute(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'document_recovery_audits'
    LIMIT 1
  `);
  if (recoveryAuditsTable.rows.length > 0) {
    const auditResult = await client.execute(`
      SELECT
        d.id AS current_doc_id,
        d.thread_id AS current_thread_id,
        audit.source_doc_id,
        audit.source_thread_id,
        audit.version_id,
        audit.isolated_doc_version AS doc_version,
        d.updated_at AS current_updated_at
      FROM document_recovery_audits audit
      INNER JOIN documents d ON d.id = audit.doc_id
      WHERE audit.reason =
        'quarantine_0002_foreign_version_needs_confirmation'
        AND audit.review_status = 'pending'
      ORDER BY d.thread_id, d.id, audit.isolated_doc_version DESC
    `);
    for (const row of auditResult.rows) {
      appendCandidate(row, "manual_confirmation_required");
    }
  }

  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    unique.set(
      `${candidate.currentDocId}:${candidate.versionId}`,
      candidate,
    );
  }
  return [...unique.values()];
}
