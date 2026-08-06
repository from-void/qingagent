import type { Client } from "@libsql/client";
import {
  maskSensitiveAnnotationGroup,
  normalizeAnnotationSuggestion,
  type AnnotationGroup,
  type AnnotationGroupMeta,
  type DocSuggestion,
  type SuggestionAnchor,
  type SuggestionStatus,
} from "@qingagent/contract-ts";
import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import {
  assertDocumentWriteAllowed,
  assertDocumentWriteAllowedPersisted,
  DocumentWriteBlockedError,
  type DocumentWriteTarget,
} from "./documentWriteGuard.js";

export const LEGACY_DOCUMENT_SUGGESTION_BATCH_ID = "legacy";

export interface DocumentSuggestionStatusRecord {
  id: string;
  status: SuggestionStatus;
  conflict: DocSuggestion["conflict"] | undefined;
}

async function readyClient(client?: Client): Promise<Client> {
  const c = client ?? getDocumentsClient();
  await ensureMigrated();
  return c;
}

function annotationGroupMeta(group: AnnotationGroup): AnnotationGroupMeta {
  const suggestion = normalizeAnnotationSuggestion(group.note, group.suggestion);
  return {
    summary: group.summary,
    ...(suggestion ? { suggestion } : {}),
    hitCount: group.anchors.length,
    ...(group.severity ? { severity: group.severity } : {}),
    ...(group.reviewTemplateId ? { reviewTemplateId: group.reviewTemplateId } : {}),
  };
}

function annotationInsertStatements(
  docId: string,
  baseVersion: number,
  groups: readonly AnnotationGroup[],
  now: string,
) {
  return groups.flatMap((inputGroup) => {
    const group = maskSensitiveAnnotationGroup(inputGroup);
    return group.anchors.map((anchor, index) => ({
      sql: `INSERT INTO document_suggestions (
        id, doc_id, base_version, status, anchor_json, steps_json, preview_json,
        summary, conflict_json, kind, note, origin, group_id, group_meta_json,
        severity, created_at, updated_at
      ) SELECT ?, ?, ?, 'reviewing', ?, NULL, NULL, ?, NULL, 'annotation', ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM deleted_sessions
        WHERE session_id = ?
          OR session_id = (SELECT thread_id FROM documents WHERE id = ?)
      )`,
      args: [
        `${group.id}:${index + 1}`, docId, baseVersion, JSON.stringify(anchor), group.summary,
        group.note, group.origin, group.id,
        JSON.stringify(annotationGroupMeta(group)),
        group.severity ?? null,
        now, now, docId, docId,
      ],
    }));
  });
}

function writeTarget(docId: string, operation: DocumentWriteTarget["operation"]): DocumentWriteTarget {
  return { docId, operation };
}

function assertSuggestionWritesAffected(
  results: readonly { rowsAffected: number }[],
  target: DocumentWriteTarget,
): void {
  if (results.some((result) => result.rowsAffected === 0)) {
    throw new DocumentWriteBlockedError(target);
  }
}

async function assertSuggestionNotTombstoned(
  client: Client,
  target: DocumentWriteTarget,
): Promise<void> {
  const result = await client.execute({
    sql: `SELECT 1 FROM deleted_sessions
      WHERE session_id = ?
        OR session_id = (SELECT thread_id FROM documents WHERE id = ?)
      LIMIT 1`,
    args: [target.docId, target.docId],
  });
  if (result.rows.length > 0) throw new DocumentWriteBlockedError(target);
}

export async function insertAnnotationGroups(
  docId: string,
  baseVersion: number,
  groups: readonly AnnotationGroup[],
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    const target = writeTarget(docId, "documentSuggestion.insertAnnotations");
    assertDocumentWriteAllowed(target);
    await assertDocumentWriteAllowedPersisted(c, target);
    const results = await c.batch(annotationInsertStatements(docId, baseVersion, groups, now));
    assertSuggestionWritesAffected(results, target);
  });
}

