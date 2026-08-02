import type { ReviewType } from "./ReviewTemplates";

export const REVIEW_IGNORE_SECTION_HEADING = "## 已确认忽略";
export const REVIEW_IGNORE_LINE_PREFIX = "- 已确认无需处理，不再标记：";

const REVIEW_IGNORE_QUOTE_MAX_CHARS = 48;

/** 批注唯一生产入口的 origin 到文档补充提示词类型的反向映射。 */
export function reviewTypeFromAnnotationOrigin(origin: string): ReviewType {
  if (origin === "sensitive") return "sensitive";
  if (origin === "deai") return "deai";
  if (origin === "source-check") return "source";
  if (origin === "consistency") return "consistency";
  if (origin === "privacy") return "privacy";
  if (origin === "format") return "format";
  if (origin === "角色审查" || origin.startsWith("角色审查:")) return "role";
  // 自定义审查以及历史上由模型自由填写的未知 origin 都归入 custom，避免迁移丢决定。
  return "custom";
}

export function summarizeReviewIgnoreQuote(quote: string, summary: string): string {
  const compact = (quote.trim() || summary.trim())
    .replace(/\s+/gu, " ");
  const chars = Array.from(compact);
  if (chars.length <= REVIEW_IGNORE_QUOTE_MAX_CHARS) return compact;
  return `${chars.slice(0, REVIEW_IGNORE_QUOTE_MAX_CHARS).join("")}…`;
}

export function buildReviewIgnoreLine(input: {
  quote: string;
  summary: string;
  date: string;
}): string {
  const quote = summarizeReviewIgnoreQuote(input.quote, input.summary);
  return `${REVIEW_IGNORE_LINE_PREFIX}「${quote}」(${input.date})`;
}

export function isReviewIgnoreLine(line: string): boolean {
  return line.startsWith(REVIEW_IGNORE_LINE_PREFIX);
}

export interface ReviewSupplementParts {
  /** 原文中不属于机器维护忽略区块的内容，包含其原始空白与换行。 */
  userText: string;
  ignoreLines: string[];
  hasManagedSection: boolean;
}

/**
 * 只识别文末且仅含规范行的区块；遇到用户同名标题或手写正文时宁可视为用户内容。
 */
export function splitReviewSupplement(supplement: string): ReviewSupplementParts {
  const headingPattern = /(^|\n)## 已确认忽略(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;
  while ((match = headingPattern.exec(supplement)) !== null) lastMatch = match;
  if (!lastMatch) {
    return { userText: supplement, ignoreLines: [], hasManagedSection: false };
  }

  const headingStart = lastMatch.index + (lastMatch[1]?.length ?? 0);
  const bodyStart = lastMatch.index + lastMatch[0].length;
  const lines = supplement.slice(bodyStart).split(/\r?\n/);
  if (lines.some((line) => line.trim() !== "" && !isReviewIgnoreLine(line))) {
    return { userText: supplement, ignoreLines: [], hasManagedSection: false };
  }
  return {
    userText: supplement.slice(0, headingStart),
    ignoreLines: lines.filter(isReviewIgnoreLine),
    hasManagedSection: true,
  };
}

/** 机械降级与迁移共用：逐字保留用户区，只对规范忽略行做全等去重。 */
export function appendReviewIgnoreLines(
  supplement: string,
  lines: readonly string[],
): string {
  const parts = splitReviewSupplement(supplement);
  const merged = [...new Set([...parts.ignoreLines, ...lines])];
  const prefix = parts.hasManagedSection
    ? parts.userText
    : supplement.length === 0 || /\r?\n$/.test(supplement)
      ? supplement
      : `${supplement}\n\n`;
  return `${prefix}${REVIEW_IGNORE_SECTION_HEADING}\n${merged.join("\n")}`;
}
