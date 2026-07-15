import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export interface LexiconResource {
  id: string;
  name: string;
  entryCount: number;
  description: string;
}

export interface LexiconEntry {
  id: string;
  resourceId: string;
  word: string;
  replacement: string | null;
  enabled: boolean;
  note: string | null;
}

async function readyClient(client?: Client): Promise<Client> {
  const c = client ?? getDocumentsClient();
  await ensureMigrated();
  return c;
}

export async function listLexicons(client?: Client): Promise<LexiconResource[]> {
  const c = await readyClient(client);
  const result = await c.execute(`SELECT r.id, r.name, r.meta_json, COUNT(e.id) AS entry_count
    FROM skill_resources r
    LEFT JOIN lexicon_entries e ON e.resource_id = r.id
    WHERE r.kind = 'lexicon'
    GROUP BY r.id, r.name, r.meta_json
    ORDER BY r.created_at, r.id`);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    entryCount: Number(row.entry_count),
    description: (() => { try { const meta=JSON.parse(String(row.meta_json)); return typeof meta.description === "string" ? meta.description : ""; } catch { return ""; } })(),
  }));
}

export async function listLexiconEntries(
  resourceIds: string[],
  client?: Client,
): Promise<LexiconEntry[]> {
  if (resourceIds.length === 0) return [];
  const c = await readyClient(client);
  const placeholders = resourceIds.map(() => "?").join(", ");
  const result = await c.execute({
    sql: `SELECT id, resource_id, word, replacement, enabled, note
      FROM lexicon_entries
      WHERE enabled = 1 AND resource_id IN (${placeholders})
      ORDER BY created_at, id`,
    args: resourceIds,
  });
  return result.rows.map((row) => ({
    id: String(row.id),
    resourceId: String(row.resource_id),
    word: String(row.word),
    replacement: row.replacement == null ? null : String(row.replacement),
    enabled: Number(row.enabled) === 1,
    note: row.note == null ? null : String(row.note),
  }));
}

export async function createLexicon(name: string, client?: Client): Promise<LexiconResource> {
  const c = await readyClient(client);
  const id = `lexicon-${randomUUID()}`;
  const now = new Date().toISOString();
  await withWriteRetry(() => c.execute({
    sql: `INSERT INTO skill_resources (id, kind, name, meta_json, created_at, updated_at)
      VALUES (?, 'lexicon', ?, '{}', ?, ?)`,
    args: [id, name.trim(), now, now],
  }));
  return { id, name: name.trim(), entryCount: 0, description: "用户自定义敏感词库。" };
}

export async function addLexiconEntries(
  resourceId: string,
  entries: Array<{ word: string; replacement?: string; note?: string }>,
  client?: Client,
): Promise<number> {
  const normalized = entries.filter((entry) => entry.word.trim().length > 0);
  if (normalized.length === 0) return 0;
  const c = await readyClient(client);
  const now = new Date().toISOString();
  await withWriteRetry(async () => {
    for (const entry of normalized) {
      await c.execute({
        sql: `INSERT INTO lexicon_entries
          (id, resource_id, word, replacement, enabled, note, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        args: [randomUUID(), resourceId, entry.word.trim(), entry.replacement?.trim() || null, entry.note?.trim() || null, now, now],
      });
    }
    await c.execute({ sql: "UPDATE skill_resources SET updated_at = ? WHERE id = ?", args: [now, resourceId] });
  });
  return normalized.length;
}

export async function removeLexiconEntries(
  resourceId: string,
  words: string[],
  client?: Client,
): Promise<number> {
  const normalized = Array.from(new Set(words.map((word) => word.trim()).filter(Boolean)));
  if (normalized.length === 0) return 0;
  const c = await readyClient(client);
  const placeholders = normalized.map(() => "?").join(", ");
  let removed = 0;
  await withWriteRetry(async () => {
    const result = await c.execute({
      sql: `DELETE FROM lexicon_entries WHERE resource_id = ? AND word IN (${placeholders})`,
      args: [resourceId, ...normalized],
    });
    removed = result.rowsAffected;
    await c.execute({
      sql: "UPDATE skill_resources SET updated_at = ? WHERE id = ?",
      args: [new Date().toISOString(), resourceId],
    });
  });
  return removed;
}

export async function updateLexiconEntries(resourceId: string, entries: Array<{ word: string; replacement?: string; note?: string }>, client?: Client): Promise<number> {
  const normalized=entries.filter(e=>e.word.trim()); if(!normalized.length)return 0; const c=await readyClient(client); let affected=0; const now=new Date().toISOString();
  await withWriteRetry(async()=>{for(const e of normalized){const r=await c.execute({sql:"UPDATE lexicon_entries SET replacement=?,note=?,updated_at=? WHERE resource_id=? AND word=?",args:[e.replacement?.trim()||null,e.note?.trim()||null,now,resourceId,e.word.trim()]});affected+=Number(r.rowsAffected)}await c.execute({sql:"UPDATE skill_resources SET updated_at=? WHERE id=?",args:[now,resourceId]})}); return affected;
}

export async function deleteLexiconResource(resourceId: string, client?: Client): Promise<boolean> {
  const c=await readyClient(client); if(resourceId.startsWith("lexicon-advertising-")||resourceId.startsWith("lexicon-medical-")||resourceId==="lexicon-official-writing"||resourceId==="lexicon-social-media-marketing")throw new Error("内置词库不可删除");
  const r=await withWriteRetry(()=>c.execute({sql:"DELETE FROM skill_resources WHERE id=? AND kind='lexicon'",args:[resourceId]}));return Number(r.rowsAffected)===1;
}
