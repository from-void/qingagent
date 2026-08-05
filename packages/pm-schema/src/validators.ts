import { z } from "zod";
import { isAllowedLinkHref } from "@qingagent/contract-ts";
import { getDeterministicId } from "./hash";
import { normalizeDrawioSource, validateDrawioSource } from "./drawio/drawioXml";
import { PM_SCHEMA_VERSION } from "./schemaVersion";
import { hardenInlineSvg } from "./svg/hardenInlineSvg";
import {
  PM_CALLOUT_TONES,
  PM_DIAGRAM_LANGS,
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
// 表格安全上限同时供 PM 校验与 AI-IR 编译预检使用。跨度/逻辑列限制避免下游按
// colspan 展开巨型数组，总单元格限制避免单个文档塞入异常大的表格节点树。
export const PM_TABLE_MAX_SPAN = 1_000;
export const PM_TABLE_MAX_LOGICAL_COLUMNS = 1_000;
export const PM_TABLE_MAX_CELLS = 10_000;
const PM_TABLE_GRID_WIDTH_MESSAGE_PREFIX = "table row expands to ";
const PM_TABLE_GRID_ROWSPAN_MESSAGE = "table rowspan must not extend beyond the last row";

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

export { isAllowedLinkHref };

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

const codeTextNodeSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  // ProseMirror codeBlock 的 content 是 text* 且 marks 为空；显式声明 never，
  // 避免 Zod 默认剥离未知字段后把非法存量误判为合法。
  marks: z.never().optional(),
});

const inlineMathNodeSchema = z.object({
  type: z.literal("inlineMath"),
  attrs: z.object({ latex: z.string() }),
  marks: z.array(markSchema).optional(),
});

export const FOOTNOTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const FOOTNOTE_NOTE_MAX_LENGTH = 4_096;

const footnoteReferenceNodeSchema = z.object({
  type: z.literal("footnoteReference"),
  attrs: z.object({
    id: z.string().regex(FOOTNOTE_ID_PATTERN),
    note: z.string().trim().min(1).max(FOOTNOTE_NOTE_MAX_LENGTH),
  }),
});

// discriminatedUnion 按 type 判别:校验错误能精确定位到成员内部字段
// (z.union 会聚合各分支错误,path 停在 union 节点,报错没法读)。
const inlineNodeSchema = z.discriminatedUnion("type", [
  textNodeSchema,
  z.object({ type: z.literal("hardBreak"), marks: z.array(markSchema).optional() }),
  inlineMathNodeSchema,
  footnoteReferenceNodeSchema,
]);

const tableSpanSchema = z.number().int().positive().max(PM_TABLE_MAX_SPAN);

const tableCellAttrsSchema = z
  .object({
    colspan: tableSpanSchema.nullable().optional(),
    rowspan: tableSpanSchema.nullable().optional(),
    colwidth: z.array(z.number().int().positive()).max(PM_TABLE_MAX_SPAN).nullable().optional(),
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

/** 解码 data:image/svg+xml，兼容 percent-encoded 与 base64 两种标准形态。 */
export function decodeSvgDataUrl(src: string): string | null {
  const match = src.match(/^data:image\/svg\+xml((?:;[^,]*)?),([\s\S]*)$/i);
  if (!match) return null;
  const isBase64 = (match[1] ?? "")
    .split(";")
    .some((parameter) => parameter.trim().toLowerCase() === "base64");
  try {
    return isBase64 ? decodeBase64Utf8(match[2]!) : decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
}

function isSafeSvgDataUrl(src: string): boolean {
  const svg = decodeSvgDataUrl(src);
  if (!svg) return false;
  const lower = svg.toLowerCase();
  if (!lower.includes("<svg")) return false;
  if (lower.includes("<script") || /\son[a-z]+\s*=/.test(lower)) return false;
  if (/(href|src)\s*=\s*["']\s*(javascript:|data:text\/html)/.test(lower)) return false;
  return true;
}

function decodeBase64Utf8(payload: string): string {
  const bufferCtor = (globalThis as { Buffer?: { from(input: string, encoding: "base64"): { toString(): string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(payload, "base64").toString();
  if (typeof globalThis.atob !== "function") throw new Error("base64 decoder unavailable");
  const binary = globalThis.atob(payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
    width: z.number().min(96).max(640).nullable().optional(),
    height: z.number().min(48).max(480).nullable().optional(),
  })).nullable().optional(),
  zOrders: z.record(z.string(), z.number().finite()).nullable().optional(),
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
  lang: z.enum(PM_DIAGRAM_LANGS),
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
}).superRefine((attrs, context) => {
  if (attrs.lang !== "drawio") return;
  const result = validateDrawioSource(attrs.source);
  if (!result.ok) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source"],
      message: result.error,
    });
  }
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
        start: z.number().int().nullable().optional(),
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
      content: z.array(codeTextNodeSchema).optional(),
    }),
    z.object({
      type: z.literal("table"),
      attrs: blockIdSchema,
      content: z.array(tableRowSchema).min(1).max(PM_TABLE_MAX_CELLS).superRefine(validatePmTableLimits),
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
    content: z
      .array(blockNodeSchema)
      .min(1)
      .refine((content) => (content[0] as { type?: unknown } | undefined)?.type === "paragraph", {
        message: "listItem content must start with paragraph",
      }),
  }),
);

function containsTableNode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const value = node as { type?: unknown; content?: unknown };
  if (value.type === "table") return true;
  return Array.isArray(value.content) && value.content.some(containsTableNode);
}

const tableCellSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.union([z.literal("tableCell"), z.literal("tableHeader")]),
    attrs: tableCellAttrsSchema,
    content: z
      .array(blockNodeSchema)
      .min(1)
      .refine((content) => content.every((block) => !containsTableNode(block)), {
        message: "tableCell content must not contain table",
      }),
  }),
);

