import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { buildPmProjection, parsePmDoc } from "./documentRepo.js";
import { commitTransaction, getDocumentsClient, withTransaction, withWriteRetry } from "./documentsClient.js";
import { ensureMigrated } from "./migrations.js";
import { deleteDocumentFamilyByDocIds } from "./documentFamilyRepo.js";
import { getDefaultStyleTemplate, getStyleTemplate } from "./styleTemplateRepo.js";
import type { PmDoc } from "@qingagent/pm-schema";

export interface DerivativeMeta {
  docId: string;
  threadId: string;
  sourceDocId: string;
  dtype: string;
  templateId: string;
  templateName: string;
  writingStyleId: string;
  writingStyleName: string;
  layoutStyleId: string | null;
  layoutStyleName: string | null;
  targetLang: string | null;
  coverTemplate: "poster" | "magazine" | "wenkai" | "impact" | "note";
  privatePrompt: string;
  sourceVersion: number | null;
  currentSourceVersion: number;
  generatedAt: string | null;
  stale: boolean;
}

const emptyPmDoc = (): PmDoc => ({ type: "doc", attrs: { schemaVersion: 1 }, content: [] });

function mapMeta(row: Record<string, unknown>): DerivativeMeta {
  const sourceVersion = row.source_version == null ? null : Number(row.source_version);
  const currentVersion = Number(row.current_source_version ?? 0);
  const templateId = String(row.template_id);
  return {
    docId: String(row.doc_id),
    threadId: String(row.thread_id),
    sourceDocId: String(row.source_doc_id),
    dtype: String(row.dtype),
    templateId,
    templateName: String(row.writing_style_name ?? templateId),
    writingStyleId: templateId,
    writingStyleName: String(row.writing_style_name ?? templateId),
    layoutStyleId: row.layout_style_id == null ? null : String(row.layout_style_id),
    layoutStyleName: row.layout_style_name == null ? null : String(row.layout_style_name),
    targetLang: row.target_lang == null ? null : String(row.target_lang),
    coverTemplate: (["poster", "magazine", "wenkai", "impact", "note"] as const).includes(row.cover_template as never) ? row.cover_template as DerivativeMeta["coverTemplate"] : "poster",
    privatePrompt: String(row.private_prompt ?? ""),
    sourceVersion,
    currentSourceVersion: currentVersion,
    generatedAt: row.generated_at == null ? null : String(row.generated_at),
    stale: sourceVersion != null && sourceVersion < currentVersion,
  };
}

const META_SELECT = `SELECT d.doc_id, doc.thread_id, d.source_doc_id, d.dtype,
  d.template_id, writing.name AS writing_style_name, d.layout_style_id,
  layout.name AS layout_style_name, d.target_lang, d.cover_template, d.private_prompt, d.source_version, d.generated_at,
  source.doc_version AS current_source_version
  FROM document_derivatives d
  JOIN documents doc ON doc.id = d.doc_id AND doc.role = 'derivative'
  JOIN documents source ON source.id = d.source_doc_id AND source.role = 'main'
  LEFT JOIN style_templates writing ON writing.resource_id = d.template_id
  LEFT JOIN style_templates layout ON layout.resource_id = d.layout_style_id`;

