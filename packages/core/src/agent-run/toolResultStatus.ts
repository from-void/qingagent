import { parseFileFailureFromResult } from "../session/materialResource.js";
import { isRecord } from "./redaction.js";

function isReadMaterialFailure(result: Record<string, unknown>): boolean {
  const text = result.text;
  return typeof text === "string" &&
    text.trimStart().startsWith("[Error] Material not found:");
}

/**
 * 工具结果没有全局统一的错误文本格式。这里只按已登记的工具契约识别失败，
 * 避免把普通工具正文里的 Error/error 字样误判成执行失败。
 */
export function toolResultSucceededByContract(
  toolName: string,
  rawResult: unknown,
): boolean {
  if (!isRecord(rawResult)) return true;
  if (rawResult.ok === false || rawResult.success === false) return false;

  switch (toolName) {
    case "readMaterial":
      return !isReadMaterialFailure(rawResult);
    case "summarizeMaterial":
      return rawResult.updated !== false;
    case "parseFile":
      return parseFileFailureFromResult(rawResult) === null;
    default:
      return true;
  }
}
