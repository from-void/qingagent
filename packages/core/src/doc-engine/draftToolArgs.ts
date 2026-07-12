import { repairDraftToolCallInput } from "../llm/repairingModel.js";

export const DRAFT_TOOL_JSON_RETRY_NOTICE =
  "你的 editDraft/writeDraft 参数不是合法 JSON，或缺少必填字段。正文里的半角双引号必须写成 \\\"，也可以改用中文「」；如果内容较长，请拆成多次更小的 editDraft 后重发。本轮草稿尚未变化，请重试。";
export const DRAFT_MUTATION_TOOL_NAMES = new Set(["editDraft", "writeDraft"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function hasUsableDraftMutationArgs(
  toolName: string,
  args: unknown,
): boolean {
  const record = asRecord(args);
  if (!record) return false;
  if (toolName === "editDraft") {
    return Array.isArray(record.ops) && record.ops.length > 0;
  }
  if (toolName === "writeDraft") {
    return (
      typeof record.title === "string" &&
      record.title.trim().length > 0 &&
      typeof record.outline === "string" &&
      record.outline.trim().length > 0
    );
  }
  return Object.keys(record).length > 0;
}

export function parseDraftToolCallArgs(toolName: string, rawArgs: unknown): Record<string, unknown> {
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs !== "string") return {};

  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    const repaired = repairDraftToolCallInput(toolName, rawArgs);
    if (!repaired) return {};
    try {
      const parsed = JSON.parse(repaired) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
}

export function normalizeToolCallArgs(toolName: string, payload: Record<string, unknown>): Record<string, unknown> {
  const rawArgs = payload.args ?? payload.input ?? {};
  return DRAFT_MUTATION_TOOL_NAMES.has(toolName)
    ? parseDraftToolCallArgs(toolName, rawArgs)
    : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? rawArgs as Record<string, unknown>
      : {};
}

export function draftMutationFailureReason(
  toolName: string,
  args: unknown,
  result: Record<string, unknown> | null,
): string {
  if (!hasUsableDraftMutationArgs(toolName, args)) {
    return DRAFT_TOOL_JSON_RETRY_NOTICE;
  }
  return result && typeof result.error === "string" && result.error
    ? result.error
    : `${toolName} failed`;
}