function parseAnnotationAnchor(value: unknown): SuggestionAnchor | null {
  if (typeof value !== "string") return null;
  try {
    const anchor = JSON.parse(value) as Record<string, unknown>;
    if (
      !anchor ||
      typeof anchor !== "object" ||
      typeof anchor.blockId !== "string" ||
      !Number.isInteger(anchor.pmFrom) ||
      !Number.isInteger(anchor.pmTo) ||
      (anchor.pmFrom as number) < 0 ||
      (anchor.pmTo as number) <= (anchor.pmFrom as number) ||
      typeof anchor.quote !== "string" ||
      typeof anchor.textHash !== "string"
    ) {
      return null;
    }
    return {
      blockId: anchor.blockId,
      pmFrom: anchor.pmFrom as number,
      pmTo: anchor.pmTo as number,
      quote: anchor.quote,
      ...(typeof anchor.prefix === "string" ? { prefix: anchor.prefix } : {}),
      ...(typeof anchor.suffix === "string" ? { suffix: anchor.suffix } : {}),
      textHash: anchor.textHash,
    };
  } catch {
    return null;
  }
}

function parseAnnotationGroupMeta(value: unknown): AnnotationGroupMeta | null {
  if (typeof value !== "string") return null;
  try {
    const meta = JSON.parse(value) as Record<string, unknown>;
    if (!meta || typeof meta !== "object") return null;
    return {
      summary: typeof meta.summary === "string" ? meta.summary : "",
      ...(typeof meta.suggestion === "string" ? { suggestion: meta.suggestion } : {}),
      hitCount: Number.isInteger(meta.hitCount) && (meta.hitCount as number) >= 0
        ? meta.hitCount as number
        : 0,
      ...(meta.severity === "error" || meta.severity === "warn" || meta.severity === "info"
        ? { severity: meta.severity }
        : {}),
      ...(typeof meta.reviewTemplateId === "string" && meta.reviewTemplateId
        ? { reviewTemplateId: meta.reviewTemplateId }
        : {}),
    };
  } catch {
    return null;
  }
}

/** 从独立批注表重组当前仍可展示的组；单条损坏记录不会阻断整次会话恢复。 */
export async function listActiveAnnotationGroups(
  docId: string,
  client?: Client,
): Promise<AnnotationGroup[]> {
  const c = await readyClient(client);
  const result = await c.execute({
    sql: `SELECT group_id, status, anchor_json, summary, note, origin,
        group_meta_json, severity
      FROM document_suggestions
      WHERE doc_id = ? AND kind = 'annotation'
        AND status IN ('reviewing', 'accepted')
      ORDER BY created_at ASC, rowid ASC`,
    args: [docId],
  });

  const groups = new Map<string, AnnotationGroup>();
  for (const row of result.rows) {
    const groupId = typeof row.group_id === "string" ? row.group_id : "";
    const origin = typeof row.origin === "string" ? row.origin : "";
    const anchor = parseAnnotationAnchor(row.anchor_json);
    if (!groupId || !origin || !anchor) continue;

    const existing = groups.get(groupId);
    if (existing) {
      existing.anchors.push(anchor);
      continue;
    }

    const meta = parseAnnotationGroupMeta(row.group_meta_json);
    const severity = row.severity === "error" || row.severity === "warn" || row.severity === "info"
      ? row.severity
      : meta?.severity;
    const note = typeof row.note === "string" ? row.note : "";
    const suggestion = normalizeAnnotationSuggestion(note, meta?.suggestion);
    groups.set(groupId, {
      id: groupId,
      summary: typeof row.summary === "string" ? row.summary : meta?.summary ?? "",
      note,
      origin,
      ...(meta?.reviewTemplateId ? { reviewTemplateId: meta.reviewTemplateId } : {}),
      ...(suggestion ? { suggestion } : {}),
      ...(severity ? { severity } : {}),
      status: row.status === "accepted" ? "accepted" : "reviewing",
      anchors: [anchor],
    });
  }
  return [...groups.values()];
}

/** 同一来源的新一轮审查原子取代旧轮次；其他来源的批注不受影响。 */
export async function replaceAnnotationGroupsByOrigin(
  docId: string,
  baseVersion: number,
  groups: readonly AnnotationGroup[],
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  if (groups.length === 0) return;
  const c = await readyClient(client);
  const origins = [...new Set(groups.map((group) => group.origin))];
  const target = writeTarget(docId, "documentSuggestion.replaceAnnotations");
  assertDocumentWriteAllowed(target);
  if (client) {
    await assertDocumentWriteAllowedPersisted(c, target);
    await assertSuggestionNotTombstoned(c, target);
    await c.execute({
        sql: `UPDATE document_suggestions SET status='ignored', updated_at=?
          WHERE doc_id=? AND kind='annotation' AND origin IN (${origins.map(() => "?").join(",")})
          AND status IN ('reviewing','accepted')`,
        args: [now, docId, ...origins],
    });
    const results = [];
    for (const statement of annotationInsertStatements(docId, baseVersion, groups, now)) {
      results.push(await c.execute(statement));
    }
    assertSuggestionWritesAffected(results, target);
    return;
  }
  await withTransaction(async (transactionClient) => {
    await assertDocumentWriteAllowedPersisted(transactionClient, target);
    await assertSuggestionNotTombstoned(transactionClient, target);
    await transactionClient.execute({
      sql: `UPDATE document_suggestions SET status='ignored', updated_at=?
        WHERE doc_id=? AND kind='annotation' AND origin IN (${origins.map(() => "?").join(",")})
        AND status IN ('reviewing','accepted')`,
      args: [now, docId, ...origins],
    });
    const results = [];
    for (const statement of annotationInsertStatements(docId, baseVersion, groups, now)) {
      results.push(await transactionClient.execute(statement));
    }
    assertSuggestionWritesAffected(results, target);
    return commitTransaction(undefined);
  });
}

