import { z } from "zod";
import { PM_CALLOUT_TONES, PM_HIGHLIGHT_COLORS, PM_IMAGE_ALIGN_VALUES, PM_ORDERED_LIST_STYLES, PM_TEXT_ALIGN_VALUES, PM_TEXT_COLORS } from "../spec";
import { isAllowedImageSrc } from "../validators";

const linkHrefSchema = z
  .string()
  .refine((href) => /^https?:\/\//.test(href) || href.startsWith("/") || href.startsWith("#"), {
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

export const aiRunSchema = z.object({
  text: z.string(),
  marks: z.array(aiRunMarkSchema).optional(),
});

export type AiRunMark = z.infer<typeof aiRunMarkSchema>;
export type AiRun = z.infer<typeof aiRunSchema>;
export type AiTextAlign = z.infer<typeof aiTextAlignSchema>;

export const aiTableCellSchema = z.object({
  runs: z.array(aiRunSchema),
  header: z.boolean().optional(),
  // 单元格背景色(主题色名,如 "rose")。修 cell-bg-color-lost-after-ai-followup:
  // AI 编辑走 AI-IR 往返时此前不带 cell 背景色→AI 改表后丢色。
  backgroundColor: z.string().optional(),
});

export const aiTableRowSchema = z.object({
  cells: z.array(aiTableCellSchema).min(1),
  header: z.boolean().optional(),
});

export type AiTableCell = z.infer<typeof aiTableCellSchema>;
export type AiTableRow = z.infer<typeof aiTableRowSchema>;

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

export type AiBlock =
  | { type: "paragraph"; runs: AiRun[]; textAlign?: AiTextAlign }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; anchor?: string | null; runs: AiRun[]; textAlign?: AiTextAlign }
  | { type: "blockquote"; runs: AiRun[] }
  | { type: "codeBlock"; language?: string | null; text: string }
  | { type: "bulletList"; items: AiListItem[] }
  | { type: "orderedList"; items: AiListItem[]; listStyle?: (typeof PM_ORDERED_LIST_STYLES)[number] | null }
  | { type: "horizontalRule" }
  | { type: "table"; rows: AiTableRow[] }
  | {
      type: "image";
      src: string;
      alt?: string | null;
      caption?: string | null;
      width?: number | null;
      height?: number | null;
      align?: (typeof PM_IMAGE_ALIGN_VALUES)[number] | null;
    }
  | { type: "fileAttachment"; fileId: string; filename: string; mimeType: string; size: number }
  | { type: "penNote"; runs: AiRun[] }
  | { type: "taskList"; items: AiTaskListItem[] }
  | {
      type: "callout";
      emoji?: string | null;
      tone?: (typeof PM_CALLOUT_TONES)[number] | null;
      runs: AiRun[];
    }
  | { type: "columnList"; columns: AiColumn[] }
  | { type: "blockMath"; latex: string }
  | { type: "diagram"; lang: string; source: string; svg?: string | null };

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

export const aiBlockSchema: z.ZodType<AiBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("paragraph"), runs: z.array(aiRunSchema), textAlign: aiTextAlignSchema.optional() }),
    z.object({ type: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]), anchor: z.string().nullable().optional(), runs: z.array(aiRunSchema), textAlign: aiTextAlignSchema.optional() }),
    z.object({ type: z.literal("blockquote"), runs: z.array(aiRunSchema) }),
    z.object({ type: z.literal("codeBlock"), language: z.string().nullable().optional(), text: z.string() }),
    z.object({ type: z.literal("bulletList"), items: z.array(aiListItemSchema).min(1) }),
    z.object({
      type: z.literal("orderedList"),
      items: z.array(aiListItemSchema).min(1),
      listStyle: aiOrderedListStyleSchema.nullable().optional(),
    }),
    z.object({ type: z.literal("horizontalRule") }),
    z.object({ type: z.literal("table"), rows: z.array(aiTableRowSchema).min(1) }),
    z.object({
      type: z.literal("image"),
      src: z.string().refine(isAllowedImageSrc, { message: "image src is not allowed" }),
      alt: z.string().nullable().optional(),
      caption: z.string().nullable().optional(),
      width: z.number().int().positive().nullable().optional(),
      height: z.number().int().positive().nullable().optional(),
      align: aiImageAlignSchema.nullable().optional(),
    }),
    z.object({ type: z.literal("fileAttachment"), fileId: z.string().min(1), filename: z.string().min(1), mimeType: z.string().min(1), size: z.number().int().nonnegative() }),
    z.object({ type: z.literal("penNote"), runs: z.array(aiRunSchema) }),
    z.object({
      type: z.literal("taskList"),
      items: z.array(aiTaskListItemSchema).min(1),
    }),
    z.object({
      type: z.literal("callout"),
      emoji: z.string().max(16).nullable().optional(),
      tone: z.enum(PM_CALLOUT_TONES).nullable().optional(),
      runs: z.array(aiRunSchema),
    }),
    z.object({ type: z.literal("columnList"), columns: z.array(aiColumnSchema).min(2) }),
    z.object({ type: z.literal("blockMath"), latex: z.string().min(1) }),
    // 图表块:lang(目前 mermaid)+ source 源码;svg 客户端渲染缓存,agent 生成时可缺省/null。
    z.object({
      type: z.literal("diagram"),
      lang: z.string().min(1),
      source: z.string().min(1),
      svg: z.string().nullable().optional(),
    }),
  ]) as unknown as z.ZodType<AiBlock>,
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
