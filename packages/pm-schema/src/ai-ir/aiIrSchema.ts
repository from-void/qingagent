import { z } from "zod";
import { PM_CALLOUT_TONES, PM_DIAGRAM_LANGS, PM_HIGHLIGHT_COLORS, PM_IMAGE_ALIGN_VALUES, PM_ORDERED_LIST_STYLES, PM_TEXT_ALIGN_VALUES, PM_TEXT_COLORS } from "../spec";
import type { PmDiagramLang } from "../types";
import {
  FOOTNOTE_ID_PATTERN,
  FOOTNOTE_NOTE_MAX_LENGTH,
  isAllowedImageSrc,
  isAllowedLinkHref,
} from "../validators";

const linkHrefSchema = z
  .string()
  .refine(isAllowedLinkHref, {
    message: "link href must be http(s), root-relative, or hash-relative",
  });

export const aiTextAlignSchema = z.enum(PM_TEXT_ALIGN_VALUES);
export const aiImageAlignSchema = z.enum(PM_IMAGE_ALIGN_VALUES);
export const aiOrderedListStyleSchema = z.enum(PM_ORDERED_LIST_STYLES);

export const aiRunMarkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  z.object({ type: z.literal("underline") }),
  z.object({ type: z.literal("strike") }),
  z.object({ type: z.literal("strikeThrough") }),
  z.object({ type: z.literal("code") }),
  z.object({ type: z.literal("link"), href: linkHrefSchema, title: z.string().nullable().optional() }),
  z.object({ type: z.literal("textColor"), color: z.enum(PM_TEXT_COLORS) }),
  z.object({ type: z.literal("highlight"), color: z.enum(PM_HIGHLIGHT_COLORS) }),
  // 行内公式:整个 run 转 inlineMath 节点,run.text 即 LaTeX 源码;与其他 mark 不可组合。
  z.object({ type: z.literal("math") }),
]);

export const aiTextRunSchema = z.object({
  text: z.string(),
  marks: z.array(aiRunMarkSchema).optional(),
});

export const aiFootnoteRunSchema = z.object({
  type: z.literal("footnote"),
  id: z.string().regex(FOOTNOTE_ID_PATTERN).optional(),
  note: z.string().trim().min(1).max(FOOTNOTE_NOTE_MAX_LENGTH),
});

export const aiRunSchema = z.union([aiTextRunSchema, aiFootnoteRunSchema]);

export type AiRunMark = z.infer<typeof aiRunMarkSchema>;
export type AiTextRun = z.infer<typeof aiTextRunSchema>;
export type AiFootnoteRun = z.infer<typeof aiFootnoteRunSchema>;
export type AiRun = z.infer<typeof aiRunSchema>;
export type AiTextAlign = z.infer<typeof aiTextAlignSchema>;

export type AiTableCell = {
  blocks: AiBlock[];
  header?: boolean;
  backgroundColor?: string;
  colspan?: number;
  rowspan?: number;
};

export type AiTableRow = {
  cells: AiTableCell[];
  header?: boolean;
};

export type AiListItem = {
  runs: AiRun[];
  children?: AiBlock[];
};

export type AiTaskListItem = {
  checked?: boolean;
  runs: AiRun[];
  children?: AiBlock[];
};

export type AiColumn = {
  widthRatio?: number | null;
  blocks: AiBlock[];
};

type AiContainerContent =
  | { runs: AiRun[]; blocks?: never }
  | { blocks: AiBlock[]; runs?: never };

export type AiBlock = {
  /** 容器子块往返时保留 PM 块身份；模型新生成块可省略，由编译器稳定派生。 */
  blockId?: string;
} & (
  | { type: "paragraph"; runs: AiRun[]; textAlign?: AiTextAlign }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; anchor?: string | null; runs: AiRun[]; textAlign?: AiTextAlign }
  | ({ type: "blockquote" } & AiContainerContent)
  | { type: "codeBlock"; language?: string | null; text: string }
  | { type: "bulletList"; items: AiListItem[] }
  | { type: "orderedList"; items: AiListItem[]; start?: number | null; listStyle?: (typeof PM_ORDERED_LIST_STYLES)[number] | null }
  | { type: "horizontalRule" }
  | { type: "table"; rows: AiTableRow[] }
  | {
      type: "image";
      src: string;
      alt?: string | null;
      title?: string | null;
      caption?: string | null;
      width?: number | null;
      height?: number | null;
      align?: (typeof PM_IMAGE_ALIGN_VALUES)[number] | null;
    }
  | { type: "fileAttachment"; fileId: string; filename: string; mimeType: string; size: number }
  | { type: "penNote"; runs: AiRun[] }
  | { type: "taskList"; items: AiTaskListItem[] }
  | ({
      type: "callout";
      emoji?: string | null;
      tone?: (typeof PM_CALLOUT_TONES)[number] | null;
    } & AiContainerContent)
  | { type: "columnList"; columns: AiColumn[] }
  | { type: "blockMath"; latex: string }
  | { type: "diagram"; lang: PmDiagramLang; source: string; svg?: string | null }
);

function aiBlockContainsTable(block: AiBlock): boolean {
  if (block.type === "table") return true;
  if (block.type === "bulletList" || block.type === "orderedList") {
    return block.items.some((item) => item.children?.some(aiBlockContainsTable));
  }
  if (block.type === "taskList") {
    return block.items.some((item) => item.children?.some(aiBlockContainsTable));
  }
  if (block.type === "columnList") {
    return block.columns.some((column) => column.blocks.some(aiBlockContainsTable));
  }
  return false;
}

