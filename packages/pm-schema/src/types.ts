import type { PmSchemaVersion } from "./schemaVersion";

export type PmMarkName =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | "link"
  | "textColor"
  | "highlight";

export type PmNodeName =
  | "doc"
  | "text"
  | "hardBreak"
  | "paragraph"
  | "heading"
  | "blockquote"
  | "bulletList"
  | "orderedList"
  | "listItem"
  | "horizontalRule"
  | "codeBlock"
  | "table"
  | "tableRow"
  | "tableCell"
  | "tableHeader"
  | "image"
  | "diagram"
  | "fileAttachment"
  | "penNote"
  | "taskList"
  | "taskItem"
  | "callout"
  | "columnList"
  | "column"
  | "blockMath"
  | "inlineMath";

export type PmTextAlign = "left" | "center" | "right" | "justify";
export type PmOrderedListStyle =
  | "decimal"
  | "lower-alpha"
  | "upper-alpha"
  | "lower-roman"
  | "upper-roman";

export type PmLinkAttrs = {
  href: string;
  title?: string | null;
};

export type PmThemeColor =
  | "ink"
  | "gray"
  | "slate"
  | "brown"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "sage"
  | "mint"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "magenta"
  | "pink"
  | "rose"
  | "sand"
  | "lavender";

export type PmHighlightAttrs = {
  color: PmThemeColor;
};

export type PmTextColorAttrs = {
  color: PmThemeColor;
};

export type PmMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strike" }
  | { type: "code" }
  | { type: "link"; attrs: PmLinkAttrs }
  | { type: "textColor"; attrs: PmTextColorAttrs }
  | { type: "highlight"; attrs: PmHighlightAttrs };

export type PmTextNode = {
  type: "text";
  text: string;
  marks?: PmMark[];
};

/** 行内公式:原子行内节点,latex 为源码;在纯文本/偏移计算中按 1 个字符(U+FFFC)处理。 */
export type PmInlineMathNode = {
  type: "inlineMath";
  attrs: { latex: string };
};

export type PmInlineNode = PmTextNode | { type: "hardBreak" } | PmInlineMathNode;

export type PmBlockAttrs = {
  blockId: string;
  textAlign?: PmTextAlign | null;
};

export type PmParagraphNode = {
  type: "paragraph";
  attrs: PmBlockAttrs;
  content?: PmInlineNode[];
};

export type PmHeadingNode = {
  type: "heading";
  attrs: PmBlockAttrs & { level: 1 | 2 | 3 | 4 | 5 | 6; anchor?: string | null };
  content?: PmInlineNode[];
};

export type PmCodeBlockNode = {
  type: "codeBlock";
  attrs: PmBlockAttrs & { language?: string | null };
  content?: PmTextNode[];
};

export type PmBlockquoteNode = {
  type: "blockquote";
  attrs: PmBlockAttrs;
  content: PmBlockNode[];
};

export type PmListItemNode = {
  type: "listItem";
  attrs: PmBlockAttrs;
  content: PmBlockNode[];
};

export type PmBulletListNode = {
  type: "bulletList";
  attrs: PmBlockAttrs;
  content: PmListItemNode[];
};

export type PmOrderedListNode = {
  type: "orderedList";
  attrs: PmBlockAttrs & { start?: number | null; listStyle?: PmOrderedListStyle | null };
  content: PmListItemNode[];
};

export type PmHorizontalRuleNode = {
  type: "horizontalRule";
  attrs: PmBlockAttrs;
};

export type PmImageAttrs = PmBlockAttrs & {
  src: string;
  alt?: string | null;
  title?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  align?: "left" | "center" | "right" | null;
};

export type PmImageNode = {
  type: "image";
  attrs: PmImageAttrs;
};

export type PmDiagramOverlayPosition = { x: number; y: number };
export type PmDiagramNodeStyleOverride = {
  fill?: string | null;
  stroke?: string | null;
  textColor?: string | null;
  strokeWidth?: number | null;
  fontSize?: number | null;
};
export type PmDiagramEdgeStyleOverride = {
  stroke?: string | null;
  textColor?: string | null;
  strokeWidth?: number | null;
};
export type PmDiagramEdgeHandleOverride = {
  sourceHandle?: string | null;
  targetHandle?: string | null;
};
export type PmDiagramOverlay = {
  positions?: Record<string, PmDiagramOverlayPosition> | null;
  styles?: Record<string, PmDiagramNodeStyleOverride> | null;
  edgeStyles?: Record<string, PmDiagramEdgeStyleOverride> | null;
  edgeHandles?: Record<string, PmDiagramEdgeHandleOverride> | null;
};

