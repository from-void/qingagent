import { z } from "zod";
import { getDeterministicId } from "./hash";
import { PM_SCHEMA_VERSION } from "./schemaVersion";
import {
  PM_CALLOUT_TONES,
  PM_HEADING_LEVELS,
  PM_HIGHLIGHT_COLORS,
  PM_IMAGE_ALIGN_VALUES,
  PM_ORDERED_LIST_STYLES,
  PM_SCHEMA_MARK_NAMES,
  PM_SCHEMA_NODE_NAMES,
  PM_TEXT_COLORS,
  PM_THEME_COLORS,
  PM_TEXT_ALIGN_VALUES,
} from "./spec";
import type { PmDoc, PmFileAttachmentAttrs } from "./types";

const nonEmpty = z.string().min(1);
const blockIdSchema = z.object({
  blockId: nonEmpty,
  textAlign: z.enum(PM_TEXT_ALIGN_VALUES).nullable().optional(),
});

const BLOCK_NODE_TYPES_WITH_ID = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "horizontalRule",
  "codeBlock",
  "table",
  "image",
  "diagram",
  "fileAttachment",
  "penNote",
  "taskList",
  "taskItem",
  "callout",
  "columnList",
  "column",
  "blockMath",
]);

export function isAllowedLinkHref(href: string): boolean {
  const value = href.trim();
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) return false;
  return /^https?:\/\//i.test(value) || /^\/(?!\/)/.test(value) || /^#[^\s]*$/.test(value);
}

const linkHrefSchema = z
  .string()
  .refine(isAllowedLinkHref, {
    message: "link href must be http(s), root-relative, or hash-relative",
  });

export function isAllowedThemeColor(color: unknown): boolean {
  return typeof color === "string" && (PM_THEME_COLORS as readonly string[]).includes(color);
}

const markSchema: z.ZodType = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  z.object({ type: z.literal("underline") }),
  z.object({ type: z.literal("strike") }),
  z.object({ type: z.literal("code") }),
  z.object({
    type: z.literal("link"),
    attrs: z.object({ href: linkHrefSchema, title: z.string().nullable().optional() }),
  }),
  z.object({
    type: z.literal("textColor"),
    attrs: z.object({ color: z.enum(PM_TEXT_COLORS) }),
  }),
  z.object({
    type: z.literal("highlight"),
    attrs: z.object({ color: z.enum(PM_HIGHLIGHT_COLORS) }),
  }),
]);

const textNodeSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  marks: z.array(markSchema).optional(),
});

const inlineMathNodeSchema = z.object({
  type: z.literal("inlineMath"),
  attrs: z.object({ latex: z.string() }),
});

// discriminatedUnion 按 type 判别:校验错误能精确定位到成员内部字段
// (z.union 会聚合各分支错误,path 停在 union 节点,报错没法读)。
const inlineNodeSchema = z.discriminatedUnion("type", [
  textNodeSchema,
  z.object({ type: z.literal("hardBreak") }),
  inlineMathNodeSchema,
]);

const tableCellAttrsSchema = z
  .object({
    colspan: z.number().int().positive().nullable().optional(),
    rowspan: z.number().int().positive().nullable().optional(),
    colwidth: z.array(z.number().int().positive()).nullable().optional(),
    backgroundColor: z.enum(PM_THEME_COLORS).nullable().optional(),
  })
  .optional();