const tableRowSchema: LazyNode = z.lazy(() =>
  z.object({
    type: z.literal("tableRow"),
    content: z.array(tableCellSchema).min(1).max(PM_TABLE_MAX_CELLS),
  }),
);

function validatePmTableLimits(
  rows: unknown[],
  context: z.RefinementCtx,
): void {
  let totalCells = 0;
  let expectedWidth: number | undefined;
  let activeRowspans: number[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row || typeof row !== "object" || !Array.isArray((row as { content?: unknown }).content)) {
      return; // 子 schema 已负责报告形状错误；此处只做安全上限检查。
    }
    const cells = (row as { content: unknown[] }).content;
    totalCells += cells.length;
    if (totalCells > PM_TABLE_MAX_CELLS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `table must contain at most ${PM_TABLE_MAX_CELLS} cells`,
        path: [rowIndex, "content"],
      });
      return;
    }

    const occupied = activeRowspans.map((remaining) => remaining > 0);
    const nextRowspans = activeRowspans.map((remaining) => Math.max(0, remaining - 1));
    let cursor = 0;

    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const cell = cells[cellIndex];
      if (!cell || typeof cell !== "object") return;
      const attrsValue = (cell as { attrs?: unknown }).attrs;
      const attrs = attrsValue && typeof attrsValue === "object"
        ? attrsValue as { colspan?: unknown; rowspan?: unknown }
        : undefined;
      const colspan = attrs?.colspan ?? 1;
      const rowspan = attrs?.rowspan ?? 1;
      // superRefine 在子 schema 已产生 issue 时仍可能收到 dirty 值；再次 fail-fast，避免
      // 超大 colspan 落入下方按跨度计数的循环形成 CPU DoS。
      if (
        typeof colspan !== "number" || !Number.isSafeInteger(colspan) || colspan < 1 || colspan > PM_TABLE_MAX_SPAN ||
        typeof rowspan !== "number" || !Number.isSafeInteger(rowspan) || rowspan < 1 || rowspan > PM_TABLE_MAX_SPAN
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `table cell span must be an integer between 1 and ${PM_TABLE_MAX_SPAN}`,
          path: [rowIndex, "content", cellIndex, "attrs"],
        });
        return;
      }
      while (occupied[cursor]) cursor += 1;

      let start = cursor;
      while (true) {
        let conflict: number | undefined;
        for (let offset = 0; offset < colspan; offset += 1) {
          if (occupied[start + offset]) {
            conflict = start + offset;
            break;
          }
        }
        if (conflict === undefined) break;
        start = conflict + 1;
        while (occupied[start]) start += 1;
      }

      const end = start + colspan;
      if (end > PM_TABLE_MAX_LOGICAL_COLUMNS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `table row must contain at most ${PM_TABLE_MAX_LOGICAL_COLUMNS} logical columns`,
          path: [rowIndex, "content", cellIndex, "attrs", "colspan"],
        });
        return;
      }
      for (let column = start; column < end; column += 1) {
        occupied[column] = true;
        if (rowspan > 1) nextRowspans[column] = rowspan - 1;
      }
      cursor = end;
    }

    const width = occupied.reduce((last, value, column) => value ? column + 1 : last, 0);
    if (expectedWidth === undefined) expectedWidth = width;
    let hasGap = false;
    for (let column = 0; column < expectedWidth; column += 1) {
      if (!occupied[column]) {
        hasGap = true;
        break;
      }
    }
    if (width !== expectedWidth || hasGap) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${PM_TABLE_GRID_WIDTH_MESSAGE_PREFIX}${width} logical columns; expected ${expectedWidth}`,
        path: [rowIndex, "content"],
      });
      return;
    }
    activeRowspans = nextRowspans;
  }

  if (activeRowspans.some((remaining) => remaining > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: PM_TABLE_GRID_ROWSPAN_MESSAGE,
      path: [rows.length - 1, "content"],
    });
  }
}

export const pmDocSchema = z.object({
  type: z.literal("doc"),
  attrs: z.object({ schemaVersion: z.literal(PM_SCHEMA_VERSION) }),
  content: z.array(blockNodeSchema),
}).superRefine((doc, context) => {
  const definitions = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (value.type === "footnoteReference" && value.attrs && typeof value.attrs === "object") {
      const attrs = value.attrs as { id?: unknown; note?: unknown };
      if (typeof attrs.id === "string" && typeof attrs.note === "string") {
        const previous = definitions.get(attrs.id);
        if (previous !== undefined && previous !== attrs.note) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `footnote id "${attrs.id}" must use one identical note`,
          });
        } else {
          definitions.set(attrs.id, attrs.note);
        }
      }
    }
    if (Array.isArray(value.content)) value.content.forEach(visit);
  };
  visit(doc);
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

// 存量 documents 可能已含旧校验放过的非矩形表或非法 listItem 首子。
// 读取时先做 P2-16 无损规整，再只兼容既有的两类网格 issue；其它结构、
// 安全上限与内容规则仍严格校验，所有写入继续走 normalizePmDoc。
export function normalizeStoredPmDoc(value: unknown): PmDoc {
  const legacyCodeNormalized = normalizeLegacyCodeBlockMarksPmDoc(value);
  const legacyListNormalized = normalizeLegacyListItemFirstChildPmDoc(legacyCodeNormalized.value);
  const normalized = normalizePmDocShape(legacyListNormalized.value);
  const parsed = pmDocSchema.safeParse(normalized);
  if (parsed.success) return parsed.data as PmDoc;
  const containsOnlyLegacyGridIssues = parsed.error.issues.length > 0 && parsed.error.issues.every(
    (issue) => issue.message === PM_TABLE_GRID_ROWSPAN_MESSAGE ||
      issue.message.startsWith(PM_TABLE_GRID_WIDTH_MESSAGE_PREFIX),
  );
  if (containsOnlyLegacyGridIssues) return normalized as PmDoc;
  throw new Error(`Invalid PM doc: ${parsed.error.message}`);
}

/**
 * 存量兼容：旧 validator 曾允许 codeBlock 的文本携带 marks，而 ProseMirror
 * codeBlock 禁止 marks。读取时只移除这些无渲染语义的 marks，源码文本及其余结构原样保留。
 */
export function normalizeLegacyCodeBlockMarksPmDoc(
  value: unknown,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const normalized = value.map((child) => {
      const result = normalizeLegacyCodeBlockMarksPmDoc(child);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? normalized : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  const record = value as Record<string, unknown>;
  if (record.type === "codeBlock" && Array.isArray(record.content)) {
    let changed = false;
    const content = record.content.map((child) => {
      if (!child || typeof child !== "object" || !("marks" in child)) return child;
      const { marks: _marks, ...text } = child as Record<string, unknown>;
      changed = true;
      return text;
    });
    return {
      value: changed ? { ...record, content } : value,
      changed,
    };
  }

  let changed = false;
  const output: Record<string, unknown> = { ...record };
  if (Array.isArray(record.content)) {
    const result = normalizeLegacyCodeBlockMarksPmDoc(record.content);
    output.content = result.value;
    changed = result.changed;
  }
  return { value: changed ? output : value, changed };
}

function normalizePmDocShape(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type !== "doc") return value;
  return {
    ...record,
    attrs: { schemaVersion: PM_SCHEMA_VERSION, ...(record.attrs as Record<string, unknown> | undefined) },
    content: Array.isArray(record.content)
      ? normalizeNodeContent(record.content, [])
      : record.content,
  };
}

function isTransientUploadImageNode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "image" || !record.attrs || typeof record.attrs !== "object") {
    return false;
  }
  const attrs = record.attrs as Record<string, unknown>;
  if (attrs.uploading === true || attrs.error === true) return true;
  return (
    typeof attrs.blockId === "string" &&
    attrs.blockId.startsWith("upload-image-") &&
    typeof attrs.src === "string" &&
    attrs.src.startsWith("data:image/")
  );
}

function isTransientUploadFileNode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.type !== "fileAttachment" ||
    !record.attrs ||
    typeof record.attrs !== "object"
  ) {
    return false;
  }
  const attrs = record.attrs as Record<string, unknown>;
  return (
    typeof attrs.blockId === "string" &&
    attrs.blockId.startsWith("upload-file-") &&
    typeof attrs.fileId === "string" &&
    (
      attrs.fileId === `upload-pending:${attrs.blockId}` ||
      attrs.fileId === attrs.blockId
    )
  );
}

function normalizeNodeContent(content: unknown[], path: number[]): unknown[] {
  return content.flatMap((child, index) =>
    isTransientUploadImageNode(child) || isTransientUploadFileNode(child)
      ? []
      : [normalizeNodeShape(child, [...path, index])],
  );
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
      output[key] = normalizeNodeContent(child, path);
      continue;
    }
    output[key] = normalizeNodeShape(child, path);
  }
  if (!output.attrs && typeof record.type === "string" && BLOCK_NODE_TYPES_WITH_ID.has(record.type)) {
    output.attrs = normalizeAttrsShape(record.type, {}, path);
  }
  return output;
}

/**
 * P2-16 存量兼容：旧 validator 曾允许 listItem 以 heading/list 等块开头，
 * 而 TipTap 的真实约束是 paragraph block*。heading/penNote 的行内内容与
 * marks 原样转入 paragraph；其它块前补空 paragraph，原块完整保留为后继块。
 */
export function normalizeLegacyListItemFirstChildPmDoc(
  value: unknown,
): { value: unknown; changed: boolean } {
  return normalizeLegacyListItemNode(value, []);
}

function normalizeLegacyListItemNode(
  value: unknown,
  path: number[],
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const normalized = value.map((child, index) => {
      const result = normalizeLegacyListItemNode(child, [...path, index]);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? normalized : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };

  const record = value as Record<string, unknown>;
  let changed = false;
  const output: Record<string, unknown> = { ...record };
  if (Array.isArray(record.content)) {
    const normalized = normalizeLegacyListItemNode(record.content, path);
    output.content = normalized.value;
    changed ||= normalized.changed;
  }
  if (record.type !== "listItem" || !Array.isArray(output.content)) {
    return { value: changed ? output : value, changed };
  }

  const normalizedContent = normalizeLegacyListItemContent(
    output.content,
    record.attrs,
    path,
  );
  if (normalizedContent === output.content) {
    return { value: changed ? output : value, changed };
  }
  output.content = normalizedContent;
  return { value: output, changed: true };
}

function normalizeLegacyListItemContent(
  content: unknown[],
  listItemAttrs: unknown,
  path: number[],
): unknown[] {
  const first = content[0];
  if (!first || typeof first !== "object") return content;
  const firstRecord = first as Record<string, unknown>;
  if (firstRecord.type === "paragraph") return content;

  if (firstRecord.type === "heading" || firstRecord.type === "penNote") {
    const firstAttrs = firstRecord.attrs && typeof firstRecord.attrs === "object"
      ? firstRecord.attrs as Record<string, unknown>
      : {};
    const paragraphAttrs = {
      blockId: typeof firstAttrs.blockId === "string"
        ? firstAttrs.blockId
        : getDeterministicId("block", {
            type: "paragraph",
            path: [...path, 0],
            legacyListItemFirstChild: true,
          }),
      ...(typeof firstAttrs.textAlign === "string"
        ? { textAlign: firstAttrs.textAlign }
        : {}),
    };
    return [{
      ...firstRecord,
      type: "paragraph",
      attrs: paragraphAttrs,
    }, ...content.slice(1)];
  }

  const itemBlockId = listItemAttrs && typeof listItemAttrs === "object"
    ? (listItemAttrs as Record<string, unknown>).blockId
    : undefined;
  const blockId = typeof itemBlockId === "string" && itemBlockId.length > 0
    ? `${itemBlockId}-legacy-paragraph`
    : getDeterministicId("block", {
        type: "paragraph",
        path,
        legacyListItemFirstChild: true,
      });
  return [{
    type: "paragraph",
    attrs: { blockId },
  }, ...content];
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
    // diagram.svg 是前端可再生缓存：AI-IR / legacy 转换入口会先强制置空；
    // PM 写回只有通过既有严格 SVG 加固与 200KB 上限才允许持久化，供离线导出复用。
    attrs.svg = typeof attrs.svg === "string" ? hardenInlineSvg(attrs.svg) : null;
    if (attrs.lang === "drawio" && typeof attrs.source === "string") {
      // draw.io 允许 base64+deflate；入库前展开成可读 XML，供 AI 读取、修改与 diff。
      // 非法 XML 留给 schema 形成带 path 的校验错误，避免 safeParse 入口直接抛异常。
      try {
        attrs.source = normalizeDrawioSource(attrs.source);
      } catch {
        // 由 diagramAttrsSchema.superRefine 报告具体错误。
      }
    }
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
