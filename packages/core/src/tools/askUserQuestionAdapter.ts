import type { AskUserQuestion } from "@qingagent/contract-ts";
import { z } from "zod";
import { repairModelJson } from "../llm/repairToolCallJson.js";

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_HEADER_CODE_POINTS = 12;
const MAX_PREVIEW_CODE_POINTS = 800;

export const askUserQuestionInputSchema = z.object({
  id: z.string().describe("本次提问的唯一标识"),
  rationale: z.string().describe("向用户提问的原因，仅供运行时记录"),
  questions: z
    .union([z.array(z.unknown()), z.string()])
    .describe(
      "最多 4 道单选或多选题；兼容模型把 questions 整体序列化成 JSON 字符串，畸形条目由 adapter 丢弃",
    ),
});

export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>;

export interface AdaptedAskUserQuestionInput {
  id: string;
  rationale: string;
  questions: AdaptedAskUserQuestion[];
}

export interface AdaptedAskUserQuestion {
  id: string;
  header: string | null;
  label: string;
  kind: { kind: "single" | "multi" };
  options: AskUserQuestion["options"];
  placeholder: null;
}

export const questionnaireRejectedResultSchema = z.object({
  rejected: z.literal(true),
  reason: z.string(),
  retryInstruction: z.string(),
});

export type QuestionnaireRejectedResult = z.infer<typeof questionnaireRejectedResultSchema>;

export function buildQuestionnaireRejectedResult(
  reason = "没有可展示的有效问题",
): QuestionnaireRejectedResult {
  return {
    rejected: true,
    reason,
    retryInstruction: "请重新调用并提供 1 至 4 道题，每题至少包含 2 个非空选项。",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateCodePoints(value: string, max: number, ellipsis = false): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= max) return value;
  return `${codePoints.slice(0, max).join("")}${ellipsis ? "…" : ""}`;
}

function parseQuestions(raw: AskUserQuestionInput["questions"]): unknown[] {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const repaired = repairModelJson(raw);
    if (!repaired.ok) return [];
    try {
      const parsed = JSON.parse(repaired.json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function normalizeOption(raw: unknown): AskUserQuestion["options"][number] | null {
  if (!isRecord(raw)) return null;
  const label = trimmedString(raw.label);
  if (!label) return null;
  const value = trimmedString(raw.value) ?? label;
  const description = trimmedString(raw.description);
  const preview = trimmedString(raw.preview);
  return {
    value,
    label,
    description,
    preview: preview ? truncateCodePoints(preview, MAX_PREVIEW_CODE_POINTS, true) : null,
  };
}

function normalizeQuestion(raw: unknown): Omit<AdaptedAskUserQuestion, "id"> | null {
  if (!isRecord(raw)) return null;
  const label = trimmedString(raw.question);
  if (!label) return null;
  const options = Array.isArray(raw.options)
    ? raw.options.map(normalizeOption).filter((option): option is NonNullable<typeof option> => option !== null)
    : [];
  if (options.length < 2) return null;
  const header = trimmedString(raw.header);
  return {
    header: header ? truncateCodePoints(header, MAX_HEADER_CODE_POINTS) : null,
    label,
    kind: { kind: raw.multiSelect === true ? "multi" : "single" },
    options: options.slice(0, MAX_OPTIONS),
    placeholder: null,
  };
}

/**
 * 把父模型逐字直传的通用提问参数收敛为问卷通道标准结构。
 * 清洗先于截断，避免前面的坏题挤掉后面的合法题。
 */
export function adaptAskUserQuestionInput(
  input: AskUserQuestionInput,
): AdaptedAskUserQuestionInput {
  const questions = parseQuestions(input.questions)
    .map(normalizeQuestion)
    .filter((question): question is NonNullable<typeof question> => question !== null)
    .slice(0, MAX_QUESTIONS)
    .map((question, index) => ({ ...question, id: `q${index + 1}` }));

  return {
    id: input.id,
    rationale: input.rationale,
    questions,
  };
}
