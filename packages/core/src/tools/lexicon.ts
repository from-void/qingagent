import { createTool } from "@mastra/core/tools";
import type { PmDoc } from "@qingagent/pm-schema";
import { z } from "zod";
import { collectTopLevelTextBlocks } from "../utils/pmTextBlocks.js";
import {
  addLexiconEntries,
  createLexicon,
  listLexiconEntries,
  listLexicons,
  removeLexiconEntries,
  updateLexiconEntries,
  deleteLexiconResource,
} from "@qingagent/db";
import { scanText } from "../review/sensitiveScan.js";

function readCurrentDocument(context: unknown): PmDoc | null {
  const requestContext = (context as { requestContext?: { get?: (key: string) => unknown } })
    .requestContext;
  const doc = requestContext?.get?.("doc");
  if (!doc || typeof doc !== "object" || (doc as { type?: unknown }).type !== "doc") return null;
  return doc as PmDoc;
}

export const lexiconListTool = createTool({
  id: "lexicon_list",
  description: "列出可用于敏感词、违禁词或极限词审查的词库、启用状态及词条数量。",
  inputSchema: z.object({}),
  outputSchema: z.object({
    ok: z.boolean(),
    lexicons: z.array(z.object({ id: z.string(), name: z.string(), entryCount: z.number(), enabled: z.boolean() })),
  }),
  execute: async () => ({ ok: true, lexicons: await listLexicons() }),
});

export const sensitiveScanTool = createTool({
  id: "sensitive_scan",
  description: "使用指定词库确定性扫描当前会话文档。每个命中只标注风险并进入上下文判断；replacementHint 仅是词库候选，禁止直接替换正文。",
  inputSchema: z.object({
    resourceIds: z.array(z.string().min(1)).min(1).describe("要启用的词库 id"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    hits: z.array(z.object({
      word: z.string(), replacementHint: z.string().nullable(), reviewAction: z.literal("annotate"), note: z.string().nullable(),
      count: z.number(), samples: z.array(z.string()),
    })),
    totalCount: z.number(),
    scannedChars: z.number(),
    error: z.string().optional(),
  }),
  execute: async (input, context) => {
    const doc = readCurrentDocument(context);
    if (!doc) {
      return { ok: false, hits: [], totalCount: 0, scannedChars: 0, error: "当前会话没有可扫描的文档" };
    }
    // 用 editDraft 字面匹配同一套文本抽取(行内节点正确拼接、按块分行):
    // 保证扫描命中的词在后续 editDraft replaceText 的匹配空间里一定找得到。
    const text = collectTopLevelTextBlocks(doc).map((block) => block.text).join("\n");
    // UI 展示、模型可见列表和最终扫描共用数据库里的 enabled；即使模型误传了
    // 已关闭词库，也不能出现“界面单库、实际四库”的静默错位。
    const enabledResourceIds = new Set(
      (await listLexicons()).filter((resource) => resource.enabled).map((resource) => resource.id),
    );
    const resourceIds = input.resourceIds.filter((id) => enabledResourceIds.has(id));
    const entries = await listLexiconEntries(resourceIds);
    const hits = scanText(text, entries);
    return {
      ok: true,
      hits,
      totalCount: hits.reduce((total, hit) => total + hit.count, 0),
      scannedChars: text.length,
    };
  },
});

const manageEntrySchema = z.object({
  word: z.string().min(1),
  replacement: z.string().optional(),
  note: z.string().optional(),
});

export const lexiconManageTool = createTool({
  id: "lexicon_manage",
  description: "新建或删除敏感词词库，或添加、更新、删除指定词条。",
  inputSchema: z.object({
    action: z.enum(["create", "add", "remove", "update", "delete_resource"]),
    name: z.string().optional(),
    resourceId: z.string().optional(),
    entries: z.array(manageEntrySchema).optional(),
    words: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    action: z.string(),
    summary: z.string(),
    resource: z.object({ id: z.string(), name: z.string(), entryCount: z.number() }).optional(),
    affected: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    if (input.action === "create") {
      if (!input.name?.trim()) return { ok: false, action: input.action, summary: "创建失败", error: "缺少词库名称" };
      const resource = await createLexicon(input.name);
      return { ok: true, action: input.action, summary: `已创建词库「${resource.name}」`, resource };
    }
    if (!input.resourceId) return { ok: false, action: input.action, summary: "操作失败", error: "缺少词库 id" };
    if (input.action === "add") {
      const affected = await addLexiconEntries(input.resourceId, input.entries ?? []);
      return { ok: true, action: input.action, summary: `已添加 ${affected} 个词条`, affected };
    }
    if(input.action==="update"){const affected=await updateLexiconEntries(input.resourceId,input.entries??[]);return{ok:true,action:input.action,summary:`已更新 ${affected} 个词条`,affected}}
    if(input.action==="delete_resource"){try{const deleted=await deleteLexiconResource(input.resourceId);return{ok:deleted,action:input.action,summary:deleted?"已删除词库":"词库不存在",affected:deleted?1:0}}catch(e){return{ok:false,action:input.action,summary:"删除失败",error:e instanceof Error?e.message:String(e)}}}
    const affected = await removeLexiconEntries(input.resourceId, input.words ?? []);
    return { ok: true, action: input.action, summary: `已删除 ${affected} 个词条`, affected };
  },
});
