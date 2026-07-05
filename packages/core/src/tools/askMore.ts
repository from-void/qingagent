import type { RequestContext } from "@mastra/core/request-context";
import { streamText } from "ai";
import { extractJsonArray } from "../utils/extractJsonArray.js";
import { getDeepseekModel, resolveModelParams } from "../llm/modelConfig.js";
import { recordDeepseekUsageFromResult } from "../llm/usageAccounting.js";

/**
 * Shape of a single generated question — matches the contract
 * AskUserQuestion shape (with nested `kind`).
 */
export interface AskMoreQuestion {
  id: string;
  label: string;
  kind: { kind: "single" | "multi" | "text" };
  options: Array<{
    value: string;
    label: string;
    description?: string | null;
    preview?: string | null;
  }>;
  placeholder?: string | null;
}

const askMoreQuestionKinds = new Set(["single", "multi", "text"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeAskMoreOptions(
  raw: unknown,
): AskMoreQuestion["options"] {
  if (!Array.isArray(raw)) return [];
  const options: AskMoreQuestion["options"] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.value !== "string" || typeof item.label !== "string") {
      continue;
    }
    const option: AskMoreQuestion["options"][number] = {
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

function normalizeAskMoreQuestion(raw: unknown): AskMoreQuestion | null {
  if (!isRecord(raw)) return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (typeof raw.label !== "string") return null;
  if (!isRecord(raw.kind)) return null;
  const kind = raw.kind.kind;
  if (typeof kind !== "string" || !askMoreQuestionKinds.has(kind)) return null;

  return {
    id: raw.id,
    label: raw.label,
    kind: { kind: kind as "single" | "multi" | "text" },
    options: normalizeAskMoreOptions(raw.options),
    placeholder: typeof raw.placeholder === "string" || raw.placeholder === null
      ? raw.placeholder
      : "",
  };
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

// ---------------------------------------------------------------------------
// Partial JSON parser for streaming questions (nested kind format)
// ---------------------------------------------------------------------------

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

export function tryParsePartialAskMoreQuestions(accumulated: string): AskMoreQuestion[] {
  const questions: AskMoreQuestion[] = [];
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
      // Incomplete — try partial extraction
      const partial = extractPartialAskMoreQuestion(content.slice(pos));
      if (partial) questions.push(partial);
      break;
    }

    const objStr = content.slice(pos, objEnd + 1);
    try {
      const parsed = JSON.parse(objStr);
      const normalized = normalizeAskMoreQuestion(parsed);
      if (normalized) questions.push(normalized);
    } catch { /* skip */ }
    pos = objEnd + 1;
  }
  return questions;
}

function extractPartialAskMoreQuestion(partial: string): AskMoreQuestion | null {
  const id = extractTopLevelStringField(partial, "id");
  if (id === null) return null;
  const label = extractTopLevelStringField(partial, "label");
  if (label === null) return null;
  const kindMatch = partial.match(/"kind"\s*:\s*"(single|multi|text)"/);
  if (!kindMatch) return null;

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

  const placeholder = extractTopLevelStringField(partial, "placeholder", { allowEmpty: true }) ?? "";

  return {
    id,
    label,
    kind: { kind: kindMatch[1] as "single" | "multi" | "text" },
    options,
    placeholder,
  };
}

// ---------------------------------------------------------------------------
// Streaming generator
// ---------------------------------------------------------------------------

/**
 * Stream-generate 1-3 follow-up questions. Yields partial results
 * as questions/options are parsed from the LLM output.
 */
export async function* streamMoreQuestions(context: {
  conversationSummary: string;
  currentQuestions: Array<{
    id: string;
    label: string;
    kind: { kind: string };
    options: Array<{ value: string; label: string }>;
  }>;
  currentAnswers: Record<string, { chosen?: string[]; freeText?: string }>;
  requestContext?: RequestContext;
}): AsyncGenerator<AskMoreQuestion[]> {
  const existingQSummary = context.currentQuestions
    .map((q) => {
      const ans = context.currentAnswers[q.id];
      const ansText = ans
        ? [
            ...(ans.chosen ?? []),
            ...(ans.freeText ? [ans.freeText] : []),
          ].join(", ") || "未回答"
        : "未回答";
      return `- ${q.label} → ${ansText}`;
    })
    .join("\n");

  const result = streamText({
    model: getDeepseekModel(context.requestContext),
    ...resolveModelParams(context.requestContext),
    prompt: `你是一位写作需求分析专家。根据以下对话上下文和已有的问卷问题及回答，生成 1-3 个补充问题，帮助更好地理解用户的写作需求。

对话摘要：
${context.conversationSummary}

已有问题及回答：
${existingQSummary}

直接输出纯 JSON 数组，不要有任何其他内容。格式：
[{"id":"q-extra-tone","label":"问题文本","kind":{"kind":"single"},"options":[{"value":"v1","label":"选项1","description":"描述"}],"placeholder":""},{"id":"q-extra-note","label":"补充问题","kind":{"kind":"text"},"options":[],"placeholder":"提示文字"}]

要求：
1. 问题应覆盖尚未涉及的方面
2. 不要重复已有问题
3. id 格式为 "q-extra-{简短英文主题}"
4. kind 必须是 {"kind":"single"}、{"kind":"multi"} 或 {"kind":"text"}
5. 选择题选项不超过 4 个
6. 文本题 options 为空数组
7. 使用中文`,
  });

  let accumulated = "";
  let lastSig = "";
  let lastPartial: AskMoreQuestion[] = [];

  for await (const delta of result.textStream) {
    accumulated += delta;

    const partial = tryParsePartialAskMoreQuestions(accumulated);
    if (partial.length === 0) continue;

    const totalOpts = partial.reduce((s, q) => s + q.options.length, 0);
    const sig = `${partial.length}:${totalOpts}`;
    if (sig !== lastSig) {
      lastSig = sig;
      lastPartial = partial;
      yield partial;
    }
  }
  await recordDeepseekUsageFromResult(context.requestContext, "askMore", result.usage, result.providerMetadata);

  // Final yield with complete result
  const jsonStr = extractJsonArray(accumulated);
  if (jsonStr === null) {
    yield lastPartial.length > 0 ? lastPartial : [];
    return;
  }

  try {
    const final: AskMoreQuestion[] = JSON.parse(jsonStr);
    yield final;
  } catch {
    yield lastPartial.length > 0 ? lastPartial : [];
  }
}