export async function createDerivativeDoc(input: {
  threadId: string;
  sourceDocId: string;
  dtype: string;
  templateId?: string;
  writingStyleId?: string;
  layoutStyleId?: string | null;
  targetLang?: string | null;
  privatePrompt: string;
}): Promise<DerivativeMeta> {
  await ensureMigrated();
  const targetLang = input.targetLang?.trim() || null;
  if (input.dtype === "translate" && !targetLang) throw new Error("翻译稿必须指定目标语言");
  const writing = input.writingStyleId ? await getStyleTemplate(input.writingStyleId) : input.templateId ? await getStyleTemplate(input.templateId) : await getDefaultStyleTemplate(input.dtype, "writing");
  const layout = input.layoutStyleId === null ? null : input.layoutStyleId ? await getStyleTemplate(input.layoutStyleId) : await getDefaultStyleTemplate(input.dtype, "layout");
  if (!writing || writing.dtype !== input.dtype || writing.slot !== "writing") throw new Error("未知的写作风格模板");
  if (layout && (layout.dtype !== input.dtype || layout.slot !== "layout")) throw new Error("未知的排版风格模板");
  return withTransaction(async (client) => {
    const existing = await client.execute(input.dtype === "translate" ? {
      sql: `${META_SELECT} WHERE doc.thread_id = ? AND d.dtype = ? AND d.target_lang = ? LIMIT 1`,
      args: [input.threadId, input.dtype, targetLang],
    } : {
      sql: `${META_SELECT} WHERE doc.thread_id = ? AND d.dtype = ? LIMIT 1`,
      args: [input.threadId, input.dtype],
    });
    const existingRow = existing.rows[0];
    if (existingRow) {
      // get-or-create 语义:UI「调整模板」后重新生成走的也是这里,已存在实例必须刷新
      // 模板与私有指令,否则 derivative_brief 读到的永远是首次创建时的旧参数。
      const existingMeta = mapMeta(existingRow);
      if (existingMeta.writingStyleId !== writing.id || existingMeta.layoutStyleId !== (layout?.id ?? null) || existingMeta.privatePrompt !== input.privatePrompt) {
        const now = new Date().toISOString();
        await client.execute({
          sql: "UPDATE document_derivatives SET template_id = ?, layout_style_id = ?, private_prompt = ?, updated_at = ? WHERE doc_id = ?",
          args: [writing.id, layout?.id ?? null, input.privatePrompt, now, existingMeta.docId],
        });
        await client.execute({
          sql: "UPDATE documents SET title = ?, updated_at = ? WHERE id = ? AND role = 'derivative'",
          args: [writing.name, now, existingMeta.docId],
        });
        const refreshed = await client.execute({ sql: `${META_SELECT} WHERE d.doc_id = ?`, args: [existingMeta.docId] });
        return commitTransaction(mapMeta(refreshed.rows[0]!));
      }
      return commitTransaction(existingMeta);
    }
    const sourceResult = await client.execute({
      sql: "SELECT resource_id FROM documents WHERE id = ? AND thread_id = ? AND role = 'main'",
      args: [input.sourceDocId, input.threadId],
    });
    const source = sourceResult.rows[0];
    if (!source) throw new Error("源文档不存在或不属于当前会话");
    const docId = randomUUID();
    const now = new Date().toISOString();
    const projection = buildPmProjection({ pmDoc: emptyPmDoc() });
    await client.execute({
      sql: `INSERT INTO documents (id, thread_id, resource_id, title, doc_state, doc_version,
        last_synced_version, doc_pm, doc_schema_version, content_hash, doc_format, version,
        created_at, updated_at, role) VALUES (?, ?, ?, ?, 'editing', 0, 0, ?, ?, ?, ?, 1, ?, ?, 'derivative')`,
      args: [docId, input.threadId, String(source.resource_id), writing.name, projection.pmJson,
        projection.schemaVersion, projection.contentHash, projection.docFormat, now, now],
    });
    await client.execute({
      sql: `INSERT INTO document_derivatives (doc_id, source_doc_id, dtype, template_id, layout_style_id,
        target_lang, private_prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [docId, input.sourceDocId, input.dtype, writing.id, layout?.id ?? null, targetLang, input.privatePrompt, now, now],
    });
    const created = await client.execute({ sql: `${META_SELECT} WHERE d.doc_id = ?`, args: [docId] });
    return commitTransaction(mapMeta(created.rows[0]!));
  });
}

export async function listDerivativesByThread(threadId: string, client?: Client): Promise<DerivativeMeta[]> {
  await ensureMigrated();
  const result = await (client ?? getDocumentsClient()).execute({
    sql: `${META_SELECT} WHERE doc.thread_id = ? ORDER BY d.created_at`, args: [threadId],
  });
  return result.rows.map(mapMeta);
}

export async function getDerivativeMeta(docId: string, client?: Client): Promise<DerivativeMeta | null> {
  await ensureMigrated();
  const result = await (client ?? getDocumentsClient()).execute({ sql: `${META_SELECT} WHERE d.doc_id = ?`, args: [docId] });
  return result.rows[0] ? mapMeta(result.rows[0]) : null;
}

export async function deleteDerivativeDoc(threadId: string, docId: string): Promise<boolean> {
  await ensureMigrated();
  return withTransaction(async (client) => {
    const owned = await client.execute({
      sql: "SELECT id FROM documents WHERE id = ? AND thread_id = ? AND role = 'derivative'",
      args: [docId, threadId],
    });
    if (!owned.rows[0]) return commitTransaction(false);
    await deleteDocumentFamilyByDocIds(client, [docId]);
    return commitTransaction(true);
  });
}

export async function stampGenerated(docId: string, sourceVersion: number, client?: Client): Promise<void> {
  await ensureMigrated();
  const now = new Date().toISOString();
  await withWriteRetry(() => (client ?? getDocumentsClient()).execute({
    sql: "UPDATE document_derivatives SET source_version = ?, generated_at = ?, updated_at = ? WHERE doc_id = ?",
    args: [sourceVersion, now, now, docId],
  }).then(() => undefined));
}

export async function updateParams(docId: string, writingStyleId: string, privatePrompt: string, layoutStyleId?: string | null, coverTemplate?: DerivativeMeta["coverTemplate"]): Promise<void> {
  await ensureMigrated();
  const template = await getStyleTemplate(writingStyleId);
  if (!template || template.slot !== "writing") throw new Error("未知的写作风格模板");
  const layout = layoutStyleId == null ? null : await getStyleTemplate(layoutStyleId);
  if (layout && (layout.slot !== "layout" || layout.dtype !== template.dtype)) throw new Error("未知的排版风格模板");
  const now = new Date().toISOString();
  await withWriteRetry(async () => {
    await getDocumentsClient().execute({
      sql: "UPDATE document_derivatives SET template_id = ?, layout_style_id = COALESCE(?, layout_style_id), private_prompt = ?, cover_template = COALESCE(?, cover_template), updated_at = ? WHERE doc_id = ?",
      args: [writingStyleId, layoutStyleId ?? null, privatePrompt, coverTemplate ?? null, now, docId],
    });
    await getDocumentsClient().execute({ sql: "UPDATE documents SET title = ?, updated_at = ? WHERE id = ? AND role = 'derivative'", args: [template.name, now, docId] });
  });
}

export async function getDerivativeDocument(docId: string): Promise<{ pmDoc: PmDoc; docPm: string; docVersion: number; title: string } | null> {
  await ensureMigrated();
  const result = await getDocumentsClient().execute({ sql: "SELECT doc_pm, doc_version, title FROM documents WHERE id = ? AND role = 'derivative'", args: [docId] });
  const row = result.rows[0];
  if (!row) return null;
  return { pmDoc: parsePmDoc(row.doc_pm), docPm: String(row.doc_pm), docVersion: Number(row.doc_version), title: String(row.title) };
}