export async function ignoreAnnotationGroups(
  docId: string,
  groupIds?: readonly string[],
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  const ids = groupIds?.filter(Boolean) ?? [];
  const where = ids.length ? ` AND group_id IN (${ids.map(() => "?").join(",")})` : "";
  await withWriteRetry(async () => {
    const target = writeTarget(docId, "documentSuggestion.ignoreAnnotations");
    assertDocumentWriteAllowed(target);
    await assertDocumentWriteAllowedPersisted(c, target);
    await c.execute({
      sql: `UPDATE document_suggestions SET status='ignored', updated_at=? WHERE doc_id=? AND kind='annotation' AND status IN ('reviewing','accepted')${where}`,
      args: [now, docId, ...ids],
    });
  });
}

export async function persistMappedAnnotationGroups(
  docId: string,
  groups: readonly AnnotationGroup[],
  survivingAnchorIndexes: ReadonlyMap<string, readonly number[]>,
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    const target = writeTarget(
      docId,
      "documentSuggestion.persistMappedAnnotations",
    );
    assertDocumentWriteAllowed(target);
    await assertDocumentWriteAllowedPersisted(c, target);
    await c.execute({
      sql: "UPDATE document_suggestions SET status='ignored', updated_at=? WHERE doc_id=? AND kind='annotation' AND status IN ('reviewing','accepted')",
      args: [now, docId],
    });
    const statements = groups.flatMap((inputGroup) => {
      const group = maskSensitiveAnnotationGroup(inputGroup);
      return group.anchors.map((anchor, mappedIndex) => ({
        sql: `UPDATE document_suggestions SET status=?, anchor_json=?,
          group_meta_json=?, severity=?, updated_at=? WHERE id=? AND doc_id=? AND kind='annotation'`,
        args: [group.status, JSON.stringify(anchor), JSON.stringify(annotationGroupMeta(group)), group.severity ?? null, now,
          `${group.id}:${(survivingAnchorIndexes.get(group.id)?.[mappedIndex] ?? mappedIndex) + 1}`, docId],
      }));
    });
    if (client) {
      for (const statement of statements) await c.execute(statement);
    } else if (statements.length > 0) {
      await c.batch(statements);
    }
  });
}

export async function upsertDocumentSuggestion(
  suggestion: DocSuggestion,
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    const target = writeTarget(suggestion.docId, "documentSuggestion.upsert");
    assertDocumentWriteAllowed(target);
    await assertDocumentWriteAllowedPersisted(c, target);
    const result = await c.execute({
      sql: `INSERT INTO document_suggestions (
          id, doc_id, base_version, batch_id, status, anchor_json, steps_json,
          preview_json, summary, conflict_json, created_at, updated_at
          , severity
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM deleted_sessions
          WHERE session_id = ?
            OR session_id = (SELECT thread_id FROM documents WHERE id = ?)
        )
        ON CONFLICT(doc_id, base_version, batch_id, id) DO UPDATE SET
          status = excluded.status,
          anchor_json = excluded.anchor_json,
          steps_json = excluded.steps_json,
          preview_json = excluded.preview_json,
          summary = excluded.summary,
          conflict_json = excluded.conflict_json,
          severity = excluded.severity,
          updated_at = excluded.updated_at`,
      args: [
        suggestion.id,
        suggestion.docId,
        suggestion.baseVersion,
        suggestion.batchId ?? LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
        suggestion.status,
        JSON.stringify(suggestion.anchor),
        JSON.stringify(suggestion.patch.steps),
        JSON.stringify(suggestion.preview),
        suggestion.summary,
        suggestion.conflict ? JSON.stringify(suggestion.conflict) : null,
        now,
        now,
        suggestion.severity ?? null,
        suggestion.docId,
        suggestion.docId,
      ],
    });
    assertSuggestionWritesAffected([result], target);
  });
}

