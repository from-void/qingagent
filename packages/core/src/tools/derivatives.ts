import { randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import { getStablePmJson, pmToPlainText, type PmDoc } from "@qingagent/pm-schema";
import { z } from "zod";
import { withDtypeCommonConstraints } from "../derivatives/dtypeTemplatePrompts.js";
import {
  buildPmProjection,
  commitTransaction,
  getDerivativeMeta,
  getStyleTemplate,
  listDerivativesByThread,
  parsePmDoc,
  updateParams,
  withTransaction,
} from "@qingagent/db";
import { compileAiDocumentWithBlockRetry, parseAiDocumentFromQingml } from "./generateDoc.js";

type TransactionClient = Parameters<Parameters<typeof withTransaction>[0]>[0];

function sessionIdFrom(context: unknown): string | null {
  const requestContext = (context as { requestContext?: { get?: (key: string) => unknown } })?.requestContext;
  const value = requestContext?.get?.("sessionId");
  return typeof value === "string" ? value : null;
}

export const derivativeBriefTool = createTool({
  id: "derivative_brief",
  description: "读取当前会话衍生稿的模板、补充指令和源文档正文，供本轮直接改写。",
  inputSchema: z.object({ derivativeDocId: z.string().min(1) }),
  outputSchema: z.object({
    ok: z.boolean(), dtype: z.string().optional(), targetLang: z.string().optional(), layoutPrompt: z.string().optional(),
    writingPrompt: z.string().optional(), privatePrompt: z.string().optional(),
    sourceTitle: z.string().optional(), sourceText: z.string().optional(),
    sourceVersion: z.number().optional(), error: z.string().optional(),
  }),
  execute: async (input, context) => {
    const sessionId = sessionIdFrom(context);
    const meta = await getDerivativeMeta(input.derivativeDocId);
    if (!sessionId || !meta || meta.threadId !== sessionId) return { ok: false, error: "衍生稿不存在或不属于当前会话" };
    const writing = await getStyleTemplate(meta.writingStyleId);
    const layout = meta.layoutStyleId ? await getStyleTemplate(meta.layoutStyleId) : null;
    if (!writing) return { ok: false, error: "写作风格模板不存在" };
    return withTransaction<{
      ok: boolean; dtype?: string; targetLang?: string; layoutPrompt?: string; writingPrompt?: string;
      privatePrompt?: string; sourceTitle?: string; sourceText?: string;
      sourceVersion?: number; error?: string;
    }>(async (client) => {
      const result = await client.execute({
        sql: "SELECT title, doc_pm, doc_version FROM documents WHERE id = ? AND thread_id = ? AND role = 'main'",
        args: [meta.sourceDocId, sessionId],
      });
      const source = result.rows[0];
      if (!source) return commitTransaction({ ok: false, error: "源文档不存在" });
      return commitTransaction({ ok: true, dtype: meta.dtype, targetLang: meta.targetLang ?? undefined, layoutPrompt: layout?.prompt ?? "",
        writingPrompt: withDtypeCommonConstraints(meta.dtype, writing.prompt), privatePrompt: meta.privatePrompt,
        sourceTitle: String(source.title), sourceText: pmToPlainText(parsePmDoc(source.doc_pm)),
        sourceVersion: Number(source.doc_version) });
    });
  },
});

export const listDerivativesTool = createTool({
  id: "list_derivatives", description: "列出当前会话衍生稿及其排版风格、写作风格、补充指令和过期状态。",
  inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean(), items: z.array(z.object({ docId:z.string(),dtype:z.string(),layoutStyleName:z.string().nullable(),writingStyleName:z.string(),privatePrompt:z.string(),stale:z.boolean() })), error:z.string().optional() }),
  execute: async (_input, context) => { const sessionId=sessionIdFrom(context); if(!sessionId) return {ok:false,items:[],error:"缺少当前会话"}; const xs=await listDerivativesByThread(sessionId); return {ok:true,items:xs.map(x=>({docId:x.docId,dtype:x.dtype,layoutStyleName:x.layoutStyleName,writingStyleName:x.writingStyleName,privatePrompt:x.privatePrompt,stale:x.stale}))}; },
});

export const updateDerivativeParamsTool = createTool({
  id: "update_derivative_params", description: "更新当前会话某篇衍生稿的排版、写作风格或补充指令；privatePrompt 传入即整体替换。",
  inputSchema: z.object({ derivativeDocId:z.string().min(1),layoutStyleId:z.string().min(1).optional(),writingStyleId:z.string().min(1).optional(),privatePrompt:z.string().optional() }),
  outputSchema:z.object({ok:z.boolean(),error:z.string().optional()}),
  execute:async(input,context)=>{const sessionId=sessionIdFrom(context);const meta=await getDerivativeMeta(input.derivativeDocId);if(!sessionId||!meta||meta.threadId!==sessionId)return{ok:false,error:"衍生稿不存在或不属于当前会话"};try{await updateParams(meta.docId,input.writingStyleId??meta.writingStyleId,input.privatePrompt===undefined?meta.privatePrompt:input.privatePrompt,input.layoutStyleId??meta.layoutStyleId);return{ok:true};}catch(e){return{ok:false,error:e instanceof Error?e.message:String(e)}}},
});

