import type { Client } from "@libsql/client";
import type { AnnotationGroup, DocSuggestion, SuggestionStatus } from "@qingagent/contract-ts";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

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
    ) VALUES (?, ?, ?, 'reviewing', ?, NULL, NULL, ?, NULL, 'annotation', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `${group.id}:${index + 1}`, docId, baseVersion, JSON.stringify(anchor), group.summary,
      group.note, group.origin, group.id,
      JSON.stringify({ summary: group.summary, suggestion: group.suggestion, hitCount: group.anchors.length, severity: group.severity }),
      group.severity ?? null,
      now, now,
    ],
  })));
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
    await c.batch(annotationInsertStatements(docId, baseVersion, groups, now));
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
  await withWriteRetry(async () => {
    await c.batch([
      {
        sql: `UPDATE document_suggestions SET status='ignored', updated_at=?
          WHERE doc_id=? AND kind='annotation' AND origin IN (${origins.map(() => "?").join(",")})
          AND status IN ('reviewing','accepted')`,
        args: [now, docId, ...origins],
      },
      ...annotationInsertStatements(docId, baseVersion, groups, now),
    ]);
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
    await c.execute({
      sql: `INSERT INTO document_suggestions (
          id, doc_id, base_version, status, anchor_json, steps_json,
          preview_json, summary, conflict_json, created_at, updated_at
          , severity
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          doc_id = excluded.doc_id,
          base_version = excluded.base_version,
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
        suggestion.status,
        JSON.stringify(suggestion.anchor),
        JSON.stringify(suggestion.patch.steps),
        JSON.stringify(suggestion.preview),
        suggestion.summary,
        suggestion.conflict ? JSON.stringify(suggestion.conflict) : null,
        now,
        now,
        suggestion.severity ?? null,
      ],
    });
  });
}

export async function updateDocumentSuggestionStatus(
  id: string,
  status: SuggestionStatus,
  conflict?: DocSuggestion["conflict"],
  client?: Client,
  now = new Date().toISOString(),
): Promise<void> {
  const c = await readyClient(client);
  await withWriteRetry(async () => {
    await c.execute({
      sql: `UPDATE document_suggestions
        SET status = ?, conflict_json = ?, updated_at = ?
        WHERE id = ?`,
      args: [status, conflict ? JSON.stringify(conflict) : null, now, id],
    });
  });
}
