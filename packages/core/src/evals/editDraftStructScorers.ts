import { createScorer } from "@mastra/core/evals";
import {
  compileAiDocumentToPm,
  pmDocHasNestedList,
  type AiBlock,
  type PmDoc,
} from "@qingagent/pm-schema";
import { extractJson } from "../bridge/docGenerator.js";
import { normalizeIncomingBlock } from "../bridge/docGenerationEvents.js";
import { editDraftInputSchema } from "../tools/draftMutationSchemas.js";
import { parseAiDocumentOrBlockFromText } from "../tools/generateDoc.js";
import type { ScorerCheck } from "./types.js";

export type EditDraftStructScenarioKey =
  | "insert-table"
  | "expand-faq"
  | "add-checklist"
  | "insert-nested-deep"
  | "insert-callout"
  | "long-taskList"
  | "nested-3level";

export interface EditDraftStructOutput {
  scenarioKey: EditDraftStructScenarioKey;
  raw: string;
}

interface EditDraftStructScenario {
  key: EditDraftStructScenarioKey;
  desc: string;
  structureOk: (input: ValidatedEditDraftStructInput) => ScorerCheck;
}

interface ValidatedEditDraftStructInput {
  ops: unknown[];
  blocks: AiBlock[];
  doc: PmDoc;
}

function deepFind(node: unknown, pred: (n: any) => boolean): any[] {
  const found: any[] = [];
  const walk = (n: any) => {
    if (n == null) return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object") {
      if (pred(n)) found.push(n);
      for (const v of Object.values(n)) walk(v);
    }
  };
  walk(node);
  return found;
}

export const editDraftStructScenarios: EditDraftStructScenario[] = [
  {
    key: "insert-table",
    desc: "小节后插入 3 列对比表",
    structureOk: ({ ops }) => {
      const tables = deepFind(ops, (n) => n.type === "table" && Array.isArray(n.rows));
      if (!tables.length) return { ok: false, note: "无 table" };
      const t = tables[0];
      const header = t.rows[0]?.cells ?? [];
      if (t.rows.length < 4) return { ok: false, note: `行数${t.rows.length}<4` };
      if (header.length !== 3) return { ok: false, note: `列数${header.length}!=3` };
      if (!header.some((c: any) => c?.header === true)) return { ok: false, note: "表头缺header:true" };
      return { ok: true, note: `${t.rows.length}行3列` };
    },
  },
  {
    key: "expand-faq",
    desc: "3 项 FAQ 扩到 6 项",
    structureOk: ({ ops }) => {
      const lists = deepFind(ops, (n) => (n.type === "orderedList" || n.type === "list") && Array.isArray(n.items));
      if (!lists.length) return { ok: false, note: "无 list" };
      const max = Math.max(...lists.map((l) => l.items.length));
      return max >= 6 ? { ok: true, note: `${max}项` } : { ok: false, note: `${max}<6` };
    },
  },
  {
    key: "add-checklist",
    desc: "文末追加 4 项待办 taskList",
    structureOk: ({ ops }) => {
      const tasks = deepFind(ops, (n) => n.type === "taskList" && Array.isArray(n.items));
      if (!tasks.length) return { ok: false, note: "无 taskList" };
      const max = Math.max(...tasks.map((t) => t.items.length));
      return max >= 4 ? { ok: true, note: `${max}项` } : { ok: false, note: `${max}<4` };
    },
  },
  {
    key: "insert-nested-deep",
    desc: "insertBlock 包 3 级嵌套列表",
    structureOk: ({ doc }) => {
      return pmDocHasNestedList(doc, 3) ? { ok: true, note: "深度>=3" } : { ok: false, note: "深度<3" };
    },
  },
  {
    key: "insert-callout",
    desc: "insertBlock 包 callout 高亮框",
    structureOk: ({ ops }) => {
      const callouts = deepFind(ops, (n) => n.type === "callout");
      if (!callouts.length) return { ok: false, note: "无 callout" };
      const c = callouts[0];
      const hasRuns = Array.isArray(c.runs) && c.runs.length > 0;
      return hasRuns ? { ok: true, note: `callout/${c.tone ?? "?"}` } : { ok: false, note: "callout 缺 runs" };
    },
  },
  {
    key: "long-taskList",
    desc: "insertBlock 包 6 项 taskList",
    structureOk: ({ ops }) => {
      const tasks = deepFind(ops, (n) => n.type === "taskList" && Array.isArray(n.items));
      if (!tasks.length) return { ok: false, note: "无 taskList" };
      const max = Math.max(...tasks.map((t) => t.items.length));
      return max >= 6 ? { ok: true, note: `${max}项` } : { ok: false, note: `${max}<6` };
    },
  },
  {
    key: "nested-3level",
    desc: "段落重构成真 3 级嵌套列表",
    structureOk: ({ doc }) => {
      return pmDocHasNestedList(doc, 3) ? { ok: true, note: "深度>=3" } : { ok: false, note: "深度<3" };
    },
  },
];

