import type { JSONValue } from "ai-v5";

export type ToolModelOutput =
  | { type: "text" | "error-text"; value: string }
  | { type: "json" | "error-json"; value: JSONValue }
  | { type: "content"; value: unknown[] };

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

/**
 * Mastra 当前把 toModelOutput 的返回类型放宽成 unknown，但 AI SDK provider
 * 只接受带 type/value 判别字段的联合。所有项目侧钩子统一经过这里，避免非法形状
 * 到 provider 序列化时静默丢失 tool message.content。
 */
export function validateToolModelOutput(output: unknown): ToolModelOutput | undefined {
  if (output === undefined) return undefined;
  if (output === null || typeof output !== "object") {
    throw new TypeError("toModelOutput 必须返回带 type/value 的对象或 undefined");
  }

  const candidate = output as { type?: unknown; value?: unknown };
  if (candidate.type === "text" || candidate.type === "error-text") {
    if (typeof candidate.value === "string") return candidate as ToolModelOutput;
  } else if (candidate.type === "json" || candidate.type === "error-json") {
    if (isJsonValue(candidate.value)) return candidate as ToolModelOutput;
  } else if (candidate.type === "content") {
    if (Array.isArray(candidate.value)) return candidate as ToolModelOutput;
  }

  throw new TypeError("toModelOutput 返回了 AI SDK 不支持的 type/value 形状");
}

export function jsonToolModelOutput(value: JSONValue): ToolModelOutput {
  return validateToolModelOutput({ type: "json", value })!;
}

export function guardToolModelOutputMapper<T>(
  mapper: ((output: T) => unknown) | undefined,
): ((output: T) => Promise<ToolModelOutput | undefined>) | undefined {
  if (!mapper) return undefined;
  return async (output) => validateToolModelOutput(await mapper(output));
}
