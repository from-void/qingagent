import { createTool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import { extractJsonArray } from "../utils/extractJsonArray.js";
import { generateQuestions } from "../services/genService.js";
import { startToolHeartbeat, writeToolStreamChunk } from "./toolHeartbeat.js";
import { recordQuestionnaireEventSpan } from "./questionnaireObservability.js";
import { questionnaireRejectedResultSchema } from "./askUserQuestionAdapter.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// F4 滑块配置:LLM 产出不可信,经 normalizeSliderSpec 强制收敛到合理范围。
const askUserSliderSchema = z.object({
  min: z.number(),
  max: z.number(),
  step: z.number(),
  unit: z.string().nullable().optional(),
  marks: z.array(z.number()).nullable().optional(),
  aboveLabel: z.string().nullable().optional(),
});

const askUserQuestionSchema = z.object({
  id: z.string(),
  header: z
    .string()
    .nullable()
    .optional()
    .refine((value) => value == null || Array.from(value).length <= 12, {
      message: "header 最多 12 个 Unicode code point",
    }),
  label: z.string(),
  kind: z.enum(["single", "multi", "text", "slider"]),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().nullable().optional(),
        preview: z.string().nullable().optional(),
      }),
    )
    .max(8)
    .default([]),
  placeholder: z.string().nullable().optional(),
  slider: askUserSliderSchema.nullable().optional(),
});

const askUserAnswerSchema = z.object({
  chosen: z.array(z.string()),
  freeText: z.string().nullable(),
  numericValue: z.number().nullable().optional(),
  // resume 富化字段:桥接层把题面/选中项 label 回填进答案(enrichAskUserResumeAnswersWithLabels),
  // 模型读 resume 后的 tool-result 时才解读得了 "v2" 这类选项 value——题面/选项文案只发给过前端,
  // 从未进主模型上下文。缺了它们,模型收到答卷读不懂,会再弹一份同类问卷(e2e-loop-0704 R13)。
  questionLabel: z.string().optional(),
  chosenLabels: z.array(z.string()).optional(),
});

/** F4:把 LLM 给出的滑块范围收敛到可用状态(纯函数,配对抗性单测)。
 *  规则:min/max/step 必须有限数;min<max 否则给默认;字数类(unit 含"字")min 至少 50;
 *  step<=0/大于跨度/过碎时取跨度/20 取整;marks 越界丢弃;aboveLabel 缺省时自动生成「{max}{unit}以上」。 */
export function normalizeSliderSpec(raw: unknown): {
  min: number; max: number; step: number;
  unit: string | null; marks: number[] | null; aboveLabel: string | null;
} | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  let min = num(r.min);
  let max = num(r.max);
  let step = num(r.step);
  const unit = typeof r.unit === "string" && r.unit.trim() ? r.unit.trim() : null;
  if (min === null || max === null) return null;
  if (min >= max) return null;
  // 字数类最小值不可为 0(需求):unit 含"字"时至少 50。
  if (unit && unit.includes("字") && min < 50) min = 50;
  if (min < 0) min = 0;
  if (min >= max) return null;
  const span = max - min;
  if (step === null || step <= 0 || step > span || span / step > 200) {
    step = Math.max(1, Math.round(span / 20));
  }
  let marks: number[] | null = null;
  if (Array.isArray(r.marks)) {
    const valid = r.marks
      .map((m) => num(m))
      .filter((m): m is number => m !== null && m >= min! && m <= max!);
    marks = valid.length > 0 ? valid : null;
  }
  const aboveLabel =
    typeof r.aboveLabel === "string" && r.aboveLabel.trim()
      ? r.aboveLabel.trim()
      : `${max}${unit ?? ""}以上`;
  return { min, max, step, unit, marks, aboveLabel };
}

const suspendPayloadSchema = z.object({
  id: z.string(),
  purpose: z.enum(["initialBrief", "quickClarification", "directionChange"]).optional(),
  source: z.string().nullable(),
  rationale: z.string().nullable(),
  questions: z.array(askUserQuestionSchema).max(8),
});

const resumeDataSchema = z.record(z.string(), askUserAnswerSchema.optional());
const suppressedResultSchema = z.object({
  suppressed: z.literal(true),
  reason: z.literal("askUserAlreadyCompleted"),
  instruction: z.string(),
});
const askUserOutputSchema = z.union([
  resumeDataSchema,
  suppressedResultSchema,
  questionnaireRejectedResultSchema,
]);

export function resolvePlanDraftSuspendPurpose(
  directionReset: boolean,
): "initialBrief" | "directionChange" {
  return directionReset ? "directionChange" : "initialBrief";
}