// 文件名段允许 percent-encoded 字符(%XX):uploadedAssetUrl 用 encodeURIComponent 编码文件名,
// 中文/空格/括号等会变成 %E6.. / %20 等。此前只许 [A-Za-z0-9._-] → 中文图片名被静默拒绝、
// setImage 返回 false、图片插不进文档(高频:中文截图直接插不了)。文件名仅作下载名(后端按
// UUID fileId 取文件),放开 % 安全;路径穿越另由下方 %2f / %2e%2e 守卫拦住。
const uploadFileSrcPattern =
  /^\/api\/v1\/files\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[A-Za-z0-9._~%!*'()-]+$/;

export function isAllowedImageSrc(src: string): boolean {
  if (!src || src.startsWith("blob:")) return false;
  if (
    uploadFileSrcPattern.test(src) &&
    !src.includes("/../") &&
    !src.endsWith("/.") &&
    !src.endsWith("/..") &&
    !/%2f/i.test(src) && // 编码后的 / —— 防文件名段藏路径分隔符
    !/%2e%2e/i.test(src) // 编码后的 ..
  ) {
    return true;
  }
  if (src.startsWith("data:image/svg+xml")) return isSafeSvgDataUrl(src);
  return false;
}

function isSafeSvgDataUrl(src: string): boolean {
  const commaIndex = src.indexOf(",");
  if (commaIndex < 0) return false;

  const meta = src.slice(0, commaIndex).toLowerCase();
  const payload = src.slice(commaIndex + 1);
  let svg = "";

  try {
    svg = meta.includes(";base64") ? atobPortable(payload) : decodeURIComponent(payload);
  } catch {
    return false;
  }

  const lower = svg.toLowerCase();
  if (!lower.includes("<svg")) return false;
  if (lower.includes("<script") || /\son[a-z]+\s*=/.test(lower)) return false;
  if (/(href|src)\s*=\s*["']\s*(javascript:|data:text\/html)/.test(lower)) return false;
  return true;
}

function atobPortable(payload: string): string {
  if (typeof globalThis.atob === "function") return globalThis.atob(payload);
  const bufferCtor = (globalThis as { Buffer?: { from(input: string, encoding: "base64"): { toString(): string } } }).Buffer;
  if (!bufferCtor) throw new Error("base64 decoder unavailable");
  return bufferCtor.from(payload, "base64").toString();
}

export function isAllowedFileAttachment(value: unknown): value is PmFileAttachmentAttrs {
  const result = fileAttachmentAttrsSchema.safeParse(value);
  return result.success;
}

export const isAllowedFileRef = isAllowedFileAttachment;

const imageAttrsSchema = blockIdSchema.extend({
  src: z.string().refine(isAllowedImageSrc, { message: "image src is not allowed" }),
  alt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  align: z.enum(PM_IMAGE_ALIGN_VALUES).nullable().optional(),
});

export function isAllowedOrderedListStyle(value: unknown): boolean {
  return typeof value === "string" && (PM_ORDERED_LIST_STYLES as readonly string[]).includes(value);
}

const fileAttachmentAttrsSchema = blockIdSchema.extend({
  fileId: nonEmpty,
  filename: nonEmpty,
  mimeType: nonEmpty,
  size: z.number().int().nonnegative(),
});

const diagramColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$|^rgba?\([0-9.,\s]+\)$/)
  .nullable()
  .optional();

const diagramOverlaySchema = z.object({
  positions: z.record(z.string(), z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  })).nullable().optional(),
  styles: z.record(z.string(), z.object({
    fill: diagramColorSchema,
    stroke: diagramColorSchema,
    textColor: diagramColorSchema,
    strokeWidth: z.number().positive().max(12).nullable().optional(),
    fontSize: z.number().positive().max(72).nullable().optional(),
  })).nullable().optional(),
  edgeStyles: z.record(z.string(), z.object({
    stroke: diagramColorSchema,
    textColor: diagramColorSchema,
    strokeWidth: z.number().positive().max(12).nullable().optional(),
  })).nullable().optional(),
  edgeHandles: z.record(z.string(), z.object({
    sourceHandle: z.string().min(1).nullable().optional(),
    targetHandle: z.string().min(1).nullable().optional(),
  })).nullable().optional(),
}).nullable().optional();