function scenarioByKey(key: EditDraftStructScenarioKey): EditDraftStructScenario {
  const scenario = editDraftStructScenarios.find((item) => item.key === key);
  if (!scenario) throw new Error(`unknown editDraft struct scenario: ${key}`);
  return scenario;
}

function validateEditableBlocks(
  input: { ops: unknown[] },
): { ok: true; value: ValidatedEditDraftStructInput } | { ok: false; note: string } {
  const blocks: AiBlock[] = [];
  for (const [opIndex, op] of input.ops.entries()) {
    if (!op || typeof op !== "object" || Array.isArray(op)) continue;
    const record = op as Record<string, unknown>;
    if (record.action === "replaceBlock") {
      try {
        const parsed = parseAiDocumentOrBlockFromText(normalizeIncomingBlock(record.block));
        if (parsed.blocks.length !== 1) {
          return { ok: false, note: `op${opIndex} replaceBlock 期望单块,实际 ${parsed.blocks.length} 块` };
        }
        blocks.push(...(parsed.blocks as AiBlock[]));
      } catch (err) {
        return {
          ok: false,
          note: `op${opIndex} replaceBlock 块解析失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (record.action === "insertBlock") {
      if (!Array.isArray(record.blocks)) {
        return { ok: false, note: `op${opIndex} insertBlock.blocks 不是数组` };
      }
      for (const [blockIndex, rawBlock] of record.blocks.entries()) {
        try {
          const parsed = parseAiDocumentOrBlockFromText(normalizeIncomingBlock(rawBlock));
          blocks.push(...(parsed.blocks as AiBlock[]));
        } catch (err) {
          return {
            ok: false,
            note: `op${opIndex}.blocks${blockIndex} 块解析失败: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }
  }

  const compiled = compileAiDocumentToPm({ blocks });
  if (!compiled.ok || !compiled.doc) {
    const firstError = compiled.blockErrors[0];
    return {
      ok: false,
      note: `块编译失败${firstError ? `: block${firstError.index} ${firstError.message}` : ""}`,
    };
  }
  return { ok: true, value: { ops: input.ops, blocks, doc: compiled.doc } };
}

export function validateEditDraftStructOutput(output: EditDraftStructOutput): ScorerCheck {
  let parsed: any;
  try {
    parsed = JSON.parse(extractJson(output.raw));
  } catch (err) {
    return { ok: false, note: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  const schemaResult = editDraftInputSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      note: `AI-IR 校验失败: ${schemaResult.error.issues
        .slice(0, 2)
        .map((issue) => `${issue.path.join(".")}:${issue.message}`)
        .join("; ")}`,
    };
  }
  const validated = validateEditableBlocks(schemaResult.data);
  if (!validated.ok) return { ok: false, note: validated.note };
  return scenarioByKey(output.scenarioKey).structureOk(validated.value);
}

export const editDraftStructParseScorer = createScorer<undefined, EditDraftStructOutput>({
  id: "editdraft-struct-parse",
  description: "验证 editDraft 结构化输出经真实 extractJson + editDraftInputSchema 后仍满足场景结构。",
})
  .generateScore(({ run }) => validateEditDraftStructOutput(run.output).ok ? 1 : 0)
  .generateReason(({ run, score }) => {
    const check = validateEditDraftStructOutput(run.output);
    return score === 1 ? `结构合法: ${check.note}` : check.note;
  });

export const editDraftStructScorers = [editDraftStructParseScorer] as const;