// ---------------------------------------------------------------------------
// Partial JSON parser for streaming questions
// ---------------------------------------------------------------------------

type ParsedQuestion = {
  id: string;
  label: string;
  kind: string;
  options: Array<{
    value: string;
    label: string;
    description?: string | null;
    preview?: string | null;
  }>;
  placeholder?: string;
};

const askUserQuestionKinds = new Set(["single", "multi", "text", "slider"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeQuestionOptions(
  raw: unknown,
): ParsedQuestion["options"] {
  if (!Array.isArray(raw)) return [];
  const options: ParsedQuestion["options"] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.value !== "string" || typeof item.label !== "string") {
      continue;
    }
    const option: ParsedQuestion["options"][number] = {
      value: item.value,
      label: item.label,
    };
    if (typeof item.description === "string" || item.description === null) {
      option.description = item.description;
    }
    if (typeof item.preview === "string" || item.preview === null) {
      option.preview = item.preview;
    }
    options.push(option);
  }
  return options;
}

function normalizeParsedQuestion(raw: unknown): (ParsedQuestion & { slider?: unknown }) | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (typeof raw.label !== "string") return null;
  if (typeof raw.kind !== "string" || !askUserQuestionKinds.has(raw.kind)) {
    return null;
  }

  const question: ParsedQuestion & { slider?: unknown } = {
    id: raw.id,
    label: raw.label,
    kind: raw.kind,
    options: normalizeQuestionOptions(raw.options),
  };
  if (typeof raw.placeholder === "string") question.placeholder = raw.placeholder;
  if ("slider" in raw) question.slider = raw.slider;
  return question;
}

