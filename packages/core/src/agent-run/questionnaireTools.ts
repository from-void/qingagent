import type { AskUserSpec, ToolCallSpec } from "@qingagent/contract-ts";
import { hasCanonicalDoc } from "../doc-engine/docFacts.js";

export const QUESTIONNAIRE_TOOL_NAMES = [
  "askUser",
  "planDraft",
  "askUserQuestion",
] as const;

export type QuestionnaireToolName = (typeof QUESTIONNAIRE_TOOL_NAMES)[number];
export type PlanDraftToolName = Extract<QuestionnaireToolName, "askUser" | "planDraft">;
export type QuestionnaireRenderMode = "fullpage" | "overlay";

const QUESTIONNAIRE_TOOL_NAME_SET = new Set<string>(QUESTIONNAIRE_TOOL_NAMES);
const PLAN_DRAFT_TOOL_NAME_SET = new Set<string>(["askUser", "planDraft"]);

/**
 * 问卷通道工具族。askUser 仅为老会话持久化兼容保留，待老会话数据迁移或过期后删除。
 */
export function isQuestionnaireTool(toolName: unknown): toolName is QuestionnaireToolName {
  return typeof toolName === "string" && QUESTIONNAIRE_TOOL_NAME_SET.has(toolName);
}

/**
 * 写作方向建模工具族。askUser 仅为老会话持久化兼容保留，待老会话数据迁移或过期后删除。
 */
export function isPlanDraftTool(toolName: unknown): toolName is PlanDraftToolName {
  return typeof toolName === "string" && PLAN_DRAFT_TOOL_NAME_SET.has(toolName);
}

export function questionnaireRenderMode(toolName: QuestionnaireToolName): QuestionnaireRenderMode {
  return toolName === "askUserQuestion" ? "overlay" : "fullpage";
}

/** 已确认过方向或已有成稿时，再次发起 planDraft 即为方向重设。 */
export function isDirectionReset(
  state: {
    _askUserCompleted?: boolean;
    doc?: { content: readonly unknown[]; [key: string]: unknown };
    legacySections: readonly unknown[];
  },
): boolean {
  return state._askUserCompleted === true || hasCanonicalDoc(state);
}

/**
 * 老快照可能缺 mode 或含非法 mode；恢复边界统一降级为 fullpage，避免前端直读 mode.kind 崩溃。
 */
export function normalizeQuestionnaireSpecForRestore(spec: ToolCallSpec): ToolCallSpec {
  if (!isQuestionnaireTool(spec.name)) return spec;
  const body = (spec as ToolCallSpec & { body?: unknown }).body;
  if (!body || typeof body !== "object" || !("kind" in body) || body.kind !== "askUser") {
    return spec;
  }
  const data = "data" in body && body.data && typeof body.data === "object"
    ? body.data as unknown as AskUserSpec
    : null;
  if (!data) return spec;
  const mode = data.mode?.kind;
  if (mode === "fullpage" || mode === "overlay") return spec;
  return {
    ...spec,
    render: { kind: "rightForm" },
    body: {
      kind: "askUser",
      data: {
        ...data,
        mode: { kind: "fullpage" },
      },
    },
  };
}
