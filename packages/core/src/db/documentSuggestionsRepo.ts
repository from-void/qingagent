import type { Client } from "@libsql/client";
import type { DocSuggestion, SuggestionStatus } from "@qingagent/contract-ts";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

async function readyClient(client?: Client): Promise<Client> {
  const c = client ?? getDocumentsClient();
  await ensureMigrated();
  return c;
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          doc_id = excluded.doc_id,
          base_version = excluded.base_version,
          status = excluded.status,
          anchor_json = excluded.anchor_json,
          steps_json = excluded.steps_json,
          preview_json = excluded.preview_json,
          summary = excluded.summary,
          conflict_json = excluded.conflict_json,
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