function decodeJsonStringContent(content: string): string | null {
  try {
    const parsed = JSON.parse(`"${content}"`);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function extractTopLevelStringField(
  partial: string,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string | null {
  const key = `"${field}"`;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < partial.length; i++) {
    const ch = partial[i]!;

    if (!inString && depth === 1 && partial.startsWith(key, i)) {
      let cursor = i + key.length;
      while (cursor < partial.length && /\s/.test(partial[cursor]!)) cursor++;
      if (partial[cursor] !== ":") continue;
      cursor++;
      while (cursor < partial.length && /\s/.test(partial[cursor]!)) cursor++;
      if (partial[cursor] !== '"') return null;
      cursor++;

      let value = "";
      let valueEscape = false;
      for (; cursor < partial.length; cursor++) {
        const valueCh = partial[cursor]!;
        if (valueEscape) {
          value += `\\${valueCh}`;
          valueEscape = false;
          continue;
        }
        if (valueCh === "\\") {
          valueEscape = true;
          continue;
        }
        if (valueCh === '"') {
          const decoded = decodeJsonStringContent(value);
          if (decoded === null) return null;
          if (options.allowEmpty !== true && decoded.length === 0) return null;
          return decoded;
        }
        value += valueCh;
      }
      return null;
    }

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
  }

  return null;
}

function recordAskUserSuppressedSpan(
  context: { requestContext?: { get?: (key: string) => unknown } } | undefined,
): void {
  recordQuestionnaireEventSpan(context, {
    eventKind: "askuser_suppressed",
    metadata: {
      suppressed: true,
      suppressReason: "askUserAlreadyCompleted",
    },
    input: { reason: "askUserAlreadyCompleted" },
    output: { ok: true, suppressed: true },
  });
}

export function tryParsePartialQuestions(accumulated: string): ParsedQuestion[] {
  const questions: ParsedQuestion[] = [];
  const startIdx = accumulated.indexOf("[");
  if (startIdx < 0) return [];

  const content = accumulated.slice(startIdx + 1);
  let pos = 0;

  while (pos < content.length) {
    while (pos < content.length && /[\s,]/.test(content[pos]!)) pos++;
    if (pos >= content.length || content[pos] === "]") break;
    if (content[pos] !== "{") break;

    const objEnd = findMatchingBrace(content, pos);
    if (objEnd === -1) {
      // Incomplete object — try to extract partial question
      const partial = extractPartialQuestion(content.slice(pos));
      if (partial) questions.push(partial);
      break;
    }

    const objStr = content.slice(pos, objEnd + 1);
    try {
      const parsed = JSON.parse(objStr);
      const normalized = normalizeParsedQuestion(parsed);
      // R4-A P0 回归:LLM 可省略 options 字段(slider/text 题尤甚),partial 帧不走 zod
      // default 兜底,必须在此规范化,否则前端问卷渲染 .map 白屏崩溃。
      if (normalized) questions.push(normalized);
    } catch {
      /* malformed */
    }
    pos = objEnd + 1;
  }

  return questions;
}

function extractPartialQuestion(partial: string): ParsedQuestion | null {
  const id = extractTopLevelStringField(partial, "id");
  if (id === null) return null;
  const label = extractTopLevelStringField(partial, "label");
  if (label === null) return null;

  // slider 题不做半成形提取:其 slider 配置可能尚未流出,流给前端会被 validator 拒
  // (R5-A P3 BridgeFrameValidationError);等对象闭合后由完整 JSON.parse 路径放出。
  const kind = extractTopLevelStringField(partial, "kind");
  if (kind !== "single" && kind !== "multi" && kind !== "text") return null;

  // Extract completed options from the options array
  const options: Array<{ value: string; label: string; description?: string }> = [];
  const optionsStart = partial.indexOf('"options"');
  if (optionsStart >= 0) {
    const arrStart = partial.indexOf("[", optionsStart);
    if (arrStart >= 0) {
      const optContent = partial.slice(arrStart + 1);
      let oPos = 0;
      while (oPos < optContent.length) {
        while (oPos < optContent.length && /[\s,]/.test(optContent[oPos]!)) oPos++;
        if (oPos >= optContent.length || optContent[oPos] === "]") break;
        if (optContent[oPos] !== "{") break;
        const oEnd = findMatchingBrace(optContent, oPos);
        if (oEnd === -1) break;
        try {
          const opt = JSON.parse(optContent.slice(oPos, oEnd + 1));
          if (opt.value && opt.label) options.push(opt);
        } catch { /* skip */ }
        oPos = oEnd + 1;
      }
    }
  }

  // Extract placeholder
  const placeholder = extractTopLevelStringField(partial, "placeholder", { allowEmpty: true }) ?? "";

  return {
    id,
    label,
    kind,
    options,
    placeholder,
  };
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

export function extractQuestionsJson(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/i, "");
  text = text.replace(/\r?\n?```\s*$/i, "");
  text = text.trim();

  const extracted = extractQuestionArrayJson(raw);
  if (extracted !== null) return extracted;

  const firstArrayStart = text.indexOf("[");
  if (firstArrayStart === -1) return text;

  return text.slice(firstArrayStart);
}

function extractQuestionArrayJson(raw: string): string | null {
  return extractJsonArray(raw, (questions) =>
    questions.every((question) => askUserQuestionSchema.safeParse(question).success)
  );
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const planDraftTool = createTool({
  id: "planDraft",
  description:
    "为新文档、空文档首稿或整篇重写建立写作方向。本次写作方向尚未确认且用户要开始写作时，默认必须先调用本工具确认方向——" +
    "这里按本次写作任务判断，不按会话第一轮判断；用户先打招呼、后面第一次提出写作需求时仍要调用本工具。 " +
    "即使用户已把主题、文体、篇幅、结构等信息给全；信息很少时也用本工具承接写作方向建模，不要用普通聊天追问代替 planDraft。 " +
    "例如“帮我写篇文章”“写个报告吧”“帮我弄一份总结”“写诗”都必须先调用本工具。 " +
    "仅当用户明确说“直接写/别问/不要问/现在就写”或消息与写作无关时才不调用；这类话只表示跳过 planDraft，新文档直写才直接 writeDraft，已有文档局部编辑仍走 readDraft/editDraft。 " +
    "写代码/SQL 查询等编程技术求助不算本工具场景；brainstorm、取名、想标题、想口号等短产出若未明确要写入右侧文档，也不要调用本工具。 " +
    "已有文档时，仅当用户要推翻、重设整篇写作方向才再次调用；写作中途的局部选择或其他通用确认改用 askUserQuestion。 " +
    "提供 topic 和 rationale 即可，具体问题由工具自动生成。必须单独调用本工具：同一步/同一响应里绝不能并发调用 webSearch、fetchArticle、writeDraft 等任何其它工具。 " +
    "本工具会结束本轮并等待用户回答，并发工具调用会白跑且体验割裂。需要先搜集信息或读取材料时，先在前面的步骤单独完成，再在新的一步里只调用 planDraft。",
  inputSchema: z.object({
    id: z.string().describe("本次写作方向建模的唯一标识"),
    rationale: z
      .string()
      .describe("面向用户解释为什么先确认这些写作方向，会作为问卷副标题展示"),
    topic: z
      .string()
      .describe("简要描述需要向用户确认的方向和已知信息，用于生成具体问题"),
  }),
  outputSchema: askUserOutputSchema,
  suspendSchema: suspendPayloadSchema,
  resumeSchema: resumeDataSchema,
  execute: async (input, context) => {
    const { resumeData, suspend } = context?.agent ?? {};

    if (resumeData) {
      return resumeData;
    }

    // 硬闸:同一次文档创建里 planDraft 最多一轮。若本轮之前已问过一轮，
    // 不再发起问卷，并返回语义化结果，让模型继续调用写作工具而不是误解为空成功。
    const alreadyAsked =
      (context?.requestContext?.get?.("askUserAlreadyCompleted") as
        | boolean
        | undefined) === true;
    const directionChangeAskedSinceLastWrite =
      (context?.requestContext?.get?.("directionChangeAskedSinceLastWrite") as
        | boolean
        | undefined) === true;
    const directionReset =
      (context?.requestContext?.get?.("isDirectionReset") as boolean | undefined) === true;
    // 硬闸只压**重复的初稿方向问卷**(initialBrief)最多一轮:首稿前确认过方向就别再问同一份。
    // directionChange(用户确实要推翻/大改已有稿方向,如"整篇改成公文风")是合法的二次方向确认;
    // 但 directionChange 已完成且期间没有有效写入时,不再豁免 alreadyAsked 抑制。
    // 通用澄清已迁给 askUserQuestion；本工具只处理初稿方向与已有成稿后的整体方向重设。
    if (
      alreadyAsked &&
      (!directionReset || directionChangeAskedSinceLastWrite)
    ) {
      console.log(
        "[planDraft] suppressed 2nd-round planDraft -> returning semantic instruction",
      );
      recordAskUserSuppressedSpan(context);
      return {
        suppressed: true,
        reason: "askUserAlreadyCompleted",
        instruction:
          "已完成一轮澄清,请勿再次提问或描述界面;直接基于已有答案与上下文继续调用 writeDraft/editDraft。",
      };
    }

    try {
      if (!suspend) {
        console.error("[planDraft] suspend function is undefined");
        return { error: "suspend not available" } as any;
      }

      const requestContext = context?.requestContext as RequestContext | undefined;

      // 出题心跳兜底:出题期间虽会按 signature 变化流式发 askuser-progress 重置看门狗,
      // 但"首 token 前的思考静默期"(推理模型出第一个 token 前可能静默很久)没有任何进度,
      // 仍可能被 agent 90s 空闲看门狗(withIdleTimeout)误杀;心跳走独立 tool-heartbeat
      // 通道,与 askuser-progress 不冲突,只负责静默期持续重置看门狗。
      const stopHeartbeat = startToolHeartbeat(context, { tool: "planDraft" });
      try {
      const generated = await generateQuestions({
        mode: "initial",
        requestContext,
        abortSignal: context?.abortSignal,
        rationale: input.rationale,
        topic: input.topic,
        onProgress: async (questions) => {
          if (context?.writer) {
            await writeToolStreamChunk(context.writer, {
              type: "askuser-progress",
              questions,
            });
          }
        },
      });
      const questions = generated.questions;
      console.log("[planDraft] generated", questions.length, "questions", {
        transport: generated.transport,
        branchFailure: generated.branchFailure,
        toolCallRetries: generated.toolCallRetries,
      });

      // Suspend with complete questionnaire
      return await suspend({
        id: input.id,
        purpose: resolvePlanDraftSuspendPurpose(directionReset),
        source: null,
        rationale: input.rationale ?? null,
        questions: questions.map((q, idx) => {
          // 兜底脏模型输出:智谱 GLM 等常漏 id/kind(只给 label/options),裸 JSON 不补会过不了
          // suspend schema 校验 → 整套问题被打回("选项全丢")。这里强制补全:
          //   kind 缺/非法 → 有选项按 single、否则 text;id 缺 → 按序号 q{n}。
          const rawKind = typeof (q as { kind?: unknown }).kind === "string" ? (q as { kind: string }).kind : "";
          const hasOptions = Array.isArray(q.options) && q.options.length > 0;
          let kind: "single" | "multi" | "text" | "slider" = askUserQuestionKinds.has(rawKind)
            ? (rawKind as "single" | "multi" | "text" | "slider")
            : (hasOptions ? "single" : "text");
          // F4:slider 范围不可信,经 normalizeSliderSpec 收敛;收敛失败则降级为 text。
          const slider = kind === "slider" ? normalizeSliderSpec((q as { slider?: unknown }).slider) : null;
          if (kind === "slider" && !slider) kind = "text";
          return {
            id: isNonEmptyString(q.id) ? q.id : `q${idx + 1}`,
            label: q.label,
            kind,
            options: kind === "slider" || kind === "text" ? [] : (q.options ?? []),
            placeholder: q.placeholder ?? null,
            ...(slider ? { slider } : {}),
          };
        }),
      });
      } finally {
        stopHeartbeat();
      }
    } catch (err) {
      console.error("[planDraft] execute failed:", err);
      return { error: String(err) } as any;
    }
  },
});
