import { z } from "zod";
import type { LegacySection, DocumentSnapshot, BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";
import { sanitizeSectionMarkdown } from "../utils/sanitizeMarkdown.js";

/**
 * Zod schema for a single LegacySection.
 * Recoverable text/table/code fields are lenient so one malformed model
 * section can be dropped after semantic validation instead of failing the doc.
 */
const docSectionSchema: z.ZodType<LegacySection> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("h1"),
    data: z.object({ text: z.string().default("") }),
  }),
  z.object({
    kind: z.literal("h2"),
    data: z.object({ text: z.string().default(""), anchor: z.string().nullable().optional().default(null) }),
  }),
  z.object({
    kind: z.literal("p"),
    data: z.object({ text: z.string().default("") }),
  }),
  z.object({
    kind: z.literal("table"),
    data: z.object({
      head: z.array(z.string()).default([]),
      rows: z.array(z.array(z.string())).default([]),
    }),
  }),
  z.object({
    kind: z.literal("code"),
    data: z.object({ body: z.string().default("") }),
  }),
  z.object({
    kind: z.literal("penNote"),
    data: z.object({ text: z.string().default("") }),
  }),
  z.object({
    kind: z.literal("image"),
    data: z.object({
      src: z.string(),
      alt: z.string().min(1),
      caption: z.string().nullable().default(null),
      width: z.number().nullable().default(null),
      height: z.number().nullable().default(null),
    }),
  }),
  // 图表块:generateDoc 首稿也能直接出图(Mermaid 源码);svg 由前端客户端渲染回填。
  z.object({
    kind: z.literal("diagram"),
    data: z.object({
      lang: z.string().default("mermaid"),
      source: z.string().min(1),
      svg: z.string().nullable().default(null),
    }),
  }),
  // quote/hr/list:pmToLegacySections 会从 blockquote/horizontalRule/bulletList/orderedList
  // 转出这些 kind(前端 DocumentSnapshotView 也早已渲染),此前漏在校验 schema 里 →
  // 长文一用引用/列表/分隔线就 output validation 失败。补齐对齐。
  z.object({
    kind: z.literal("quote"),
    data: z.object({ text: z.string().default("") }),
  }),
  z.object({
    kind: z.literal("hr"),
    data: z.object({}).default({}),
  }),
  z.object({
    kind: z.literal("list"),
    data: z.object({
      ordered: z.boolean().default(false),
      items: z.array(z.string()).default([]),
    }),
  }),
]);

/** Schema for an entire document: bare array of LegacySection. */
const legacySectionsSchema = z.array(docSectionSchema).min(1);

export { docSectionSchema, legacySectionsSchema };

/**
 * Normalize a raw model section into a usable LegacySection.
 * Returns null for syntactically invalid or semantically empty sections.
 */
export function normalizeLegacySection(raw: unknown): LegacySection | null {
  const result = docSectionSchema.safeParse(raw);
  if (!result.success) return null;

  const section = sanitizeSectionMarkdown(result.data);
  switch (section.kind) {
    case "quote":
      return section.data.text.trim() === "" ? null : section;
    case "hr":
      return section;
    case "list":
      return section.data.items.length > 0 ? section : null;
    case "code":
      return section.data.body.trim() === "" ? null : section;
    case "table":
      return section.data.head.length > 0 && section.data.rows.length > 0
        ? section
        : null;
    case "h1":
    case "h2":
    case "p":
    case "penNote":
      return section.data.text.trim() === "" ? null : section;
    case "image":
      return section;
    case "diagram":
      return section.data.source.trim() === "" ? null : section;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a JSON string from potentially messy LLM output.
 * Handles markdown code fences, leading prose, etc.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  // 1. 如果包在 markdown code fence 里,也只从 fence body 内提取可解析 JSON。
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    const body = fenceMatch[1]!.trim();
    return extractFirstParsableJsonValue(body) ?? body;
  }

  const jsonValue = extractFirstParsableJsonValue(trimmed);
  if (jsonValue) return jsonValue;

  // 2. 没有可解析候选时,从第一个疑似 JSON 起点返回,让上层 parse 失败后重试。
  const startIdx = findFirstJsonStart(trimmed);
  if (startIdx >= 0) {
    return trimmed.slice(startIdx);
  }

  // 3. 完全没有疑似 JSON,原样返回并让 JSON.parse 给出清晰失败。
  return trimmed;
}