export const aiTableCellSchema: z.ZodType<AiTableCell> = z.lazy(() =>
  z.object({
    blocks: z.array(aiBlockSchema).refine(
      (blocks) => blocks.every((block) => !aiBlockContainsTable(block)),
      { message: "table cell blocks must not contain table" },
    ),
    header: z.boolean().optional(),
    // 单元格背景色(主题色名,如 "rose")。修 cell-bg-color-lost-after-ai-followup:
    // AI 编辑走 AI-IR 往返时此前不带 cell 背景色→AI 改表后丢色。
    backgroundColor: z.string().optional(),
    colspan: z.number().int().min(1).optional(),
    rowspan: z.number().int().min(1).optional(),
  }),
);

export const aiTableRowSchema: z.ZodType<AiTableRow> = z.lazy(() =>
  z.object({
    cells: z.array(aiTableCellSchema).min(1),
    header: z.boolean().optional(),
  }),
);

export const aiListItemSchema: z.ZodType<AiListItem> = z.lazy(() =>
  z.object({
    runs: z.array(aiRunSchema),
    children: z.array(aiBlockSchema).optional(),
  }),
);

export const aiTaskListItemSchema: z.ZodType<AiTaskListItem> = z.lazy(() =>
  z.object({
    checked: z.boolean().default(false),
    runs: z.array(aiRunSchema),
    children: z.array(aiBlockSchema).optional(),
  }),
);

export const aiColumnSchema: z.ZodType<AiColumn> = z.lazy(() =>
  z.object({
    widthRatio: z.number().positive().max(1).nullable().optional(),
    blocks: z.array(aiBlockSchema).min(1),
  }),
);

const aiBlockIdentitySchemaShape = {
  blockId: z.string().min(1).optional(),
};

export const aiBlockSchema: z.ZodType<AiBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("paragraph"), runs: z.array(aiRunSchema), textAlign: aiTextAlignSchema.optional() }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]), anchor: z.string().nullable().optional(), runs: z.array(aiRunSchema), textAlign: aiTextAlignSchema.optional() }),
    z.object({
      ...aiBlockIdentitySchemaShape,
      type: z.literal("blockquote"),
      runs: z.array(aiRunSchema).optional(),
      blocks: z.array(aiBlockSchema).min(1).optional(),
    }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("codeBlock"), language: z.string().nullable().optional(), text: z.string() }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("bulletList"), items: z.array(aiListItemSchema).min(1) }),
    z.object({
      ...aiBlockIdentitySchemaShape,
      type: z.literal("orderedList"),
      items: z.array(aiListItemSchema).min(1),
      start: z.number().int().nullable().optional(),
      listStyle: aiOrderedListStyleSchema.nullable().optional(),
    }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("horizontalRule") }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("table"), rows: z.array(aiTableRowSchema).min(1) }),
    z.object({
      ...aiBlockIdentitySchemaShape,
      type: z.literal("image"),
      src: z.string().refine(isAllowedImageSrc, { message: "image src is not allowed" }),
      alt: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      caption: z.string().nullable().optional(),
      width: z.number().int().positive().nullable().optional(),
      height: z.number().int().positive().nullable().optional(),
      align: aiImageAlignSchema.nullable().optional(),
    }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("fileAttachment"), fileId: z.string().min(1), filename: z.string().min(1), mimeType: z.string().min(1), size: z.number().int().nonnegative() }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("penNote"), runs: z.array(aiRunSchema) }),
    z.object({
      ...aiBlockIdentitySchemaShape,
      type: z.literal("taskList"),
      items: z.array(aiTaskListItemSchema).min(1),
    }),
    z.object({
      ...aiBlockIdentitySchemaShape,
      type: z.literal("callout"),
      emoji: z.string().max(16).nullable().optional(),
      tone: z.enum(PM_CALLOUT_TONES).nullable().optional(),
      runs: z.array(aiRunSchema).optional(),
      blocks: z.array(aiBlockSchema).min(1).refine(
        (blocks) => blocks.every((block) => block.type === "paragraph"),
        { message: "callout blocks must contain paragraphs only" },
      ).optional(),
    }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("columnList"), columns: z.array(aiColumnSchema).min(2) }),
    z.object({ ...aiBlockIdentitySchemaShape, type: z.literal("blockMath"), latex: z.string().min(1) }),
    // 图表块:Mermaid 源码或未压缩 mxGraph XML;svg 客户端渲染缓存,agent 生成时可缺省/null。
    z.object({
      ...aiBlockIdentitySchemaShape,
      type: z.literal("diagram"),
      lang: z.enum(PM_DIAGRAM_LANGS),
      source: z.string().min(1),
      svg: z.string().nullable().optional(),
    }),
  ]).superRefine((block, ctx) => {
    if (
      (block.type === "blockquote" || block.type === "callout")
      && (
        (block.runs === undefined && block.blocks === undefined)
        || (block.runs !== undefined && block.blocks !== undefined)
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: `${block.type} requires exactly one of runs or blocks`,
      });
    }
  }) as unknown as z.ZodType<AiBlock>,
);

export const aiDocumentSchema = z.object({
  title: z.string().nullable().optional(),
  blocks: z.array(aiBlockSchema),
});

export const aiDocumentEnvelopeSchema = z.object({
  title: z.string().nullable().optional(),
  blocks: z.array(z.unknown()).min(1, { message: "生成的文档为空" }),
});

export type AiDocument = z.infer<typeof aiDocumentSchema>;
