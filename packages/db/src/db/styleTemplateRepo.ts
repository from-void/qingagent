import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  commitTransaction,
  getDocumentsClient,
  withTransaction,
  withWriteRetry,
} from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";

export type StyleTemplateSlot = "layout" | "writing" | "instruction";
export const STYLE_TEMPLATE_DTYPES = ["gzh", "xhs", "translate", "deai"] as const;
export type StyleTemplateDtype = typeof STYLE_TEMPLATE_DTYPES[number];
export interface StyleTemplate { id: string; dtype: string; slot: StyleTemplateSlot; name: string; detail: string; prompt: string; builtin: boolean }

export class StyleTemplateInUseError extends Error {
  readonly documentCount: number;

  constructor(documentCount: number) {
    super(`仍有 ${documentCount} 篇稿件使用该模板，无法删除`);
    this.name = "StyleTemplateInUseError";
    this.documentCount = documentCount;
  }
}

const map = (row: Record<string, unknown>): StyleTemplate => ({ id: String(row.resource_id), dtype: String(row.dtype), slot: String(row.slot) as StyleTemplateSlot, name: String(row.name), detail: String(row.detail ?? ""), prompt: String(row.prompt), builtin: Number(row.builtin) === 1 });
async function client(c?: Client): Promise<Client> { await ensureMigrated(); return c ?? getDocumentsClient(); }
function assertStyleTemplateDtype(dtype: string): asserts dtype is StyleTemplateDtype {
  if (!(STYLE_TEMPLATE_DTYPES as readonly string[]).includes(dtype)) {
    throw new Error(`未知的风格模板 dtype「${dtype}」，仅支持 ${STYLE_TEMPLATE_DTYPES.join("/")}`);
  }
}

export async function listStyleTemplates(filter: { dtype?: string; slot?: StyleTemplateSlot } = {}, c?: Client): Promise<StyleTemplate[]> {
  const db = await client(c); const where: string[] = []; const args: string[] = [];
  if (filter.dtype && filter.dtype !== "all") { assertStyleTemplateDtype(filter.dtype); where.push("dtype = ?"); args.push(filter.dtype); }
  if (filter.slot) { where.push("slot = ?"); args.push(filter.slot); }
  const result = await db.execute({ sql: `SELECT * FROM style_templates${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY dtype, slot, builtin DESC, name`, args });
  return result.rows.map(map);
}
export async function getStyleTemplate(id: string, c?: Client): Promise<StyleTemplate | null> { const db = await client(c); const r = await db.execute({ sql: "SELECT * FROM style_templates WHERE resource_id = ?", args: [id] }); return r.rows[0] ? map(r.rows[0]) : null; }
export async function getDefaultStyleTemplate(dtype: string, slot: StyleTemplateSlot, c?: Client): Promise<StyleTemplate | null> { const xs = await listStyleTemplates({ dtype, slot }, c); return xs.find(x => x.builtin) ?? xs[0] ?? null; }
export async function saveStyleTemplate(input: { id?: string; dtype: string; slot: StyleTemplateSlot; name: string; detail?: string; prompt: string }, c?: Client): Promise<StyleTemplate> {
  assertStyleTemplateDtype(input.dtype);
  const db = await client(c); const id = input.id ?? `style-${randomUUID()}`; const now = new Date().toISOString();
  await withWriteRetry(async () => {
    const old = await getStyleTemplate(id, db);
    if (old) {
      // 用户编辑预制项后即成为普通用户模板语义，后续允许删除且迁移 seed 不再覆盖。
      const detail = input.detail === undefined ? old.detail : input.detail.trim();
      await db.execute({ sql: "UPDATE style_templates SET dtype=?,slot=?,name=?,detail=?,prompt=?,builtin=0 WHERE resource_id=?", args: [input.dtype,input.slot,input.name.trim(),detail,input.prompt.trim(),id] });
      await db.execute({ sql: "UPDATE skill_resources SET name=?,updated_at=? WHERE id=?", args: [input.name.trim(),now,id] });
    } else {
      await db.execute({ sql: "INSERT INTO skill_resources(id,kind,name,meta_json,created_at,updated_at) VALUES(?,'style-template',?,'{}',?,?)", args: [id,input.name.trim(),now,now] });
      await db.execute({ sql: "INSERT INTO style_templates(resource_id,dtype,slot,name,detail,prompt,builtin) VALUES(?,?,?,?,?,?,0)", args: [id,input.dtype,input.slot,input.name.trim(),input.detail?.trim() ?? "",input.prompt.trim()] });
    }
  });
  return (await getStyleTemplate(id, db))!;
}
export async function deleteStyleTemplate(id: string, c?: Client): Promise<boolean> {
  const remove = async (db: Client): Promise<boolean> => {
    const old = await getStyleTemplate(id, db);
    if (!old) return false;
    if (old.builtin) throw new Error("内置模板不可删除");
    const result = await db.execute({
      sql: `DELETE FROM skill_resources
        WHERE id=? AND kind='style-template'
          AND (SELECT COUNT(*) FROM style_templates WHERE dtype=? AND slot=?) > 1
          AND NOT EXISTS (
            SELECT 1 FROM document_derivatives
            WHERE template_id=? OR layout_style_id=?
          )`,
      args: [id, old.dtype, old.slot, id, id],
    });
    if (Number(result.rowsAffected) === 0) {
      const references = await db.execute({
        sql: `SELECT COUNT(DISTINCT doc_id) AS count
          FROM document_derivatives
          WHERE template_id=? OR layout_style_id=?`,
        args: [id, id],
      });
      const documentCount = Number(references.rows[0]?.count ?? 0);
      if (documentCount > 0) throw new StyleTemplateInUseError(documentCount);
      if (!await getStyleTemplate(id, db)) return false;
      throw new Error("每类至少保留一个模板");
    }
    return true;
  };

  if (c) return withWriteRetry(() => remove(c));
  await ensureMigrated();
  return withTransaction(async (db) => commitTransaction(await remove(db)));
}