function extractFirstParsableJsonValue(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== "[" && ch !== "{") continue;

    const endIdx = findBalancedJsonEnd(text, i);
    // 首个疑似 JSON 都不闭合时不能继续捞内部数组,否则截断对象会假成功。
    if (endIdx < 0) {
      const sanitizedTail = sanitizeUnescapedQuotesInJsonStrings(text.slice(i));
      if (sanitizedTail !== text.slice(i)) {
        const sanitizedEndIdx = findBalancedJsonEnd(sanitizedTail, 0);
        if (sanitizedEndIdx >= 0) {
          const candidate = sanitizedTail.slice(0, sanitizedEndIdx + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // 继续走原失败路径。
          }
        }
      }
      return null;
    }

    const candidate = text.slice(i, endIdx + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      const sanitized = sanitizeUnescapedQuotesInJsonStrings(candidate);
      if (sanitized !== candidate) {
        try {
          JSON.parse(sanitized);
          return sanitized;
        } catch {
          // 这个候选不是裸引号可恢复形态,保持原有失败语义。
        }
      }
      // 这个平衡候选解析失败:跳过【整个候选】(i=endIdx,循环 i++ 移到其后),
      // 不下钻它内部的嵌套 bracket——否则尾逗号/截断数组 [{...},] 会被抽出内层
      // {...} 静默丢内容。只允许匹配该候选【之后】的独立 top-level JSON
      // (如前导伪括号 "参考 [示例] 如下:\n[真JSON]")。
      i = endIdx;
    }
  }
  return null;
}

function sanitizeUnescapedQuotesInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (escape) {
      out += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escape = true;
      continue;
    }

    if (ch !== '"') {
      out += ch;
      continue;
    }

    if (!inString) {
      inString = true;
      out += ch;
      continue;
    }

    const next = nextNonWhitespaceChar(text, i + 1);
    if (next === null || next === ":" || next === "," || next === "}" || next === "]") {
      inString = false;
      out += ch;
      continue;
    }

    out += '\\"';
  }

  return out;
}

function nextNonWhitespaceChar(text: string, start: number): string | null {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (!/\s/.test(ch)) return ch;
  }
  return null;
}

function findFirstJsonStart(text: string): number {
  const bracketIdx = text.indexOf("[");
  const braceIdx = text.indexOf("{");
  if (bracketIdx === -1) return braceIdx;
  if (braceIdx === -1) return bracketIdx;
  return Math.min(bracketIdx, braceIdx);
}

function findBalancedJsonEnd(text: string, startIdx: number): number {
  const first = text[startIdx];
  if (first !== "[" && first !== "{") return -1;

  const stack: string[] = [first === "[" ? "]" : "}"];
  let inString = false;
  let escape = false;

  for (let i = startIdx + 1; i < text.length; i++) {
    const ch = text[i]!;

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

    if (ch === "[" || ch === "{") {
      stack.push(ch === "[" ? "]" : "}");
      continue;
    }
    if (ch === "]" || ch === "}") {
      if (stack.at(-1) !== ch) return -1;
      stack.pop();
      if (stack.length === 0) return i;
    }
  }

  return -1;
}

/**
 * Parse raw LLM text into a validated LegacySection array.
 * Accepts both bare arrays and `{ "sections": [...] }` wrappers.
 */
export function parseLegacySections(rawText: string): LegacySection[] {
  const jsonStr = extractJson(rawText);
  const parsed = JSON.parse(jsonStr);

  const rawSections = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { sections?: unknown }).sections)
      ? (parsed as { sections: unknown[] }).sections
      : null;

  if (!rawSections) {
    throw new Error("no usable doc sections");
  }

  const sections = rawSections
    .map((section) => normalizeLegacySection(section))
    .filter((section): section is LegacySection => section !== null);
  const dropped = rawSections.length - sections.length;
  if (dropped > 0) {
    console.warn(`Dropped ${dropped} unusable doc section(s).`);
  }
  if (sections.length === 0) {
    throw new Error("no usable doc sections");
  }

  return sections;
}

/**
 * Build a DocumentSnapshot from sections and version number.
 */
export function buildDocumentSnapshot(
  sections: LegacySection[],
  version: number,
  doc?: PmDoc,
): DocumentSnapshot {
  return {
    version,
    ts: new Date().toISOString(),
    sections,
    doc: doc ?? legacySectionsToPm(sections as never),
  };
}

/**
 * Emit progressive documentSnapshotWritten frames.
 * We emit one frame per batch of sections to show progressive loading.
 */
export function* emitDocumentSnapshotFrames(
  sections: LegacySection[],
  version: number,
): Generator<BridgeFrame> {
  const batchSize = 3;
  for (let i = 0; i < sections.length; i += batchSize) {
    const partialSections = sections.slice(0, i + batchSize);
    const doc = buildDocumentSnapshot(partialSections, version);
    yield { kind: "documentSnapshotWritten", data: { doc } };
  }

  // Always emit the final complete version
  if (sections.length % batchSize !== 0) {
    // Already emitted above in the last iteration
  }
}
