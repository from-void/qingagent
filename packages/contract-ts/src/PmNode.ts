import type { PmMark, PmThemeColor } from "./PmMark";

export type PmTextAlign = "left" | "center" | "right" | "justify";

export type PmTextNode = {
  type: "text";
  text: string;
  marks?: Array<PmMark>;
};

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
  content?: Array<PmInlineNode>;
};

export type PmHeadingNode = {
  type: "heading";
  attrs: PmBlockAttrs & {
    level: 1 | 2 | 3 | 4 | 5 | 6;
    anchor?: string | null;
  };
  content?: Array<PmInlineNode>;
};

export type PmCodeBlockNode = {
  type: "codeBlock";
  attrs: PmBlockAttrs & { language?: string | null };
  content?: Array<PmTextNode>;
};

export type PmBlockquoteNode = {
  type: "blockquote";
  attrs: PmBlockAttrs;
  content: Array<PmBlockNode>;
};

export type PmListItemNode = {
  type: "listItem";
  attrs: PmBlockAttrs;
  content: Array<PmBlockNode>;
};

export type PmBulletListNode = {
  type: "bulletList";
  attrs: PmBlockAttrs;
  content: Array<PmListItemNode>;
};

export type PmOrderedListNode = {
  type: "orderedList";
  attrs: PmBlockAttrs & { start?: number | null };
  content: Array<PmListItemNode>;
};

export type PmHorizontalRuleNode = {
  type: "horizontalRule";
  attrs: PmBlockAttrs;
};

export type PmImageNode = {
  type: "image";
  attrs: PmBlockAttrs & {
    src: string;
    alt?: string | null;
    title?: string | null;
	    caption?: string | null;
	    width?: number | null;
	    height?: number | null;
	    align?: "left" | "center" | "right" | null;
	  };
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

export type PmDiagramNode = {
  type: "diagram";
  attrs: PmBlockAttrs & {
    lang: string;
    source: string;
    svg: string | null;
    /** 用户拖拽改的高度(px);仅编辑器持久化,agent/legacy 不设。 */
    height?: number | null;
    /** 用户域:节点/边位置与样式 overlay;AI 只读写 source,不消费该字段。 */
    overlay?: PmDiagramOverlay | null;
  };
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
  content?: Array<PmInlineNode>;
};

export type PmTaskItemNode = {
  type: "taskItem";
  attrs: PmBlockAttrs & { checked: boolean };
  content: Array<PmBlockNode>;
};

export type PmTaskListNode = {
  type: "taskList";
  attrs: PmBlockAttrs;
  content: Array<PmTaskItemNode>;
};

// 与 pm-schema spec.ts PM_CALLOUT_TONES / pm-schema types.ts PmCalloutTone 同步(手维护契约)。
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
  content: Array<PmParagraphNode>;
};

export type PmBlockMathNode = {
  type: "blockMath";
  attrs: PmBlockAttrs & { latex: string };
};

// 内容分栏(与 pm-schema types.ts 同步,手维护契约)。
export type PmColumnNode = {
  type: "column";
  attrs: PmBlockAttrs & { widthRatio?: number | null };
  content: Array<PmBlockNode>;
};

export type PmColumnListNode = {
  type: "columnList";
  attrs: PmBlockAttrs;
  content: Array<PmColumnNode>;
};

export type PmTableCellAttrs = {
  colspan?: number | null;
  rowspan?: number | null;
  colwidth?: Array<number> | null;
  backgroundColor?: PmThemeColor | null;
};

export type PmTableCellNode = {
  type: "tableCell" | "tableHeader";
  attrs?: PmTableCellAttrs;
  content: Array<PmBlockNode>;
};

export type PmTableRowNode = {
  type: "tableRow";
  content: Array<PmTableCellNode>;
};

export type PmTableNode = {
  type: "table";
  attrs: PmBlockAttrs;
  content: Array<PmTableRowNode>;
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

export type PmNode =
  | PmBlockNode
  | PmListItemNode
  | PmTaskItemNode
  | PmColumnListNode
  | PmColumnNode
  | PmTextNode
  | PmInlineNode
  | PmTableRowNode
  | PmTableCellNode;
