import { createTool } from "@mastra/core/tools";
import { SpanType } from "@mastra/core/observability";
import type { RequestContext } from "@mastra/core/request-context";
import { streamText } from "ai";
import { z } from "zod";
import { getObservability } from "../mastra.js";
import { deriveSessionTraceId } from "../observability/innerLlmSpan.js";
import { extractFirstBalancedArray, extractJsonArray } from "../utils/extractJsonArray.js";
import { getDeepseekModel, resolveModelParams } from "../llm/modelConfig.js";
import { repairModelJson } from "../llm/repairToolCallJson.js";
import { recordDeepseekUsageFromResult } from "../llm/usageAccounting.js";
import { startToolHeartbeat } from "./toolHeartbeat.js";

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
  purpose: z.enum(["initialBrief", "quickClarification", "directionChange"]),
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
const askUserOutputSchema = z.union([resumeDataSchema, suppressedResultSchema]);

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
  const requestContext = context?.requestContext;
  const sessionId = requestContext?.get?.("sessionId") as string | undefined;
  if (!sessionId) return;
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;
    const traceId = deriveSessionTraceId(sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name: "askuser_suppressed",
      ...(traceId ? { traceId } : {}),
      metadata: {
        eventKind: "askuser_suppressed",
        sessionId,
        clientTraceId: (requestContext?.get?.("clientTraceId") as string | null | undefined) ?? null,
        streamId: (requestContext?.get?.("streamId") as string | null | undefined) ?? null,
        runId: (requestContext?.get?.("runId") as string | null | undefined) ?? null,
        origin: (requestContext?.get?.("origin") as string | null | undefined) ?? "manual",
        suppressed: true,
        suppressReason: "askUserAlreadyCompleted",
      },
      input: { reason: "askUserAlreadyCompleted" },
    });
    span.end({ output: { ok: true, suppressed: true } });
  } catch (err) {
    console.warn("[askUser] record suppressed span failed (non-fatal)", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

  return extractFirstBalancedArray(raw) ?? text.slice(firstArrayStart);
}

function extractQuestionArrayJson(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/i, "");
  text = text.replace(/\r?\n?```\s*$/i, "");
  text = text.trim();

  let start = text.indexOf("[");
  while (start !== -1) {
    const end = findMatchingBracket(text, start);
    if (end === -1) {
      start = text.indexOf("[", start + 1);
      continue;
    }
    const candidate = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((item) => normalizeParsedQuestion(item) !== null)
      ) {
        return candidate;
      }
    } catch {
      /* try the next candidate */
    }
    start = text.indexOf("[", start + 1);
  }

  return extractJsonArray(raw);
}

function findMatchingBracket(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth++;
    if (ch === "]") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const askUserTool = createTool({
  id: "askUser",
  description:
    "向用户弹出结构化问卷收集写作方向。本次写作方向尚未确认、且用户要开写新文档/空文档首稿/整篇重写时，默认必须先调用本工具(purpose=initialBrief)确认方向再写——" +
    "这里按本次写作任务判断，不按会话第一轮判断；用户先打招呼、后面第一次提出写作需求时仍要调用本工具。 " +
    "即使用户已把主题、文体、篇幅、结构等信息给全；信息很少时也用本工具承接澄清，不要用普通聊天追问代替 askUser。 " +
    "例如“帮我写篇文章”“写个报告吧”“帮我弄一份总结”“写诗”都必须先调用本工具。 " +
    "仅当用户明确说“直接写/别问/不要问/现在就写”或消息与写作无关时才不调用；这类话只表示跳过 askUser，新文档直写才直接 writeDraft，已有文档局部编辑仍走 readDraft/editDraft。 " +
    "写代码/SQL 查询等编程技术求助不算本工具场景；brainstorm、取名、想标题、想口号等短产出若未明确要写入右侧文档，也不要调用本工具。 " +
    "提供 topic 字符串即可，具体问题由工具自动生成。必须单独调用本工具：同一步/同一响应里绝不能并发调用 webSearch、fetchArticle、writeDraft 等任何其它工具。 " +
    "本工具会结束本轮并等待用户回答，并发工具调用会白跑且体验割裂。需要先搜集信息或读取材料时，先在前面的步骤单独完成，再在新的一步里只调用 askUser。",
  inputSchema: z.object({
    id: z.string().describe("Unique identifier for this askUser interaction"),
    purpose: z
      .enum(["initialBrief", "quickClarification", "directionChange"])
      .describe(
        "提问的语义意图（不是展示方式，界面如何呈现由系统决定）：" +
          "initialBrief=开写前收集整体方向；" +
          "quickClarification=写作中途的局部小澄清；" +
          "directionChange=已有文档但要推翻重设整体方向",
      ),
    rationale: z
      .string()
      .describe("Explanation of why these questions are being asked"),
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

    // 硬闸:同一次文档创建里 askUser 最多一轮。若本轮之前已问过一轮，
    // 不再发起问卷，并返回语义化结果，让模型继续调用写作工具而不是误解为空成功。
    const alreadyAsked =
      (context?.requestContext?.get?.("askUserAlreadyCompleted") as
        | boolean
        | undefined) === true;
    const directionChangeAskedSinceLastWrite =
      (context?.requestContext?.get?.("directionChangeAskedSinceLastWrite") as
        | boolean
        | undefined) === true;
    // 硬闸只压**重复的初稿方向问卷**(initialBrief)最多一轮:首稿前确认过方向就别再问同一份。
    // directionChange(用户确实要推翻/大改已有稿方向,如"整篇改成公文风")是合法的二次方向确认;
    // 但 directionChange 已完成且期间没有有效写入时,不再豁免 alreadyAsked 抑制。
    // quickClarification 是写作中途的局部小澄清,放行可多次。两者的滥用由
    // MAX_CONSECUTIVE_ASKUSER_SUSPENDS 看门狗(连续无写作产出的澄清会被掐,写作跑完一轮自动重置)兜住。
    if (
      alreadyAsked &&
      input.purpose !== "quickClarification" &&
      (input.purpose !== "directionChange" || directionChangeAskedSinceLastWrite)
    ) {
      console.log(
        "[askUser] suppressed 2nd-round askUser -> returning semantic instruction",
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
        console.error("[askUser] suspend function is undefined");
        return { error: "suspend not available" } as any;
      }

      const requestContext = context?.requestContext as RequestContext | undefined;

      // 出题心跳兜底:出题期间虽会按 signature 变化流式发 askuser-progress 重置看门狗,
      // 但"首 token 前的思考静默期"(推理模型出第一个 token 前可能静默很久)没有任何进度,
      // 仍可能被 agent 90s 空闲看门狗(withIdleTimeout)误杀;心跳走独立 tool-heartbeat
      // 通道,与 askuser-progress 不冲突,只负责静默期持续重置看门狗。
      const stopHeartbeat = startToolHeartbeat(context, { tool: "askUser" });
      try {
      const genPrompt = `你是一位写作需求分析专家。根据以下写作方向，生成 2-4 个问卷问题帮助确认用户的写作需求。

写作方向和已知信息：
${input.rationale}

具体主题：
${input.topic}

直接输出纯 JSON 数组，不要有任何其他内容。格式：
[{"id":"q-theme","label":"问题文本","kind":"single","options":[{"value":"v1","label":"选项1","description":"描述"}],"placeholder":""},{"id":"q-length","label":"目标字数","kind":"slider","options":[],"slider":{"min":200,"max":3000,"step":100,"unit":"字","aboveLabel":"3000字以上"}},{"id":"q-note","label":"补充问题","kind":"text","options":[],"placeholder":"提示文字"}]

要求：
1. 每个问题的 id 必须唯一，格式为 "q-{简短英文主题}"
2. kind 只能是 "single"、"multi"、"text" 或 "slider"
3. 选择题选项不超过 4 个
4. 文本题/滑块题 options 必须为空数组
5. slider 只用于连续量（字数、篇幅、段落数等）：必须带 slider 字段，范围要合理（字数最小不低于 50，最大值滑到头表示"X 以上"）
6. 使用中文
7. 如果用户已提供了某些信息，不要重复问
8. 至少包含一个 text 类型的开放式问题
9. 问题与选项的 label/description 一律用自然中文，不要出现英文工具或函数标识符（如 run_js、readDraft 等代码名），要提及某能力请用中文说法（如"运行脚本""读取草稿"）
10. 最外层必须是"问题"数组，不要直接输出"选项"数组（每个问题对象必须含 id、kind、label 字段）`;

      // 模型无关的"畸形→重试":出题模型(deepseek / 智谱 GLM 等)偶发把结构搞错(如把选项数组
      // 当顶层吐出、缺 id/kind)。每次生成后判可用性,畸形则重试(最多 3 次尝试);仍畸形再交给
      // 下方 map 兜底补全,既不崩也尽量拿到正确结构。实测 GLM 单次 ~90% 正确,重试后≈99.9%。
      const isUsableQuestions = (qs: unknown): qs is ParsedQuestion[] =>
        Array.isArray(qs) &&
        qs.length > 0 &&
        qs.every(
          (q) =>
            !!q &&
            typeof (q as { kind?: unknown }).kind === "string" &&
            askUserQuestionKinds.has((q as { kind: string }).kind) &&
            isNonEmptyString((q as { label?: unknown }).label),
        );

      // 已先用 repairModelJson 当场修复偶发畸形,重试只是不可修复(如截断)时的极少兜底;
      // 收紧到 2 次,避免畸形时 3 次全量重新生成把"生成问卷"拖到像卡死。
      const MAX_GEN_ATTEMPTS = 2;
      let questions: ParsedQuestion[] = [];
      for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
        // Stream question generation — push progress via writer
        const result = streamText({
          model: getDeepseekModel(requestContext),
          ...resolveModelParams(requestContext),
          prompt: genPrompt,
        });
        let accumulated = "";
        let lastSignature = "";
        for await (const delta of result.textStream) {
          accumulated += delta;
          const partialQuestions = tryParsePartialQuestions(accumulated);
          if (partialQuestions.length === 0) continue;
          const totalOpts = partialQuestions.reduce((s, q) => s + q.options.length, 0);
          const sig = `${partialQuestions.length}:${totalOpts}`;
          if (sig !== lastSignature) {
            lastSignature = sig;
            if (context?.writer) {
              await context.writer.write({ type: "askuser-progress", questions: partialQuestions });
            }
          }
        }
        await recordDeepseekUsageFromResult(requestContext, "askUser", result.usage, result.providerMetadata);

        let parsed: unknown = null;
        try {
          // 先过协议无关 JSON 修复(补数组元素间漏逗号/修字符串内裸引号)再 parse:GLM 偶发
          // 畸形当场修好,不必走下面慢速的重新生成重试(就是"生成问卷卡住"的根)。与 writeDraft
          // 正文同一套修复(洞2)。修复失败则回退原串,交由下方重试/兜底。
          const extracted = extractQuestionsJson(accumulated);
          const repaired = repairModelJson(extracted);
          parsed = JSON.parse(repaired.ok ? repaired.json : extracted);
        } catch {
          parsed = null;
        }
        if (Array.isArray(parsed)) questions = parsed as ParsedQuestion[]; // 留作兜底(即便畸形)
        if (isUsableQuestions(parsed)) {
          questions = parsed;
          break;
        }
        console.warn(
          `[askUser] 第 ${attempt}/${MAX_GEN_ATTEMPTS} 次出题畸形(非数组或条目缺合法 kind/label)，` +
            (attempt < MAX_GEN_ATTEMPTS ? "重试" : "已达上限，走兜底补全"),
        );
      }
      console.log("[askUser] generated", questions.length, "questions");

      // Suspend with complete questionnaire
      return await suspend({
        id: input.id,
        purpose: input.purpose,
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
      console.error("[askUser] execute failed:", err);
      return { error: String(err) } as any;
    }
  },
});