/** 图表块(确定性图):lang 目前仅 "mermaid";source 是图表源码;svg 是客户端渲染缓存(导出用),
 *  agent 生成时为 null,编辑器渲染后回填。 */
export type PmDiagramAttrs = PmBlockAttrs & {
  lang: string;
  source: string;
  svg: string | null;
  /** 用户拖拽改的高度(px);仅编辑器持久化,agent/legacy 不设。 */
  height?: number | null;
  /** 用户域 overlay:持久化进文档 hash,但不进入 AI-IR/proposalDiff。 */
  overlay?: PmDiagramOverlay | null;
};

export type PmDiagramNode = {
  type: "diagram";
  attrs: PmDiagramAttrs;
};

export type PmFileAttachmentAttrs = PmBlockAttrs & {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type PmFileAttachmentNode = {
  type: "fileAttachment";
  attrs: PmFileAttachmentAttrs;
};

export type PmPenNoteNode = {
  type: "penNote";
  attrs: PmBlockAttrs;
  content?: PmInlineNode[];
};

export type PmTaskItemNode = {
  type: "taskItem";
  attrs: PmBlockAttrs & { checked: boolean };
  content: PmBlockNode[];
};

export type PmTaskListNode = {
  type: "taskList";
  attrs: PmBlockAttrs;
  content: PmTaskItemNode[];
};

// 与 spec.ts PM_CALLOUT_TONES 保持同步(此处为字面量联合,避免 types↔spec 循环 import)。
export type PmCalloutTone =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral"
  | "ochre"
  | "rose"
  | "mauve"
  | "indigo"
  | "teal";

export type PmCalloutNode = {
  type: "callout";
  attrs: PmBlockAttrs & { emoji?: string | null; tone?: PmCalloutTone | null };
  content: PmParagraphNode[];
};

export type PmBlockMathNode = {
  type: "blockMath";
  attrs: PmBlockAttrs & { latex: string };
};

export type PmColumnNode = {
  type: "column";
  attrs: PmBlockAttrs & { widthRatio?: number | null };
  content: PmBlockNode[];
};

export type PmColumnListNode = {
  type: "columnList";
  attrs: PmBlockAttrs;
  content: PmColumnNode[];
};

export type PmTableCellAttrs = {
  colspan?: number | null;
  rowspan?: number | null;
  colwidth?: number[] | null;
  backgroundColor?: PmThemeColor | null;
};

export type PmTableCellNode = {
  type: "tableCell" | "tableHeader";
  attrs?: PmTableCellAttrs;
  content: PmBlockNode[];
};

export type PmTableRowNode = {
  type: "tableRow";
  content: PmTableCellNode[];
};

export type PmTableNode = {
  type: "table";
  attrs: PmBlockAttrs;
  content: PmTableRowNode[];
};

export type PmBlockNode =
  | PmParagraphNode
  | PmHeadingNode
  | PmCodeBlockNode
  | PmBlockquoteNode
  | PmBulletListNode
  | PmOrderedListNode
  | PmHorizontalRuleNode
  | PmImageNode
  | PmDiagramNode
  | PmFileAttachmentNode
  | PmPenNoteNode
  | PmTaskListNode
  | PmCalloutNode
  | PmColumnListNode
  | PmBlockMathNode
  | PmTableNode;

export type PmNode = PmBlockNode | PmListItemNode | PmTaskItemNode | PmColumnListNode | PmColumnNode | PmTextNode | PmInlineNode | PmTableRowNode | PmTableCellNode;

export type PmDoc = {
  type: "doc";
  attrs: {
    schemaVersion: PmSchemaVersion;
  };
  content: PmBlockNode[];
};

export type PmStep = {
  stepType: string;
  from?: number;
  to?: number;
  slice?: unknown;
  structure?: boolean;
  /** document_ops 审阅提交的幂等恢复元数据；ProseMirror 应用器会忽略未知字段。 */
  suggestionId?: string;
};

export type PmPatchConflict = {
  kind: "anchor_not_found" | "schema_invalid" | "version_conflict";
  message: string;
  blockId?: string;
};
