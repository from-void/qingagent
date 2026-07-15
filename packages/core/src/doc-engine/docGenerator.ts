import { z } from "zod";
import type { LegacySection, DocumentSnapshot, BridgeFrame } from "@qingagent/contract-ts";
import { legacySectionsToPm, type PmDoc } from "@qingagent/pm-schema";
import { sanitizeSectionMarkdown } from "../utils/sanitizeMarkdown.js";
import { extractJson } from "../utils/extractJson.js";
export { extractJson } from "../utils/extractJson.js";

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