export interface CommitDerivativeQingmlResult {
  ok: boolean;
  wroteBlocks?: number;
  docVersion?: number;
  generatedAt?: string;
  error?: string;
}

/**
 * 已编译衍生稿的短事务写入体。单独导出是为了让工具与并发旁支共享完全相同的
 * CAS / 版本快照 / 源版本盖章语义，并可直接覆盖 CAS 未命中的脏路径测试。
 */
export async function commitCompiledDerivative(
  client: Pick<TransactionClient, "execute">,
  input: { derivativeDocId: string; sessionId: string; doc: PmDoc },
): Promise<CommitDerivativeQingmlResult> {
  const rows = await client.execute({
    sql: `SELECT derivative.doc_version, source.doc_version AS source_version
      FROM documents derivative JOIN document_derivatives meta ON meta.doc_id = derivative.id
      JOIN documents source ON source.id = meta.source_doc_id
      WHERE derivative.id = ? AND derivative.thread_id = ? AND derivative.role = 'derivative'`,
    args: [input.derivativeDocId, input.sessionId],
  });
  const row = rows.rows[0];
  if (!row) return { ok: false, error: "衍生稿不存在或不属于当前会话" };
  const previousVersion = Number(row.doc_version);
  const docVersion = previousVersion + 1;
  const sourceVersion = Number(row.source_version);
  const now = new Date().toISOString();
  const projection = buildPmProjection({ pmDoc: input.doc });
  const updated = await client.execute({
    sql: `UPDATE documents SET doc_pm = ?, doc_schema_version = ?, content_hash = ?,
      doc_format = ?, doc_version = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND thread_id = ? AND role = 'derivative' AND doc_version = ?`,
    args: [projection.pmJson, projection.schemaVersion, projection.contentHash, projection.docFormat,
      docVersion, now, input.derivativeDocId, input.sessionId, previousVersion],
  });
  // CAS 未命中(并发重生成撞版本)必须失败返回,否则版本快照/盖章照写会假报成功。
  if (Number(updated.rowsAffected ?? 0) !== 1) {
    return { ok: false, error: "衍生稿版本已被并发更新,请重试" };
  }
  await client.execute({
    sql: `INSERT INTO document_versions (version_id, doc_id, doc_version, content_hash,
      schema_version, actor_type, summary, snapshot_pm, parent_version, created_at)
      VALUES (?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?)`,
    args: [randomUUID(), input.derivativeDocId, docVersion, projection.contentHash,
      projection.schemaVersion, "生成衍生稿", getStablePmJson(input.doc),
      previousVersion > 0 ? previousVersion : null, now],
  });
  await client.execute({
    sql: "UPDATE document_derivatives SET source_version = ?, generated_at = ?, updated_at = ? WHERE doc_id = ?",
    args: [sourceVersion, now, now, input.derivativeDocId],
  });
  return { ok: true, wroteBlocks: input.doc.content.length, docVersion, generatedAt: now };
}

/** 把完整 QingML 编译并以 CAS 短事务写入衍生稿。 */
export async function commitDerivativeQingml(
  derivativeDocId: string,
  sessionId: string,
  qingml: string,
): Promise<CommitDerivativeQingmlResult> {
  let compiled;
  try {
    const parsed = parseAiDocumentFromQingml(qingml);
    compiled = await compileAiDocumentWithBlockRetry(parsed.document, undefined, 0);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!compiled.success) return { ok: false, error: compiled.error };
  return withTransaction(async (client) => commitTransaction(await commitCompiledDerivative(client, {
    derivativeDocId,
    sessionId,
    doc: compiled.doc,
  })));
}

export const generateDerivativeTool = createTool({
  id: "generate_derivative",
  description: "把 QingML 整文编译并写入当前会话指定的衍生稿，生成独立 AI 版本快照。",
  inputSchema: z.object({ derivativeDocId: z.string().min(1), qingml: z.string().min(1) }),
  outputSchema: z.object({ ok: z.boolean(), wroteBlocks: z.number().optional(), docVersion: z.number().optional(), error: z.string().optional() }),
  execute: async (input, context) => {
    const sessionId = sessionIdFrom(context);
    const meta = await getDerivativeMeta(input.derivativeDocId);
    if (!sessionId || !meta || meta.threadId !== sessionId) return { ok: false, error: "衍生稿不存在或不属于当前会话" };
    const result = await commitDerivativeQingml(input.derivativeDocId, sessionId, input.qingml);
    // 工具协议行为零变化：generatedAt 只供旁支 finished 帧使用，不扩展工具 output。
    const { generatedAt: _generatedAt, ...toolResult } = result;
    return toolResult;
  },
});
