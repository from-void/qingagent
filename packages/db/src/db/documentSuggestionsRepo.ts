import type { Client } from "@libsql/client";
import type { AnnotationGroup, DocSuggestion, SuggestionStatus } from "@qingagent/contract-ts";
import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import {
  assertDocumentWriteAllowed,
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

function annotationInsertStatements(
  docId: string,
  baseVersion: number,
  groups: readonly AnnotationGroup[],
  now: string,
) {
  return groups.flatMap((group) => group.anchors.map((anchor, index) => ({
    sql: `INSERT INTO document_suggestions (
      id, doc_id, base_version, status, anchor_json, steps_json, preview_json,
      summary, conflict_json, kind, note, origin, group_id, group_meta_json,
      severity, created_at, updated_at
    ) SELECT ?, ?, ?, 'reviewing', ?, NULL, NULL, ?, NULL, 'annotation', ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM deleted_sessions WHERE session_id = ?)`,
    args: [
      `${group.id}:${index + 1}`, docId, baseVersion, JSON.stringify(anchor), group.summary,
      group.note, group.origin, group.id,
      JSON.stringify({ summary: group.summary, suggestion: group.suggestion, hitCount: group.anchors.length, severity: group.severity }),
      group.severity ?? null,
      now, now, docId,
    ],
  })));
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
    sql: "SELECT 1 FROM deleted_sessions WHERE session_id = ? LIMIT 1",
    args: [target.docId],
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
    const results = await c.batch(annotationInsertStatements(docId, baseVersion, groups, now));
    assertSuggestionWritesAffected(results, target);
  });
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
  await withWriteRetry(() => c.execute({
    sql: `UPDATE document_suggestions SET status='ignored', updated_at=? WHERE doc_id=? AND kind='annotation' AND status IN ('reviewing','accepted')${where}`,
    args: [now, docId, ...ids],
  }));
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
    await c.execute({
      sql: "UPDATE document_suggestions SET status='ignored', updated_at=? WHERE doc_id=? AND kind='annotation' AND status IN ('reviewing','accepted')",
      args: [now, docId],
    });
    const statements = groups.flatMap((group) => group.anchors.map((anchor, mappedIndex) => ({
      sql: `UPDATE document_suggestions SET status=?, anchor_json=?,
        group_meta_json=?, severity=?, updated_at=? WHERE id=? AND doc_id=? AND kind='annotation'`,
      args: [group.status, JSON.stringify(anchor), JSON.stringify({ summary: group.summary, suggestion: group.suggestion, hitCount: group.anchors.length, severity: group.severity }), group.severity ?? null, now,
        `${group.id}:${(survivingAnchorIndexes.get(group.id)?.[mappedIndex] ?? mappedIndex) + 1}`, docId],
    })));
    if (statements.length > 0) await c.batch(statements);
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
    const result = await c.execute({
      sql: `INSERT INTO document_suggestions (
          id, doc_id, base_version, batch_id, status, anchor_json, steps_json,
          preview_json, summary, conflict_json, created_at, updated_at
          , severity
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM deleted_sessions WHERE session_id = ?)
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