export async function updateDocumentSuggestionStatus(
  docId: string,
  baseVersion: number,
  id: string,
  status: SuggestionStatus,
  conflict?: DocSuggestion["conflict"],
  client?: Client,
  now = new Date().toISOString(),
): Promise<number> {
  return updateDocumentSuggestionStatusInBatch(
    docId,
    baseVersion,
    LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
    id,
    status,
    conflict,
    client,
    now,
  );
}

export async function updateDocumentSuggestionStatusInBatch(
  docId: string,
  baseVersion: number,
  batchId: string,
  id: string,
  status: SuggestionStatus,
  conflict?: DocSuggestion["conflict"],
  client?: Client,
  now = new Date().toISOString(),
): Promise<number> {
  const c = await readyClient(client);
  return withWriteRetry(async () => {
    const target = writeTarget(docId, "documentSuggestion.updateStatus");
    assertDocumentWriteAllowed(target);
    await assertDocumentWriteAllowedPersisted(c, target);
    const result = await c.execute({
      sql: `UPDATE document_suggestions
        SET status = ?, conflict_json = ?, updated_at = ?
        WHERE doc_id = ? AND base_version = ? AND batch_id = ? AND id = ?`,
      args: [
        status,
        conflict ? JSON.stringify(conflict) : null,
        now,
        docId,
        baseVersion,
        batchId,
        id,
      ],
    });
    return result.rowsAffected;
  });
}

/** rebase 新批次落库后，将被取代且尚未结算的旧批次行保留为失效审计记录。 */
export async function ignoreRebasedDocumentSuggestions(
  docId: string,
  baseVersion: number,
  suggestionIds: readonly string[],
  client?: Client,
  now = new Date().toISOString(),
): Promise<number> {
  return ignoreRebasedDocumentSuggestionsInBatch(
    docId,
    baseVersion,
    LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
    suggestionIds,
    client,
    now,
  );
}

export async function ignoreRebasedDocumentSuggestionsInBatch(
  docId: string,
  baseVersion: number,
  batchId: string,
  suggestionIds: readonly string[],
  client?: Client,
  now = new Date().toISOString(),
): Promise<number> {
  const ids = [...new Set(suggestionIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  const c = await readyClient(client);
  return withWriteRetry(async () => {
    const target = writeTarget(docId, "documentSuggestion.ignoreRebased");
    assertDocumentWriteAllowed(target);
    await assertDocumentWriteAllowedPersisted(c, target);
    const result = await c.execute({
      sql: `UPDATE document_suggestions
        SET status = 'ignored', conflict_json = NULL, updated_at = ?
        WHERE doc_id = ? AND base_version = ? AND batch_id = ?
          AND id IN (${ids.map(() => "?").join(",")})
          AND status IN ('reviewing','accepted','rejected')`,
      args: [now, docId, baseVersion, batchId, ...ids],
    });
    return result.rowsAffected;
  });
}

export async function listDocumentSuggestionStatuses(
  docId: string,
  baseVersion: number,
  suggestionIds?: readonly string[],
  client?: Client,
): Promise<DocumentSuggestionStatusRecord[]> {
  return listDocumentSuggestionStatusesInBatch(
    docId,
    baseVersion,
    LEGACY_DOCUMENT_SUGGESTION_BATCH_ID,
    suggestionIds,
    client,
  );
}

export async function listDocumentSuggestionStatusesInBatch(
  docId: string,
  baseVersion: number,
  batchId: string,
  suggestionIds?: readonly string[],
  client?: Client,
): Promise<DocumentSuggestionStatusRecord[]> {
  const ids = suggestionIds?.filter(Boolean);
  if (ids && ids.length === 0) return [];
  const c = await readyClient(client);
  const idWhere = ids ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
  const result = await c.execute({
    sql: `SELECT id, status, conflict_json
      FROM document_suggestions
      WHERE doc_id = ? AND base_version = ? AND batch_id = ?${idWhere}`,
    args: [docId, baseVersion, batchId, ...(ids ?? [])],
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    status: String(row.status) as SuggestionStatus,
    conflict: typeof row.conflict_json === "string"
      ? JSON.parse(row.conflict_json) as DocSuggestion["conflict"]
      : undefined,
  }));
}
