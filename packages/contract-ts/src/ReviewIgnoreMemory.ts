import type { ReviewType } from "./ReviewTemplates";
import type { SuggestionAnchor } from "./DocSuggestion";
import {
  buildSensitiveAnchorSpanKey,
  maskPersistedReviewIgnoreValue,
} from "./SensitiveValueMask";

export const REVIEW_IGNORE_SECTION_HEADING = "## 已确认忽略";
export const REVIEW_IGNORE_LINE_PREFIX = "- 已确认无需处理，不再标记：";
export const REVIEW_IGNORE_DECISION_KEY_PREFIX = "<!-- qingagent-review-ignore-key:";

const REVIEW_IGNORE_QUOTE_MAX_CHARS = 48;

function opaqueReviewScopeFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

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

/**
 * 多模板审查的补充要求存储作用域。新批注使用稳定模板 id；老批注没有这个维度时继续
 * 留在空作用域兼容基线，避免升级后写进任何模板都读不到的孤立记录。
 */
export function reviewSupplementScopeFromAnnotationOrigin(
  origin: string,
  templateId?: string,
): string {
  const type = reviewTypeFromAnnotationOrigin(origin);
  if (type !== "custom" && type !== "role") return "";
  return templateId?.trim() ?? "";
}

export function summarizeReviewIgnoreQuote(quote: string, summary: string): string {
  const compact = maskPersistedReviewIgnoreValue(quote.trim() || summary.trim())
    .replace(/\s+/gu, " ");
  const chars = Array.from(compact);
  if (chars.length <= REVIEW_IGNORE_QUOTE_MAX_CHARS) return compact;
  return `${chars.slice(0, REVIEW_IGNORE_QUOTE_MAX_CHARS).join("")}…`;
}

export interface ReviewIgnoreDecision {
  /** 非 PII 的稳定决定身份；同一位置、同一审查问题在重复提交时保持一致。 */
  key: string;
  /** 带机器身份标记的完整规范行。 */
  line: string;
}

/**
 * 结构位置负责区分脱敏后同形的引文，审查类型与问题摘要避免同位置的不同问题互相吞并。
 * 所有组成部分先脱敏再 URI 编码，禁止把明文 PII 藏进机器标识。
 */
export function buildReviewIgnoreDecisionKey(input: {
  origin: string;
  templateId?: string;
  summary: string;
  anchor: Pick<SuggestionAnchor, "blockId" | "pmFrom" | "pmTo">;
}): string {
  const type = reviewTypeFromAnnotationOrigin(input.origin);
  const storageScope = reviewSupplementScopeFromAnnotationOrigin(
    input.origin,
    input.templateId,
  );
  const dynamicTemplateType = type === "custom" || type === "role";
  const identityScope = storageScope || (dynamicTemplateType
    ? `origin-${opaqueReviewScopeFingerprint(input.origin)}`
    : "");
  const parts = [
    identityScope ? "v2" : "v1",
    type,
    ...(identityScope
      ? [`scope-${opaqueReviewScopeFingerprint(identityScope)}`]
      : []),
    buildSensitiveAnchorSpanKey(input.anchor),
    summarizeReviewIgnoreQuote(input.summary, ""),
  ];
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

export function buildReviewIgnoreLine(input: {
  quote: string;
  summary: string;
  date: string;
  decisionKey?: string;
}): string {
  const quote = summarizeReviewIgnoreQuote(input.quote, input.summary);
  if (!input.decisionKey) {
    // 兼容没有结构锚点的历史迁移数据；新写入必须携带 decisionKey。
    return `${REVIEW_IGNORE_LINE_PREFIX}「${quote}」(${input.date})`;
  }
  const summary = summarizeReviewIgnoreQuote(input.summary, input.quote);
  return `${REVIEW_IGNORE_LINE_PREFIX}「${quote}」；问题：「${summary}」(${input.date}) ${REVIEW_IGNORE_DECISION_KEY_PREFIX}${input.decisionKey} -->`;
}

/** 只接受规范行尾的完整机器标识，避免正文里偶然出现相似片段被误判。 */
export function reviewIgnoreDecisionKeyFromLine(line: string): string | null {
  const markerStart = line.lastIndexOf(` ${REVIEW_IGNORE_DECISION_KEY_PREFIX}`);
  if (markerStart < 0 || !line.endsWith(" -->")) return null;
  const key = line.slice(
    markerStart + REVIEW_IGNORE_DECISION_KEY_PREFIX.length + 1,
    -" -->".length,
  );
  return key && !/\s/u.test(key) ? key : null;
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

function reviewIgnoreLineIdentity(line: string): string {
  const key = reviewIgnoreDecisionKeyFromLine(line);
  return key === null ? `legacy-line:${line}` : `decision-key:${key}`;
}

/** 机械降级与迁移共用：逐字保留用户区；新行按决定身份、历史行按全等去重。 */
export function appendReviewIgnoreLines(
  supplement: string,
  lines: readonly string[],
): string {
  const parts = splitReviewSupplement(supplement);
  const merged: string[] = [];
  const identities = new Set<string>();
  for (const line of [...parts.ignoreLines, ...lines]) {
    const identity = reviewIgnoreLineIdentity(line);
    if (identities.has(identity)) continue;
    identities.add(identity);
    merged.push(line);
  }
  const prefix = parts.hasManagedSection
    ? parts.userText
    : supplement.length === 0 || /\r?\n$/.test(supplement)
      ? supplement
      : `${supplement}\n\n`;
  return `${prefix}${REVIEW_IGNORE_SECTION_HEADING}\n${merged.join("\n")}`;
}