const diagramAttrsSchema = blockIdSchema.extend({
  lang: nonEmpty,
  source: nonEmpty,
  // svg 是客户端渲染缓存:agent 生成时为 null,编辑器渲染后回填;允许缺省/null。
  svg: z.string().nullable().optional(),
  // 用户拖拽改的高度(px);agent 不设、缺省 null,仅编辑器持久化。
  height: z.number().int().positive().nullable().optional(),
  // 用户拖拽改的宽度(px);agent 不设、缺省 null(=占满栏宽),仅编辑器持久化。
  width: z.number().int().positive().nullable().optional(),
  // 整块在栏内的对齐(left/center/right);宽度小于栏宽时生效。复用图片那套对齐取值。
  align: z.enum(PM_IMAGE_ALIGN_VALUES).nullable().optional(),
  // 用户域 overlay:位置+样式持久化,但不进 AI-IR。
  overlay: diagramOverlaySchema,
});

type LazyNode = z.ZodType;

const taskListSchema = z.object({
  type: z.literal("taskList"),
  attrs: blockIdSchema,
  content: z.array(z.lazy(() => taskItemSchema)).min(1),
});

const blockNodeSchema: LazyNode = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("paragraph"),
      attrs: blockIdSchema,
      content: z.array(inlineNodeSchema).optional(),
    }),
    z.object({
      type: z.literal("heading"),
      attrs: blockIdSchema.extend({ level: z.union(PM_HEADING_LEVELS.map((level) => z.literal(level)) as [
        z.ZodLiteral<1>,
        z.ZodLiteral<2>,
        z.ZodLiteral<3>,
        z.ZodLiteral<4>,
        z.ZodLiteral<5>,
        z.ZodLiteral<6>,
      ]), anchor: z.string().nullable().optional() }),
      content: z.array(inlineNodeSchema).optional(),
    }),
    z.object({
      type: z.literal("blockquote"),
      attrs: blockIdSchema,
      content: z.array(blockNodeSchema).min(1),
    }),
    z.object({
      type: z.literal("bulletList"),
      attrs: blockIdSchema,
      content: z.array(listItemSchema).min(1),
    }),
    z.object({
      type: z.literal("orderedList"),
      attrs: blockIdSchema.extend({
        start: z.number().int().positive().nullable().optional(),
        listStyle: z.enum(PM_ORDERED_LIST_STYLES).nullable().optional(),
      }),
      content: z.array(listItemSchema).min(1),
    }),
    z.object({
      type: z.literal("horizontalRule"),
      attrs: blockIdSchema,
    }),
    z.object({
      type: z.literal("codeBlock"),
      attrs: blockIdSchema.extend({ language: z.string().nullable().optional() }),
      content: z.array(textNodeSchema).optional(),
    }),
    z.object({
      type: z.literal("table"),
      attrs: blockIdSchema,
      content: z.array(tableRowSchema).min(1),
    }),
    z.object({ type: z.literal("image"), attrs: imageAttrsSchema }),
    z.object({ type: z.literal("diagram"), attrs: diagramAttrsSchema }),
    z.object({ type: z.literal("fileAttachment"), attrs: fileAttachmentAttrsSchema }),
    z.object({
      type: z.literal("penNote"),
      attrs: blockIdSchema,
      content: z.array(inlineNodeSchema).optional(),
    }),
    taskListSchema,
    z.object({
      type: z.literal("callout"),
      attrs: blockIdSchema.extend({
        emoji: z.string().max(16).nullable().optional(),
        tone: z.enum(PM_CALLOUT_TONES).nullable().optional(),
      }),
      content: z.array(paragraphNodeSchema).min(1),
    }),
    z.object({
      type: z.literal("columnList"),
      attrs: blockIdSchema,
      content: z.array(columnSchema).min(2),
    }),
    z.object({
      type: z.literal("blockMath"),
      attrs: blockIdSchema.extend({ latex: z.string() }),
    }),
  ]),
);

const columnSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.literal("column"),
    attrs: blockIdSchema.extend({ widthRatio: z.number().positive().max(1).nullable().optional() }),
    content: z.array(blockNodeSchema).min(1),
  }),
);

const paragraphNodeSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.literal("paragraph"),
    attrs: blockIdSchema,
    content: z.array(inlineNodeSchema).optional(),
  }),
);

const taskItemSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.literal("taskItem"),
    attrs: blockIdSchema.extend({ checked: z.boolean() }),
    content: z
      .array(blockNodeSchema)
      .min(1)
      .refine((content) => (content[0] as { type?: unknown } | undefined)?.type === "paragraph", {
        message: "taskItem content must start with paragraph",
      }),
  }),
);

const listItemSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.literal("listItem"),
    attrs: blockIdSchema,
    content: z.array(blockNodeSchema).min(1),
  }),
);

const tableCellSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.union([z.literal("tableCell"), z.literal("tableHeader")]),
    attrs: tableCellAttrsSchema,
    content: z.array(blockNodeSchema).min(1),
  }),
);

const tableRowSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.literal("tableRow"),
    content: z.array(tableCellSchema).min(1),
  }),
);

export const pmDocSchema = z.object({
  type: z.literal("doc"),
  attrs: z.object({ schemaVersion: z.literal(PM_SCHEMA_VERSION) }),
  content: z.array(blockNodeSchema),
});

export const PM_VALIDATOR_NODE_NAMES = PM_SCHEMA_NODE_NAMES;
export const PM_VALIDATOR_MARK_NAMES = PM_SCHEMA_MARK_NAMES;

export function safeParsePmDoc(value: unknown): ReturnType<typeof pmDocSchema.safeParse> {
  return pmDocSchema.safeParse(normalizePmDocShape(value));
}

export function assertValidPmDoc(value: unknown): PmDoc {
  const parsed = safeParsePmDoc(value);
  if (!parsed.success) {
    throw new Error(`Invalid PM doc: ${parsed.error.message}`);
  }
  return parsed.data as PmDoc;
}

export function normalizePmDoc(value: unknown): PmDoc {
  return assertValidPmDoc(value);
}

function normalizePmDocShape(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type !== "doc") return value;
  return {
    ...record,
    attrs: { schemaVersion: PM_SCHEMA_VERSION, ...(record.attrs as Record<string, unknown> | undefined) },
    content: Array.isArray(record.content)
      ? record.content.map((child, index) => normalizeNodeShape(child, [index]))
      : [],
  };
}

function normalizeNodeShape(value: unknown, path: number[]): unknown {
  if (Array.isArray(value)) return value.map((child, index) => normalizeNodeShape(child, [...path, index]));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "textAlign" && child === null) continue;
    if (key === "attrs" && child && typeof child === "object") {
      output[key] = normalizeAttrsShape(record.type, child, path);
      continue;
    }
    if (key === "content" && Array.isArray(child)) {
      output[key] = child.map((nested, index) => normalizeNodeShape(nested, [...path, index]));
      continue;
    }
    output[key] = normalizeNodeShape(child, path);
  }
  if (!output.attrs && typeof record.type === "string" && BLOCK_NODE_TYPES_WITH_ID.has(record.type)) {
    output.attrs = normalizeAttrsShape(record.type, {}, path);
  }
  return output;
}

function normalizeAttrsShape(type: unknown, value: unknown, path: number[]): Record<string, unknown> {
  const attrs = { ...(value as Record<string, unknown>) };
  for (const [key, child] of Object.entries(attrs)) {
    if (child === null) delete attrs[key];
  }
  if (
    typeof type === "string" &&
    BLOCK_NODE_TYPES_WITH_ID.has(type) &&
    (typeof attrs.blockId !== "string" || attrs.blockId.trim().length === 0)
  ) {
    attrs.blockId = getDeterministicId("block", { type, path });
  }
  if (type === "diagram") {
    // diagram.svg 是前端可再生的渲染缓存,不信任任何直写落盘入口传入的 SVG。
    attrs.svg = null;
  }
  if (type === "orderedList" && "listStyle" in attrs && !isAllowedOrderedListStyle(attrs.listStyle)) {
    attrs.listStyle = "decimal";
  }
  if (type === "image") {
    // 上传中/失败态只属于编辑器瞬时 UI,不能通过 normalize/save 泄漏到持久 PM 文档。
    delete attrs.uploading;
    delete attrs.progress;
    delete attrs.error;
    delete attrs.preview;
  }
  return attrs;
}
