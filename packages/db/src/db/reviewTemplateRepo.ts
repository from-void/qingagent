import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { ReviewTemplateItem, ReviewType } from "@qingagent/contract-ts";
import { getDocumentsClient, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export type ReviewTemplate = ReviewTemplateItem;

function mapTemplate(row: Record<string, unknown>): ReviewTemplate {
  return {
    id: String(row.id),
    type: String(row.type) as ReviewType,
    name: String(row.name),
    prompt: String(row.prompt),
    builtin: Number(row.builtin) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function dbClient(client?: Client): Promise<Client> {
  await ensureMigrated();
  return client ?? getDocumentsClient();
}

export async function listReviewTemplates(type: ReviewType, client?: Client): Promise<ReviewTemplate[]> {
  const db = await dbClient(client);
  const result = await db.execute({
    sql: "SELECT * FROM review_templates WHERE type=? ORDER BY builtin DESC, name, id",
    args: [type],
  });
  return result.rows.map(mapTemplate);
}

export async function getReviewTemplate(id: string, client?: Client): Promise<ReviewTemplate | null> {
  const db = await dbClient(client);
  const result = await db.execute({ sql: "SELECT * FROM review_templates WHERE id=?", args: [id] });
  return result.rows[0] ? mapTemplate(result.rows[0]) : null;
}

export async function getSelectedReviewTemplate(type: ReviewType, client?: Client): Promise<ReviewTemplate | null> {
  const db = await dbClient(client);
  const selected = await db.execute({
    sql: `SELECT t.* FROM review_template_selections s
      JOIN review_templates t ON t.id=s.template_id
      WHERE s.type=? AND t.type=?`,
    args: [type, type],
  });
  if (selected.rows[0]) return mapTemplate(selected.rows[0]);
  const items = await listReviewTemplates(type, db);
  return items.find((item) => item.builtin) ?? items[0] ?? null;
}

export async function selectReviewTemplate(type: ReviewType, templateId: string, client?: Client): Promise<ReviewTemplate> {
  const db = await dbClient(client);
  const template = await getReviewTemplate(templateId, db);
  if (!template || template.type !== type) throw new Error("审查模板不存在或类型不匹配");
  const now = new Date().toISOString();
  await withWriteRetry(() => db.execute({
    sql: `INSERT INTO review_template_selections(type,template_id,updated_at) VALUES(?,?,?)
      ON CONFLICT(type) DO UPDATE SET template_id=excluded.template_id,updated_at=excluded.updated_at`,
    args: [type, templateId, now],
  }));
  return template;
}

export async function saveReviewTemplate(
  input: { id?: string; type: ReviewType; name: string; prompt: string },
  client?: Client,
): Promise<ReviewTemplate> {
  const db = await dbClient(client);
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name || !prompt) throw new Error("模板名称和内容不能为空");
  const now = new Date().toISOString();
  const id = input.id ?? `review-${randomUUID()}`;
  const existing = await getReviewTemplate(id, db);
  if (existing && existing.type !== input.type) throw new Error("不能修改审查模板类型");
  await withWriteRetry(() => existing
    ? db.execute({
      sql: "UPDATE review_templates SET name=?,prompt=?,builtin=0,updated_at=? WHERE id=?",
      args: [name, prompt, now, id],
    })
    : db.execute({
      sql: `INSERT INTO review_templates(id,type,name,prompt,builtin,created_at,updated_at)
        VALUES(?,?,?,?,0,?,?)`,
      args: [id, input.type, name, prompt, now, now],
    }));
  return (await getReviewTemplate(id, db))!;
}

export async function deleteReviewTemplate(id: string, client?: Client): Promise<boolean> {
  const db = await dbClient(client);
  const existing = await getReviewTemplate(id, db);
  if (!existing) return false;
  const selected = await getSelectedReviewTemplate(existing.type, db);
  const result = await withWriteRetry(() => db.execute({
    sql: `DELETE FROM review_templates
      WHERE id=? AND (SELECT COUNT(*) FROM review_templates WHERE type=?) > 1`,
    args: [id, existing.type],
  }));
  if (Number(result.rowsAffected) === 0) {
    if (!await getReviewTemplate(id, db)) return false;
    throw new Error("每类至少保留一个模板");
  }
  if (selected?.id === id) {
    const remaining = await listReviewTemplates(existing.type, db);
    const fallback = remaining.find((item) => item.builtin) ?? remaining[0];
    if (fallback) await selectReviewTemplate(existing.type, fallback.id, db);
  }
  return true;
}

export async function getReviewDocSupplement(docId: string, type: ReviewType, client?: Client): Promise<string> {
  const db = await dbClient(client);
  const result = await db.execute({
    sql: "SELECT supplement FROM review_doc_supplements WHERE doc_id=? AND type=?",
    args: [docId, type],
  });
  return String(result.rows[0]?.supplement ?? "");
}

export async function upsertReviewDocSupplement(
  docId: string,
  type: ReviewType,
  supplement: string,
  client?: Client,
): Promise<string> {
  const db = await dbClient(client);
  const now = new Date().toISOString();
  await withWriteRetry(() => db.execute({
    sql: `INSERT INTO review_doc_supplements(doc_id,type,supplement,created_at,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(doc_id,type) DO UPDATE SET
      supplement=excluded.supplement,updated_at=excluded.updated_at`,
    args: [docId, type, supplement, now, now],
  }));
  return supplement;
}
