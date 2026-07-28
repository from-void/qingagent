/**
 * Wire 类型手维护于 `@qingagent/contract-ts`。
 *
 * 本模块只提供 view 层 facade：re-export 契约类型，并补充渲染辅助类型
 * （带 patch overlay 的 DocSpan / LegacySection、DOC_EDITABLE 策略，以及
 * 包含本地 UI action 的 WorkspaceFrame envelope）。
 */

export type {
  AgentMessage,
  ActionCardData,
  AskUserAnswer,
  AskUserAnswerCardPart,
  AskUserMode,
  AskUserOption,
  AskUserQuestion,
  AskUserQuestionKind,
  AskUserSpec,
  ChatChip,
  ChatChipKind,
  ChatMessage,
  ChatRole,
  Citation,
  CodePatch,
  Command,
  DocDiffReady,
  DocGenerationEvent,
  DocState,
  WireActiveOverlay,
  DocSuggestion,
  ContentDocState,
  DiffHunk,
  IncomingDocState,
  DocumentSnapshot,
  EndReason,
  FolderSource,
  Hunk,
  HunkOp,
  LineRange,
  MessagePart,
  DocSuggestionBody,
  Resource,
  ResourceDomain,
  ResourceRef,
  SkillRef,
  StreamFrame,
  SubAgent,
  SubAgentStatus,
  ThinkingPart,
  ToolCallBody,
  ToolCallResult,
  ToolCallSpec,
  ToolCallStatus,
  ToolRenderTarget,
  BridgeFrame,
} from "@qingagent/contract-ts";

import type {
  AskUserAnswer,
  AnnotationGroup,
  ChatMessage as WireChatMessage,
  DiffHunk,
  DocState,
  DocSuggestion as WireDocSuggestion,
  DocumentSnapshot as WireDocumentSnapshot,
  PmNode as WirePmNode,
  BridgeFrame,
  ToolCallSpec,
  WireActiveOverlay,
} from "@qingagent/contract-ts";
import type { PmBlockNode, PmDiagramLang, PmDiagramOverlay, PmDoc, PmInlineNode, PmMark, PmOrderedListStyle, PmTableCellNode } from "@qingagent/pm-schema";

/** 从 `AskUserQuestion.id` 到用户答案的映射，仅供 workspace view 层使用。 */
export type AskUserAnswers = Record<string, AskUserAnswer>;

export type EditorState = "empty" | "editable" | "locked" | "pendingReview";

/**
 * Whether the right-pane doc body is interactive in this DocState.
 * Pure UI policy — wire ships the state, view decides how to gate
 * editing.
 */
export const DOC_EDITABLE: Record<EditorState, boolean> = {
  empty: false,
  editable: true,
  locked: false,
  pendingReview: false,
};

/* ───────────── View-only doc rendering types ─────────────
 *
 * Wire `LegacySection` / `DocumentSnapshot` carry plain text. The view extends
 * `P` sections with a span array so patch overlays from open
 * `docSuggestion` tool-calls can render inline.
 */

export const INLINE_ATOM_PLACEHOLDER = "￼";

export type ViewTextSpan = { kind: "text"; text: string; marks?: PmMark[] };
export type ViewMathSpan = { kind: "math"; latex: string };

export type ViewPatchTextSpan =
  | { kind: "patchDel"; text: string; patchId: string; marks?: PmMark[] }
  | { kind: "patchIns"; text: string; patchId: string; marks?: PmMark[] };

export type ViewPatchMathSpan =
  | { kind: "patchDelMath"; latex: string; patchId: string }
  | { kind: "patchInsMath"; latex: string; patchId: string };

export type ViewDocSpan =
  | ViewTextSpan
  | ViewMathSpan
  | ViewPatchTextSpan
  | ViewPatchMathSpan
  | {
      kind: "patchMark";
      text: string;
      patchId: string;
      op: "markAdd" | "markRemove";
      marks: PmMark[];
      label: string;
    }
  | { kind: "selectable"; text: string };

type ViewListRowChildren = { childLists?: ViewNestedListDiff[] };

export type ViewListRowDiff =
  | ({ status: "same"; spans: ViewDocSpan[]; checked?: boolean } & ViewListRowChildren)
  | {
      status: "changed";
      spans: ViewDocSpan[];
      oldText: string;
      checked?: boolean;
      checkedChanged?: boolean;
      childLists?: ViewNestedListDiff[];
    }
  | ({ status: "added"; spans: ViewDocSpan[]; checked?: boolean } & ViewListRowChildren)
  | ({ status: "removed"; oldText: string; checked?: boolean } & ViewListRowChildren);

export type ViewNestedListDiff = {
  beforeListIndex?: number;
  afterListIndex?: number;
  rowDiff: ViewListRowDiff[];
};

export type ViewTableCellDiff =
  | { status: "same"; spans: ViewDocSpan[] }
  | { status: "changed"; spans: ViewDocSpan[]; oldText: string };

export type ViewTableRowDiff = {
  status: "same" | "added" | "removed" | "changed";
  cells: ViewTableCellDiff[];
};

export type ViewBlockSeqDiff = Array<
  | { status: "same"; block: PmBlockNode }
  | { status: "added"; block: PmBlockNode }
  | { status: "removed"; oldText: string }
  | { status: "changed"; kind: "text"; node: PmBlockNode; spans: ViewDocSpan[]; oldText: string }
  | { status: "changed"; kind: "list"; node: PmBlockNode; rowDiff: ViewListRowDiff[] }
  | { status: "changed"; kind: "table"; node: PmBlockNode; cellDiff: ViewTableRowDiff[] }
  | { status: "changed"; kind: "block"; node: PmBlockNode }
>;

export type ViewColumnDiff = {
  status: "same" | "added" | "removed" | "changed";
  beforeColumnIndex?: number;
  afterColumnIndex?: number;
  bodyDiff: ViewBlockSeqDiff;
};

export interface ViewBlockPatch {
  patchId: string;
  op: "insert" | "delete" | "replace";
  marker?: ViewPatchTextSpan;
  beforeBlock?: ViewBlock;
}

type ViewBlockMeta = {
  blockId?: string;
  blockPatch?: ViewBlockPatch;
};

export type ViewBlock = ViewBlockMeta & (
  | { kind: "h1"; text: string; spans?: ViewDocSpan[]; textAlign?: string }
  | { kind: "h2"; text: string; anchor?: string; spans?: ViewDocSpan[]; textAlign?: string }
  | { kind: "h3" | "h4" | "h5" | "h6"; text: string; spans?: ViewDocSpan[]; textAlign?: string }
  | { kind: "p"; spans: ViewDocSpan[]; textAlign?: string }
  | { kind: "quote"; text: string; spans?: ViewDocSpan[]; node?: PmBlockNode }
  | { kind: "list"; ordered: boolean; items: string[]; itemSpans?: ViewDocSpan[][]; start?: number; listStyle?: PmOrderedListStyle; rowDiff?: ViewListRowDiff[]; node?: PmBlockNode }
  | { kind: "hr" }
  | {
      kind: "table";
      head: string[];
      rows: string[][];
      headSpans?: ViewDocSpan[][];
      rowSpans?: ViewDocSpan[][][];
      cellDiff?: ViewTableRowDiff[];
      // 原始 table PM node:审阅态替换直接用它走 PmBlockView(保全合并单元格/列宽/背景色/
      // 单元格富文本/多块单元格),而非经 head/rows 文本 legacy 回转拍平。
      node?: PmBlockNode;
    }
  | { kind: "code"; body: string; language?: string | null }
  | { kind: "diagram"; source: string; lang: PmDiagramLang; svg: string | null; overlay?: PmDiagramOverlay | null }
  | { kind: "penNote"; text: string; spans?: ViewDocSpan[] }
  | { kind: "image"; src: string; alt: string; caption: string | null; width: number | null; height: number | null; align?: "left" | "center" | "right" | null }
  | { kind: "fileAttachment"; fileId: string; filename: string; mimeType: string; size: number }
  // 审阅态保真块:携带原始 pm 节点,审核态直接用 PmBlockView 渲染(与最终态同一套渲染,
  // 保证"审核态展示=最终态展示")。这几类不接行内 patch(patchableSectionSpans 返回 null),
  // 只参与整块插入/删除(blockPatch)。`text` 仅作文本投影用(锚点回退/块级 patch 文本)。
  | { kind: "taskList"; node: PmBlockNode; text: string; rowDiff?: ViewListRowDiff[] }
  | { kind: "callout"; node: PmBlockNode; text: string; bodyDiff?: ViewBlockSeqDiff }
  | { kind: "columnList"; node: PmBlockNode; text: string; columnsDiff?: ViewColumnDiff[] }
  | { kind: "math"; node: PmBlockNode; latex: string }
);

export interface ViewDocumentSnapshot {
  version: number;
  ts: string;
  sections: ViewBlock[];
  pmDoc?: PmDoc;
}

/** Convert a wire DocumentSnapshot into the view shape (P sections wrapped in a single text span). */
export function wireDocToView(doc: WireDocumentSnapshot): ViewDocumentSnapshot {
  // doc(PmDoc)现在是 contract 必填字段且优先消费;运行时仍保留 fallback,
  // 兼容旧客户端缓存里只有 sections 的历史快照(@deprecated 过渡窗口)。
  if (doc.doc) {
    return pmDocToViewDocumentSnapshot(doc.doc, doc.version, doc.ts);
  }
  return {
    version: doc.version,
    ts: doc.ts,
    sections: (doc.sections ?? []).map((s): ViewBlock => {
      const meta = wireSectionViewMeta(s);
      switch (s.kind) {
        case "quote":
          return { ...meta, kind: "quote", text: s.data.text };
        case "list":
          return { ...meta, kind: "list", ordered: s.data.ordered, items: s.data.items };
        case "hr":
          return { ...meta, kind: "hr" };
        case "h1":
          return { ...meta, kind: "h1", text: s.data.text };
        case "h2":
          return {
            ...meta,
            kind: "h2",
            text: s.data.text,
            anchor: s.data.anchor ?? undefined,
          };
        case "p":
          return { ...meta, kind: "p", spans: [{ kind: "text", text: s.data.text }] };
        case "table":
          return { ...meta, kind: "table", head: s.data.head, rows: s.data.rows };
        case "code":
          return { ...meta, kind: "code", body: s.data.body, language: s.data.language ?? null };
        case "penNote":
          return { ...meta, kind: "penNote", text: s.data.text };
        case "image":
          return {
            ...meta,
            kind: "image",
            src: s.data.src,
            alt: s.data.alt,
	            caption: s.data.caption,
	            width: s.data.width,
	            height: s.data.height,
	            align: s.data.align ?? "center",
	          };
        case "diagram":
          // 保留 diagram 语义(不再降级成 code):编辑器经 viewSectionsToHtml 重建 diagram 节点
          // 原生渲染;只读聊天视图在渲染处自行降级为源码展示。
          return { ...meta, kind: "diagram", source: s.data.source, lang: s.data.lang, svg: s.data.svg ?? null };
      }
    }),
  };
}

function wireSectionViewMeta(section: NonNullable<WireDocumentSnapshot["sections"]>[number]): ViewBlockMeta {
  const raw = section as {
    id?: unknown;
    blockId?: unknown;
    data?: { id?: unknown; blockId?: unknown };
  };
  const blockId = [raw.blockId, raw.id, raw.data?.blockId, raw.data?.id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return blockId ? { blockId } : {};
}

export function pmDocToViewDocumentSnapshot(doc: PmDoc, version: number, ts = ""): ViewDocumentSnapshot {
  return {
    version,
    ts,
    pmDoc: doc,
    sections: doc.content.flatMap(pmBlockToViewSections),
  };
}

export function pmNodesToViewBlocks(nodes: readonly WirePmNode[]): ViewBlock[] {
  return nodes.flatMap((node) => (isTopLevelPmBlock(node) ? pmBlockToViewSections(node as PmBlockNode) : []));
}

function pmBlockToViewSections(node: PmBlockNode): ViewBlock[] {
  const meta = { blockId: node.attrs.blockId };
  switch (node.type) {
    case "columnList":
      // 审核态保真:携带原始 columnList 节点,用 PmBlockView 渲成并排分栏(不再拍平成纵向堆叠)。
      // 计数仍由 pmBlockToViewSections().length 派生(此处为 1),块级 patch 索引映射自洽。
      return [{ ...meta, kind: "columnList", node, text: pmBlockText(node) }];
    case "heading": {
      const spans = pmInlineSpans(node.content ?? []);
      const text = viewSpansText(spans);
      const textAlign = node.attrs.textAlign ?? undefined;
      if (node.attrs.level === 1) return [{ ...meta, kind: "h1", text, spans, textAlign }];
      if (node.attrs.level === 2) {
        return [{ ...meta, kind: "h2", text, anchor: node.attrs.anchor ?? undefined, spans, textAlign }];
      }
      return [{ ...meta, kind: `h${node.attrs.level}` as "h3" | "h4" | "h5" | "h6", text, spans, textAlign }];
    }
    case "paragraph":
      return [{ ...meta, kind: "p", spans: pmInlineSpans(node.content ?? []), textAlign: node.attrs.textAlign ?? undefined }];
    case "blockquote":
      return [{ ...meta, kind: "quote", text: node.content.map(pmBlockText).join("\n"), spans: pmBlocksInlineSpans(node.content), node }];
    case "bulletList":
    case "orderedList":
      return [{
        ...meta,
        kind: "list",
        ordered: node.type === "orderedList",
        ...(node.type === "orderedList" && typeof node.attrs.start === "number" ? { start: node.attrs.start } : {}),
        ...(node.type === "orderedList" && node.attrs.listStyle ? { listStyle: node.attrs.listStyle } : {}),
        items: node.content.map((item) => item.content.map(pmBlockText).join("\n")),
        // 富 spans:保留加粗/链接等行内样式,审阅渲染优先消费(items 仍供文本派生)
        itemSpans: node.content.map((item) => pmBlocksInlineSpans(item.content)),
        node,
      }];
    case "horizontalRule":
      return [{ ...meta, kind: "hr" }];
    case "codeBlock":
      return [{ ...meta, kind: "code", body: pmInlineText(node.content ?? []), language: node.attrs.language ?? null }];
    case "table": {
      const [firstRow, ...restRows] = node.content;
      const firstIsHeader = firstRow?.content.every((cell) => cell.type === "tableHeader") ?? false;
      const head = firstIsHeader && firstRow ? firstRow.content.map(pmCellText) : [];
      const rows = (firstIsHeader ? restRows : node.content).map((row) => row.content.map(pmCellText));
      const headSpans = firstIsHeader && firstRow
        ? firstRow.content.map((cell) => pmBlocksInlineSpans(cell.content))
        : [];
      const rowSpans = (firstIsHeader ? restRows : node.content).map((row) =>
        row.content.map((cell) => pmBlocksInlineSpans(cell.content)),
      );
      return [{
        ...meta,
        kind: "table",
        head,
        rows,
        headSpans,
        rowSpans,
        node,
      }];
    }
    case "image":
      return [{
        ...meta,
        kind: "image",
        src: node.attrs.src,
        alt: node.attrs.alt ?? "",
	        caption: node.attrs.caption ?? null,
	        width: node.attrs.width ?? null,
	        height: node.attrs.height ?? null,
	        align: node.attrs.align ?? "center",
	      }];
    case "fileAttachment":
      return [{
        ...meta,
        kind: "fileAttachment",
        fileId: node.attrs.fileId,
        filename: node.attrs.filename,
        mimeType: node.attrs.mimeType,
        size: node.attrs.size,
      }];
    case "penNote":
      return [{ ...meta, kind: "penNote", text: pmInlineText(node.content ?? []), spans: pmInlineSpans(node.content ?? []) }];
    // 审核态保真:taskList/callout/blockMath 携带原始 pm 节点,用 PmBlockView 渲染(真复选框 /
    // 提示框 / KaTeX),与最终态一致;不再降级成 [ ] 列表 / 引用 / latex 代码块。
    case "taskList":
      return [{ ...meta, kind: "taskList", node, text: pmBlockText(node) }];
    case "callout":
      return [{ ...meta, kind: "callout", node, text: node.content.map(pmBlockText).join("\n") }];
    case "blockMath":
      return [{ ...meta, kind: "math", node, latex: node.attrs.latex }];
    case "diagram":
      return [{ ...meta, kind: "diagram", source: node.attrs.source, lang: node.attrs.lang, svg: node.attrs.svg ?? null, overlay: node.attrs.overlay ?? null }];
  }
}

function isTopLevelPmBlock(node: WirePmNode): boolean {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
    case "bulletList":
    case "orderedList":
    case "horizontalRule":
    case "table":
    case "image":
    case "diagram":
    case "fileAttachment":
    case "penNote":
    case "taskList":
    case "callout":
    case "blockMath":
    case "columnList":
      return true;
    default:
      return false;
  }
}

/** 块数组(单元格/列表项内的段落)→带 marks 的行内 spans,多段以换行 span 衔接。
 *  审阅渲染消费,保住加粗/链接/行内代码等样式与正式态一致。 */
function pmBlocksInlineSpans(blocks: readonly PmBlockNode[]): ViewDocSpan[] {
  const spans: ViewDocSpan[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) spans.push({ kind: "text", text: "\n" });
    spans.push(...pmInlineSpansForBlock(block));
  });
  return spans;
}

function pmInlineSpansForBlock(block: PmBlockNode): ViewDocSpan[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "penNote":
      return pmInlineSpans(block.content ?? []);
    case "codeBlock":
      return block.content?.length ? [{ kind: "text", text: pmInlineText(block.content) }] : [];
    case "blockquote":
      return pmBlocksInlineSpans(block.content);
    default:
      return [];
  }
}

function pmInlineSpans(content: readonly PmInlineNode[]): ViewDocSpan[] {
  const spans: ViewDocSpan[] = [];
  for (const node of content) {
    if (node.type === "hardBreak") {
      spans.push({ kind: "text", text: "\n" });
      continue;
    }
    if (node.type === "inlineMath") {
      spans.push({ kind: "math", latex: node.attrs.latex });
      continue;
    }
    if (!node.text) continue;
    spans.push(
      node.marks && node.marks.length > 0
        ? { kind: "text", text: node.text, marks: node.marks }
        : { kind: "text", text: node.text },
    );
  }
  return spans;
}

function pmInlineNodesToViewSpans(nodes: DiffHunk["before"] | DiffHunk["after"]): ViewDocSpan[] | null {
  if (!Array.isArray(nodes)) return null;
  if (!nodes.every(isPmInlineNode)) return null;
  return pmInlineSpans(nodes);
}

function isPmInlineNode(node: unknown): node is PmInlineNode {
  if (node === null || typeof node !== "object") return false;
  const type = (node as { type?: unknown }).type;
  return type === "text" || type === "hardBreak" || type === "inlineMath";
}

function pmCellText(cell: PmTableCellNode): string {
  return cell.content.map(pmBlockText).join("\n");
}

function pmBlockText(node: PmBlockNode): string {
  switch (node.type) {
    case "heading":
    case "paragraph":
    case "penNote":
      return pmInlineText(node.content ?? []);
    case "codeBlock":
      return pmInlineText(node.content ?? []);
    case "blockquote":
      return node.content.map(pmBlockText).join("\n");
    case "bulletList":
    case "orderedList":
      return node.content.map((item) => item.content.map(pmBlockText).join("\n")).join("\n");
    case "table":
      return node.content.map((row) => row.content.map(pmCellText).join("\t")).join("\n");
    case "horizontalRule":
      return "";
    case "image":
      return node.attrs.caption ?? node.attrs.alt ?? "";
    case "fileAttachment":
      return node.attrs.filename;
    case "taskList":
      return node.content
        .map((item) => `${item.attrs.checked ? "[x]" : "[ ]"} ${item.content.map(pmBlockText).join("\n")}`)
        .join("\n");
    case "callout":
      return node.content.map(pmBlockText).join("\n");
    case "columnList":
      return node.content.map((column) => column.content.map(pmBlockText).join("\n")).join("\n");
    case "blockMath":
      return node.attrs.latex;
    case "diagram":
      return node.attrs.source;
  }
}

function pmInlineText(content: readonly (PmInlineNode | { type: "text"; text?: string; marks?: PmMark[] })[]): string {
  return content
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return (node as { attrs?: { latex?: string } }).attrs?.latex ?? "";
      return node.text ?? "";
    })
    .join("");
}

function pmBlockOffsetText(node: PmBlockNode): string {
  switch (node.type) {
    case "heading":
    case "paragraph":
    case "penNote":
      return pmInlineOffsetText(node.content ?? []);
    case "codeBlock":
      return pmInlineOffsetText(node.content ?? []);
    default:
      return pmBlockText(node);
  }
}

function pmInlineOffsetText(content: readonly (PmInlineNode | { type: "text"; text?: string; marks?: PmMark[] })[]): string {
  return content
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "inlineMath") return INLINE_ATOM_PLACEHOLDER;
      return node.text ?? "";
    })
    .join("");
}

function viewSectionText(section: ViewBlock): string {
  switch (section.kind) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return section.spans ? viewSpansText(section.spans) : section.text;
    case "quote":
      return section.spans ? viewSpansText(section.spans) : section.text;
    case "penNote":
      return section.spans ? viewSpansText(section.spans) : section.text;
    case "p":
      return viewSpansText(section.spans);
    case "list":
      return section.items.join("\n");
    case "hr":
      return "";
    case "table":
      return [
        section.head.join("\t"),
        ...section.rows.map((row) => row.join("\t")),
      ].join("\n");
    case "code":
      return section.body;
    case "diagram":
      return section.source;
    case "image":
      return section.caption ?? section.alt;
    case "fileAttachment":
      return section.filename;
    case "taskList":
    case "callout":
    case "columnList":
      return section.text;
    case "math":
      return section.latex;
  }
}

export function viewDocSpanText(span: ViewDocSpan): string {
  switch (span.kind) {
    case "math":
    case "patchDelMath":
    case "patchInsMath":
      return span.latex;
    case "text":
    case "patchDel":
    case "patchIns":
    case "patchMark":
    case "selectable":
      return span.text;
  }
}

export function viewDocSpanOffsetText(span: ViewDocSpan): string {
  switch (span.kind) {
    case "math":
    case "patchDelMath":
    case "patchInsMath":
      return INLINE_ATOM_PLACEHOLDER;
    case "text":
    case "patchDel":
    case "patchIns":
    case "patchMark":
    case "selectable":
      return span.text;
  }
}

function viewSpansText(spans: readonly ViewDocSpan[]): string {
  return spans.map(viewDocSpanText).join("");
}

function viewSpansOffsetText(spans: readonly ViewDocSpan[]): string {
  return spans.map(viewDocSpanOffsetText).join("");
}

function viewSectionOffsetText(section: ViewBlock): string {
  switch (section.kind) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return section.spans ? viewSpansOffsetText(section.spans) : section.text;
    case "quote":
      return section.spans ? viewSpansOffsetText(section.spans) : section.text;
    case "penNote":
      return section.spans ? viewSpansOffsetText(section.spans) : section.text;
    case "p":
      return viewSpansOffsetText(section.spans);
    default:
      return viewSectionText(section);
  }
}

function patchableSectionSpans(section: ViewBlock): ViewDocSpan[] | null {
  switch (section.kind) {
    case "p":
      return section.spans;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return section.spans ?? [{ kind: "text", text: section.text }];
    case "quote":
    case "penNote":
      return section.spans ?? [{ kind: "text", text: section.text }];
    default:
      return null;
  }
}

export function lcsDiff<T>(
  a: readonly T[],
  b: readonly T[],
  eq: (x: T, y: T) => boolean,
): Array<{ kind: "same" | "add" | "remove"; a?: T; b?: T }> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = eq(a[i]!, b[j]!)
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: Array<{ kind: "same" | "add" | "remove"; a?: T; b?: T }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (eq(a[i]!, b[j]!)) {
      out.push({ kind: "same", a: a[i]!, b: b[j]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "remove", a: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", b: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: "remove", a: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: "add", b: b[j]! });
    j += 1;
  }
  return out;
}

type ListPmBlock = Extract<PmBlockNode, { type: "bulletList" | "orderedList" | "taskList" }>;
type TablePmBlock = Extract<PmBlockNode, { type: "table" }>;
type CalloutPmBlock = Extract<PmBlockNode, { type: "callout" }>;
type ColumnListPmBlock = Extract<PmBlockNode, { type: "columnList" }>;
type ColumnPmBlock = ColumnListPmBlock["content"][number];
type TextDiffPmBlock = Extract<PmBlockNode, { type: "paragraph" | "heading" | "penNote" }>;

type ListRowData = {
  node: ListPmBlock["content"][number];
  text: string;
  spans: ViewDocSpan[];
  checked?: boolean;
  childLists: ListPmBlock[];
};

type TableCellData = {
  node: PmTableCellNode;
  text: string;
  spans: ViewDocSpan[];
};

type TableRowData = {
  text: string;
  cells: TableCellData[];
};

function isListPmBlock(node: unknown): node is ListPmBlock {
  if (node === null || typeof node !== "object") return false;
  const type = (node as { type?: unknown }).type;
  return type === "bulletList" || type === "orderedList" || type === "taskList";
}

function isTablePmBlock(node: unknown): node is TablePmBlock {
  return node !== null && typeof node === "object" && (node as { type?: unknown }).type === "table";
}

function isCalloutPmBlock(node: unknown): node is CalloutPmBlock {
  return node !== null && typeof node === "object" && (node as { type?: unknown }).type === "callout";
}

function isColumnListPmBlock(node: unknown): node is ColumnListPmBlock {
  return node !== null && typeof node === "object" && (node as { type?: unknown }).type === "columnList";
}

function isTextDiffPmBlock(node: PmBlockNode): node is TextDiffPmBlock {
  return node.type === "paragraph" || node.type === "heading" || node.type === "penNote";
}

function singleListPmBlock(nodes: DiffHunk["before"] | DiffHunk["after"]): ListPmBlock | null {
  if (!Array.isArray(nodes) || nodes.length !== 1) return null;
  const node = nodes[0];
  return isListPmBlock(node) ? node : null;
}

function singleTablePmBlock(nodes: DiffHunk["before"] | DiffHunk["after"]): TablePmBlock | null {
  if (!Array.isArray(nodes) || nodes.length !== 1) return null;
  const node = nodes[0];
  return isTablePmBlock(node) ? node : null;
}

function singleCalloutPmBlock(nodes: DiffHunk["before"] | DiffHunk["after"]): CalloutPmBlock | null {
  if (!Array.isArray(nodes) || nodes.length !== 1) return null;
  const node = nodes[0];
  return isCalloutPmBlock(node) ? node : null;
}

function singleColumnListPmBlock(nodes: DiffHunk["before"] | DiffHunk["after"]): ColumnListPmBlock | null {
  if (!Array.isArray(nodes) || nodes.length !== 1) return null;
  const node = nodes[0];
  return isColumnListPmBlock(node) ? node : null;
}

function listRowsFromPmBlock(node: ListPmBlock): ListRowData[] {
  if (node.type === "taskList") {
    return node.content.map((item) => {
      const spans = pmBlocksInlineSpans(item.content.filter((block) => !isListPmBlock(block)));
      return {
        node: item,
        text: viewSpansText(spans),
        spans,
        checked: item.attrs.checked,
        childLists: item.content.filter(isListPmBlock),
      };
    });
  }
  return node.content.map((item) => {
    const spans = pmBlocksInlineSpans(item.content.filter((block) => !isListPmBlock(block)));
    return {
      node: item,
      text: viewSpansText(spans),
      spans,
      childLists: item.content.filter(isListPmBlock),
    };
  });
}

function tableRowsFromPmBlock(node: TablePmBlock): TableRowData[] {
  return node.content.map((row) => {
    const cells = row.content.map((cell) => {
      const spans = pmBlocksInlineSpans(cell.content);
      return {
        node: cell,
        text: viewSpansText(spans),
        spans,
      };
    });
    return {
      text: cells.map((cell) => cell.text).join("\t"),
      cells,
    };
  });
}

/** blockId 只用于锚定和对齐，不是用户会接受的内容变化；其余持久字段全部参与审阅等价。 */
function samePersistentPmValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, (key, value) => key === "blockId" ? undefined : value)
    === JSON.stringify(b, (key, value) => key === "blockId" ? undefined : value);
}

function sameListRowValue(a: ListRowData, b: ListRowData): boolean {
  const directNode = (row: ListRowData) => ({
    ...row.node,
    content: row.node.content.filter((child) => !isListPmBlock(child)),
  });
  return samePersistentPmValue(directNode(a), directNode(b));
}

/**
 * granular 正文只直接表达文本/marks；同位置节点的类型或 attrs 变化需要回退完整块级替换。
 * 文本值与 marks 刻意不参与此判定，它们由 inlineSpanDiffSpans 保真展示。
 */
function pmStructureOrAttrsChanged(before: unknown, after: unknown): boolean {
  if (!before || typeof before !== "object" || !after || typeof after !== "object") {
    return before !== after;
  }
  const beforeNode = before as { type?: unknown; attrs?: unknown; content?: unknown[] };
  const afterNode = after as { type?: unknown; attrs?: unknown; content?: unknown[] };
  if (beforeNode.type !== afterNode.type) return true;
  if (!samePersistentPmValue(beforeNode.attrs ?? null, afterNode.attrs ?? null)) return true;
  const beforeContent = beforeNode.content ?? [];
  const afterContent = afterNode.content ?? [];
  if (beforeContent.length !== afterContent.length) return true;
  return beforeContent.some((child, index) =>
    pmStructureOrAttrsChanged(child, afterContent[index]),
  );
}

/** 只有物理行列与合并结构都稳定时，物理 cell 下标才可用于格级 diff。 */
function tableShapeIsStable(beforeNode: TablePmBlock, afterNode: TablePmBlock): boolean {
  if (beforeNode.content.length !== afterNode.content.length) return false;
  if (beforeNode.content.some((row, rowIndex) => row.content.length !== afterNode.content[rowIndex]?.content.length)) {
    return false;
  }
  return beforeNode.content.every((row, rowIndex) => row.content.every((cell, cellIndex) => {
    const afterCell = afterNode.content[rowIndex]!.content[cellIndex]!;
    return (cell.attrs?.colspan ?? 1) === (afterCell.attrs?.colspan ?? 1)
      && (cell.attrs?.rowspan ?? 1) === (afterCell.attrs?.rowspan ?? 1);
  }));
}

function cloneSpans(spans: readonly ViewDocSpan[]): ViewDocSpan[] {
  return spans.map((span) => ({ ...span }));
}

type InlineDiffUnit =
  | { kind: "text"; text: string; marks?: PmMark[] }
  | { kind: "math"; latex: string };

/**
 * 500 × 500 个行内单元的真实 LCS 基准约耗时 3ms、分配约 25 万个 DP 槽；
 * 再放大时二维 number[][] 的内存与主线程耗时同步平方增长。字符级 diff 因此以
 * 25 万槽为上限，超限由上层降级为完整块级 replace，保证同步工作与内存有界。
 */
export const INLINE_DIFF_MAX_MATRIX_CELLS = 250_000;
const INLINE_DIFF_BUDGET_EXCEEDED = Symbol("inline-diff-budget-exceeded");

function inlineDiffUnitCount(spans: readonly ViewDocSpan[]): number {
  let count = 0;
  for (const span of spans) {
    switch (span.kind) {
      case "text":
      case "patchIns":
      case "patchDel":
      case "patchMark":
      case "selectable":
        for (const _character of span.text) count += 1;
        break;
      case "math":
      case "patchInsMath":
      case "patchDelMath":
        count += 1;
        break;
    }
  }
  return count;
}

function spansToInlineDiffUnits(spans: readonly ViewDocSpan[]): InlineDiffUnit[] {
  const units: InlineDiffUnit[] = [];
  for (const span of spans) {
    switch (span.kind) {
      case "text":
      case "patchIns":
      case "patchDel":
      case "patchMark":
      case "selectable":
        for (const ch of Array.from(span.text)) {
          units.push(span.kind === "text" || span.kind === "patchIns" || span.kind === "patchDel"
            ? { kind: "text", text: ch, ...(span.marks ? { marks: span.marks } : {}) }
            : { kind: "text", text: ch });
        }
        break;
      case "math":
      case "patchInsMath":
      case "patchDelMath":
        units.push({ kind: "math", latex: span.latex });
        break;
    }
  }
  return units;
}

function sameInlineDiffUnit(a: InlineDiffUnit, b: InlineDiffUnit): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "math") return b.kind === "math" && a.latex === b.latex;
  return b.kind === "text" && a.text === b.text && sameMarks(a.marks, b.marks);
}

function sameMarks(a: readonly PmMark[] | undefined, b: readonly PmMark[] | undefined): boolean {
  if (!a?.length && !b?.length) return true;
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function pushTextSpan(spans: ViewDocSpan[], text: string, marks?: PmMark[]): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last?.kind === "text" && sameMarks(last.marks, marks)) {
    last.text += text;
    return;
  }
  spans.push(marks && marks.length > 0 ? { kind: "text", text, marks } : { kind: "text", text });
}

function pushPatchTextSpan(spans: ViewDocSpan[], kind: "patchIns" | "patchDel", text: string, patchId: string, marks?: PmMark[]): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last?.kind === kind && last.patchId === patchId && sameMarks(last.marks, marks)) {
    last.text += text;
    return;
  }
  spans.push(marks && marks.length > 0 ? { kind, text, patchId, marks } : { kind, text, patchId });
}

function pushInlineDiffUnit(spans: ViewDocSpan[], unit: InlineDiffUnit): void {
  if (unit.kind === "math") {
    spans.push({ kind: "math", latex: unit.latex });
    return;
  }
  pushTextSpan(spans, unit.text, unit.marks);
}

function pushPatchInlineDiffUnit(spans: ViewDocSpan[], unit: InlineDiffUnit, op: "insert" | "delete", patchId: string): void {
  if (unit.kind === "math") {
    spans.push({ kind: op === "insert" ? "patchInsMath" : "patchDelMath", latex: unit.latex, patchId });
    return;
  }
  pushPatchTextSpan(spans, op === "insert" ? "patchIns" : "patchDel", unit.text, patchId, unit.marks);
}

function patchSpans(spans: readonly ViewDocSpan[], op: "insert" | "delete", patchId: string): ViewDocSpan[] {
  const out: ViewDocSpan[] = [];
  for (const unit of spansToInlineDiffUnits(spans)) {
    pushPatchInlineDiffUnit(out, unit, op, patchId);
  }
  return out;
}

function inlineSpanDiffSpans(beforeSpans: readonly ViewDocSpan[], afterSpans: readonly ViewDocSpan[], patchId: string): ViewDocSpan[] {
  const beforeUnitCount = inlineDiffUnitCount(beforeSpans);
  const afterUnitCount = inlineDiffUnitCount(afterSpans);
  if (beforeUnitCount === 0 && afterUnitCount === 0) return [];
  if (
    beforeUnitCount > 0 &&
    afterUnitCount > Math.floor(
      INLINE_DIFF_MAX_MATRIX_CELLS / beforeUnitCount,
    )
  ) {
    throw INLINE_DIFF_BUDGET_EXCEEDED;
  }
  const beforeUnits = spansToInlineDiffUnits(beforeSpans);
  const afterUnits = spansToInlineDiffUnits(afterSpans);
  const raw = lcsDiff(beforeUnits, afterUnits, sameInlineDiffUnit);
  const out: ViewDocSpan[] = [];
  for (const op of raw) {
    if (op.kind === "same" && op.b) pushInlineDiffUnit(out, op.b);
    if (op.kind === "remove" && op.a) pushPatchInlineDiffUnit(out, op.a, "delete", patchId);
    if (op.kind === "add" && op.b) pushPatchInlineDiffUnit(out, op.b, "insert", patchId);
  }
  return out.length > 0 ? out : cloneSpans(afterSpans);
}

function patchInsSpansForRow(row: ListRowData, patchId: string): ViewDocSpan[] {
  return patchSpans(row.spans, "insert", patchId);
}

function buildNestedListDiff(
  beforeLists: readonly ListPmBlock[],
  afterLists: readonly ListPmBlock[],
  patchId: string,
): ViewNestedListDiff[] | undefined {
  if (beforeLists.length === 0 && afterLists.length === 0) return undefined;
  const before = beforeLists.map((node, index) => ({ node, index }));
  const after = afterLists.map((node, index) => ({ node, index }));
  const raw = lcsDiff(before, after, (left, right) => left.node.type === right.node.type);
  const out: ViewNestedListDiff[] = [];
  let i = 0;
  while (i < raw.length) {
    const current = raw[i]!;
    if (current.kind === "same") {
      const left = current.a!;
      const right = current.b!;
      out.push({
        beforeListIndex: left.index,
        afterListIndex: right.index,
        rowDiff: buildListRowDiff(
          listRowsFromPmBlock(left.node),
          listRowsFromPmBlock(right.node),
          patchId,
        ),
      });
      i += 1;
      continue;
    }

    const removed: Array<{ node: ListPmBlock; index: number }> = [];
    const added: Array<{ node: ListPmBlock; index: number }> = [];
    while (i < raw.length && raw[i]!.kind !== "same") {
      const op = raw[i]!;
      if (op.kind === "remove") removed.push(op.a!);
      if (op.kind === "add") added.push(op.b!);
      i += 1;
    }
    let removeIndex = 0;
    let addIndex = 0;
    while (removeIndex < removed.length || addIndex < added.length) {
      const left = removed[removeIndex];
      const right = added[addIndex];
      if (left && right) {
        out.push({
          beforeListIndex: left.index,
          afterListIndex: right.index,
          rowDiff: buildListRowDiff(listRowsFromPmBlock(left.node), listRowsFromPmBlock(right.node), patchId),
        });
        removeIndex += 1;
        addIndex += 1;
      } else if (left) {
        out.push({
          beforeListIndex: left.index,
          rowDiff: buildListRowDiff(listRowsFromPmBlock(left.node), [], patchId),
        });
        removeIndex += 1;
      } else if (right) {
        out.push({
          afterListIndex: right.index,
          rowDiff: buildListRowDiff([], listRowsFromPmBlock(right.node), patchId),
        });
        addIndex += 1;
      }
    }
  }
  return out;
}

function childListDiffForRows(
  before: ListRowData | undefined,
  after: ListRowData | undefined,
  patchId: string,
): ViewNestedListDiff[] | undefined {
  return buildNestedListDiff(before?.childLists ?? [], after?.childLists ?? [], patchId);
}

function changedListRow(before: ListRowData, after: ListRowData, patchId: string): ViewListRowDiff {
  const checkedChanged =
    typeof before.checked === "boolean" &&
    typeof after.checked === "boolean" &&
    before.checked !== after.checked;
  const spans = inlineSpanDiffSpans(before.spans, after.spans, patchId);
  const childLists = childListDiffForRows(before, after, patchId);
  return {
    status: "changed",
    spans,
    oldText: before.text,
    ...(typeof after.checked === "boolean" ? { checked: after.checked } : {}),
    ...(checkedChanged ? { checkedChanged } : {}),
    ...(childLists ? { childLists } : {}),
  };
}

function buildListRowDiff(beforeRows: readonly ListRowData[], afterRows: readonly ListRowData[], patchId: string): ViewListRowDiff[] {
  const raw = lcsDiff(beforeRows, afterRows, (before, after) => before.text === after.text);
  const out: ViewListRowDiff[] = [];
  let i = 0;
  while (i < raw.length) {
    const current = raw[i]!;
    if (current.kind === "same") {
      const before = current.a!;
      const after = current.b!;
      if (
        !sameListRowValue(before, after) ||
        (
          typeof before.checked === "boolean" &&
          typeof after.checked === "boolean" &&
          before.checked !== after.checked
        )
      ) {
        out.push(changedListRow(before, after, patchId));
      } else {
        const childLists = childListDiffForRows(before, after, patchId);
        out.push({
          status: "same",
          spans: cloneSpans(after.spans),
          ...(typeof after.checked === "boolean" ? { checked: after.checked } : {}),
          ...(childLists ? { childLists } : {}),
        });
      }
      i += 1;
      continue;
    }

    const removed: ListRowData[] = [];
    const added: ListRowData[] = [];
    while (i < raw.length && raw[i]!.kind !== "same") {
      const op = raw[i]!;
      if (op.kind === "remove") removed.push(op.a!);
      if (op.kind === "add") added.push(op.b!);
      i += 1;
    }

    let removeIndex = 0;
    let addIndex = 0;
    while (removeIndex < removed.length || addIndex < added.length) {
      const before = removed[removeIndex];
      const after = added[addIndex];
      // 同一 LCS gap 中按逻辑位置一一配对：这是 replace，不以文本相似度决定是否拆成删+增。
      if (before && after) {
        out.push(changedListRow(before, after, patchId));
        removeIndex += 1;
        addIndex += 1;
        continue;
      }
      if (before) {
        const childLists = childListDiffForRows(before, undefined, patchId);
        out.push({
          status: "removed",
          oldText: before.text,
          ...(typeof before.checked === "boolean" ? { checked: before.checked } : {}),
          ...(childLists ? { childLists } : {}),
        });
        removeIndex += 1;
        continue;
      }
      if (after) {
        const childLists = childListDiffForRows(undefined, after, patchId);
        out.push({
          status: "added",
          spans: patchInsSpansForRow(after, patchId),
          ...(typeof after.checked === "boolean" ? { checked: after.checked } : {}),
          ...(childLists ? { childLists } : {}),
        });
        addIndex += 1;
      }
    }
  }
  return out;
}

function hasVisibleListRowDiff(rows: readonly ViewListRowDiff[]): boolean {
  return rows.some((row) =>
    row.status !== "same" ||
    row.childLists?.some((child) => hasVisibleListRowDiff(child.rowDiff)) === true,
  );
}

function hasVisibleTableCellDiff(rows: readonly ViewTableRowDiff[]): boolean {
  return rows.some((row) =>
    row.status !== "same" || row.cells.some((cell) => cell.status !== "same"),
  );
}

function hasVisibleBlockSeqDiff(seqDiff: readonly ViewBlockSeqDiff[number][]): boolean {
  return seqDiff.some((entry) => {
    if (entry.status === "added" || entry.status === "removed") return true;
    if (entry.status !== "changed") return false;
    if (entry.kind === "block") return true;
    if (entry.kind === "list") return hasVisibleListRowDiff(entry.rowDiff);
    if (entry.kind === "table") return hasVisibleTableCellDiff(entry.cellDiff);
    return entry.spans.some((span) =>
      span.kind === "patchIns" ||
      span.kind === "patchDel" ||
      span.kind === "patchInsMath" ||
      span.kind === "patchDelMath",
    );
  });
}

function withListRowDiff(block: ViewBlock, rowDiff: ViewListRowDiff[], afterNode?: PmBlockNode): ViewBlock {
  // 携带原始 after PM node,行级渲染时逐个 list item 走 PmBlockView(保全嵌套子项/marks/公式),
  // 只在行外套增/改/删状态类;taskList ViewBlock 本就带 node,list 变体此处补上。
  if (block.kind === "list") return { ...block, rowDiff, ...(afterNode ? { node: afterNode } : {}) };
  if (block.kind === "taskList") return { ...block, rowDiff };
  return block;
}

function sameTableCell(cell: TableCellData): ViewTableCellDiff {
  return { status: "same", spans: cloneSpans(cell.spans) };
}

function changedTableCell(before: TableCellData | undefined, after: TableCellData | undefined, patchId: string): ViewTableCellDiff {
  const oldText = before?.text ?? "";
  return {
    status: "changed",
    oldText,
    spans: inlineSpanDiffSpans(before?.spans ?? [], after?.spans ?? [], patchId),
  };
}

function tableCellsForAddedOrRemoved(row: TableRowData): ViewTableCellDiff[] {
  return row.cells.map(sameTableCell);
}

function changedTableRow(before: TableRowData, after: TableRowData, patchId: string): ViewTableRowDiff {
  const maxCells = Math.max(before.cells.length, after.cells.length);
  const cells: ViewTableCellDiff[] = [];
  for (let i = 0; i < maxCells; i += 1) {
    const beforeCell = before.cells[i];
    const afterCell = after.cells[i];
    if (beforeCell && afterCell && samePersistentPmValue(beforeCell.node, afterCell.node)) {
      cells.push(sameTableCell(afterCell));
    } else {
      cells.push(changedTableCell(beforeCell, afterCell, patchId));
    }
  }
  return {
    status: cells.some((cell) => cell.status === "changed") ? "changed" : "same",
    cells,
  };
}

function buildTableCellDiff(
  beforeRows: readonly TableRowData[],
  afterRows: readonly TableRowData[],
  patchId: string,
): ViewTableRowDiff[] {
  const raw = lcsDiff(beforeRows, afterRows, (before, after) => before.text === after.text);
  const out: ViewTableRowDiff[] = [];
  let i = 0;
  while (i < raw.length) {
    const current = raw[i]!;
    if (current.kind === "same") {
      const row = changedTableRow(current.a!, current.b!, patchId);
      out.push(row.status === "same"
        ? { status: "same", cells: current.b!.cells.map(sameTableCell) }
        : row);
      i += 1;
      continue;
    }

    const removed: TableRowData[] = [];
    const added: TableRowData[] = [];
    while (i < raw.length && raw[i]!.kind !== "same") {
      const op = raw[i]!;
      if (op.kind === "remove") removed.push(op.a!);
      if (op.kind === "add") added.push(op.b!);
      i += 1;
    }

    let removeIndex = 0;
    let addIndex = 0;
    while (removeIndex < removed.length || addIndex < added.length) {
      const before = removed[removeIndex];
      const after = added[addIndex];
      // 稳定表形下，同一 gap 的同行 remove+add 必为 replace；纯删/纯增因另一侧为空不会误配。
      if (before && after) {
        out.push(changedTableRow(before, after, patchId));
        removeIndex += 1;
        addIndex += 1;
        continue;
      }
      if (before) {
        out.push({
          status: "removed",
          cells: tableCellsForAddedOrRemoved(before),
        });
        removeIndex += 1;
        continue;
      }
      if (after) {
        out.push({
          status: "added",
          cells: tableCellsForAddedOrRemoved(after),
        });
        addIndex += 1;
      }
    }
  }
  return out;
}

function withTableCellDiff(block: ViewBlock, cellDiff: ViewTableRowDiff[], afterNode?: PmBlockNode): ViewBlock {
  // 携带原始 after table node,审阅态替换直接走 PmBlockView 保全合并单元格/列宽/背景色/单元格富文本。
  if (block.kind === "table") return { ...block, cellDiff, ...(afterNode ? { node: afterNode } : {}) };
  return block;
}

function isInlineDiffBudgetExceeded(error: unknown): boolean {
  return error === INLINE_DIFF_BUDGET_EXCEEDED;
}

function buildListRowReplace(
  beforeNode: ListPmBlock,
  afterNode: ListPmBlock,
  input: Omit<BlockPatchInput, "op" | "blocks" | "blockCount" | "replaceBeforeBlocks">,
): BlockPatchInput | null {
  if (beforeNode.type !== afterNode.type) return null;
  const beforeBlocks = pmNodesToViewBlocks([beforeNode]);
  const afterBlocks = pmNodesToViewBlocks([afterNode]);
  const beforeBlock = beforeBlocks[0];
  const afterBlock = afterBlocks[0];
  if (!beforeBlock || !afterBlock) return null;
  let rowDiff: ViewListRowDiff[];
  try {
    rowDiff = buildListRowDiff(
      listRowsFromPmBlock(beforeNode),
      listRowsFromPmBlock(afterNode),
      input.patchId,
    );
  } catch (error) {
    if (!isInlineDiffBudgetExceeded(error)) throw error;
    return {
      ...input,
      op: "replace",
      blocks: [
        afterBlock.kind === "list"
          ? { ...afterBlock, node: afterNode }
          : afterBlock,
      ],
      replaceBeforeBlocks: [beforeBlock],
      blockCount: 1,
    };
  }
  // granular 只在任意深度的行级 diff 真的标出了可见变化，且变化可由文本/marks 保真表达时才置；
  // 节点类型或 attrs 变化回退完整块级替换，避免局部正文与实际提交结构不一致。
  const rowLevelVisible = hasVisibleListRowDiff(rowDiff);
  const needsBlockHover = pmStructureOrAttrsChanged(beforeNode, afterNode);
  return {
    ...input,
    op: "replace",
    blocks: [withListRowDiff(afterBlock, rowDiff, afterNode)],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
    ...(rowLevelVisible && !needsBlockHover ? { granular: true } : {}),
  };
}

function buildTableCellReplace(
  beforeNode: TablePmBlock,
  afterNode: TablePmBlock,
  input: Omit<BlockPatchInput, "op" | "blocks" | "blockCount" | "replaceBeforeBlocks">,
): BlockPatchInput | null {
  const beforeBlocks = pmNodesToViewBlocks([beforeNode]);
  const afterBlocks = pmNodesToViewBlocks([afterNode]);
  const beforeBlock = beforeBlocks[0];
  const afterBlock = afterBlocks[0];
  if (!beforeBlock || !afterBlock || afterBlock.kind !== "table") return null;
  if (!tableShapeIsStable(beforeNode, afterNode)) {
    return {
      ...input,
      op: "replace",
      // 整表降级仍携带原始 after node，保全新表的合并、列宽、背景与富文本。
      blocks: [{ ...afterBlock, node: afterNode }],
      replaceBeforeBlocks: [beforeBlock],
      blockCount: 1,
    };
  }
  let cellDiff: ViewTableRowDiff[];
  try {
    cellDiff = buildTableCellDiff(
      tableRowsFromPmBlock(beforeNode),
      tableRowsFromPmBlock(afterNode),
      input.patchId,
    );
  } catch (error) {
    if (!isInlineDiffBudgetExceeded(error)) throw error;
    return {
      ...input,
      op: "replace",
      blocks: [{ ...afterBlock, node: afterNode }],
      replaceBeforeBlocks: [beforeBlock],
      blockCount: 1,
    };
  }
  const cellLevelVisible = hasVisibleTableCellDiff(cellDiff);
  const needsBlockHover = pmStructureOrAttrsChanged(beforeNode, afterNode);
  return {
    ...input,
    op: "replace",
    blocks: [withTableCellDiff(afterBlock, cellDiff, afterNode)],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
    ...(cellLevelVisible && !needsBlockHover ? { granular: true } : {}),
  };
}

function changedContainerBlock(
  beforeNode: PmBlockNode,
  afterNode: PmBlockNode,
  patchId: string,
): ViewBlockSeqDiff[number] | null {
  if (
    isTextDiffPmBlock(beforeNode) &&
    isTextDiffPmBlock(afterNode) &&
    beforeNode.type === afterNode.type &&
    samePersistentPmValue(beforeNode.attrs, afterNode.attrs)
  ) {
    const oldText = pmBlockText(beforeNode);
    return {
      status: "changed",
      kind: "text",
      node: afterNode,
      oldText,
      spans: inlineSpanDiffSpans(pmInlineSpans(beforeNode.content ?? []), pmInlineSpans(afterNode.content ?? []), patchId),
    };
  }
  if (isListPmBlock(beforeNode) && isListPmBlock(afterNode) && beforeNode.type === afterNode.type) {
    return {
      status: "changed",
      kind: "list",
      node: afterNode,
      rowDiff: buildListRowDiff(
        listRowsFromPmBlock(beforeNode),
        listRowsFromPmBlock(afterNode),
        patchId,
      ),
    };
  }
  if (isTablePmBlock(beforeNode) && isTablePmBlock(afterNode)) {
    if (!tableShapeIsStable(beforeNode, afterNode)) {
      return {
        status: "changed",
        kind: "block",
        node: afterNode,
      };
    }
    return {
      status: "changed",
      kind: "table",
      node: afterNode,
      cellDiff: buildTableCellDiff(
        tableRowsFromPmBlock(beforeNode),
        tableRowsFromPmBlock(afterNode),
        patchId,
      ),
    };
  }
  // 类型变化或无法安全做局部 diff 时仍是同位置 replace：只显示新块，旧块由 hover 承载。
  return {
    status: "changed",
    kind: "block",
    node: afterNode,
  };
}

function buildBlockSeqDiff(
  beforeNodes: readonly PmBlockNode[],
  afterNodes: readonly PmBlockNode[],
  patchId: string,
): ViewBlockSeqDiff {
  const raw = lcsDiff(beforeNodes, afterNodes, (before, after) =>
    pmBlockText(before) === pmBlockText(after),
  );
  const out: ViewBlockSeqDiff = [];
  let i = 0;
  while (i < raw.length) {
    const current = raw[i]!;
    if (current.kind === "same") {
      if (samePersistentPmValue(current.a!, current.b!)) {
        out.push({ status: "same", block: current.b! });
      } else {
        out.push(changedContainerBlock(current.a!, current.b!, patchId) ?? {
          status: "changed",
          kind: "block",
          node: current.b!,
        });
      }
      i += 1;
      continue;
    }

    const removed: PmBlockNode[] = [];
    const added: PmBlockNode[] = [];
    while (i < raw.length && raw[i]!.kind !== "same") {
      const op = raw[i]!;
      if (op.kind === "remove") removed.push(op.a!);
      if (op.kind === "add") added.push(op.b!);
      i += 1;
    }

    let removeIndex = 0;
    let addIndex = 0;
    while (removeIndex < removed.length || addIndex < added.length) {
      const beforeNode = removed[removeIndex];
      const afterNode = added[addIndex];
      if (beforeNode && afterNode) {
        const changed = changedContainerBlock(beforeNode, afterNode, patchId);
        if (changed) {
          out.push(changed);
          removeIndex += 1;
          addIndex += 1;
          continue;
        }
      }
      if (beforeNode) {
        out.push({ status: "removed", oldText: pmBlockText(beforeNode) });
        removeIndex += 1;
        continue;
      }
      if (afterNode) {
        out.push({ status: "added", block: afterNode });
        addIndex += 1;
      }
    }
  }
  return out;
}

function withCalloutBodyDiff(block: ViewBlock, bodyDiff: ViewBlockSeqDiff): ViewBlock {
  if (block.kind === "callout") return { ...block, bodyDiff };
  return block;
}

function withColumnListColumnsDiff(block: ViewBlock, columnsDiff: ViewColumnDiff[]): ViewBlock {
  if (block.kind === "columnList") return { ...block, columnsDiff };
  return block;
}

function columnText(column: ColumnPmBlock): string {
  return column.content.map(pmBlockText).join("\n");
}

function sameColumnIdentity(beforeColumn: ColumnPmBlock, afterColumn: ColumnPmBlock): boolean {
  const beforeId = beforeColumn.attrs.blockId;
  const afterId = afterColumn.attrs.blockId;
  if (beforeId && afterId) return beforeId === afterId;
  return columnText(beforeColumn) === columnText(afterColumn);
}

function makeColumnDiff(
  status: ViewColumnDiff["status"],
  beforeColumn: ColumnPmBlock | undefined,
  afterColumn: ColumnPmBlock | undefined,
  beforeColumnIndex: number | undefined,
  afterColumnIndex: number | undefined,
  patchId: string,
): ViewColumnDiff {
  return {
    status,
    ...(beforeColumnIndex !== undefined ? { beforeColumnIndex } : {}),
    ...(afterColumnIndex !== undefined ? { afterColumnIndex } : {}),
    bodyDiff: buildBlockSeqDiff(beforeColumn?.content ?? [], afterColumn?.content ?? [], patchId),
  };
}

/** 栏级 LCS：稳定 blockId 优先；无稳定 id 时用同文锚定，再在相邻未匹配区按内容相似度配 changed。 */
function buildColumnsDiff(
  beforeColumns: readonly ColumnPmBlock[],
  afterColumns: readonly ColumnPmBlock[],
  patchId: string,
): ViewColumnDiff[] {
  const beforeIndex = new Map(beforeColumns.map((column, index) => [column, index]));
  const afterIndex = new Map(afterColumns.map((column, index) => [column, index]));
  const raw = lcsDiff(beforeColumns, afterColumns, sameColumnIdentity);
  const out: ViewColumnDiff[] = [];
  let i = 0;
  while (i < raw.length) {
    const current = raw[i]!;
    if (current.kind === "same") {
      const beforeColumn = current.a!;
      const afterColumn = current.b!;
      const bodyDiff = buildBlockSeqDiff(beforeColumn.content, afterColumn.content, patchId);
      out.push({
        status: hasVisibleBlockSeqDiff(bodyDiff) ? "changed" : "same",
        beforeColumnIndex: beforeIndex.get(beforeColumn)!,
        afterColumnIndex: afterIndex.get(afterColumn)!,
        bodyDiff,
      });
      i += 1;
      continue;
    }

    const removed: ColumnPmBlock[] = [];
    const added: ColumnPmBlock[] = [];
    while (i < raw.length && raw[i]!.kind !== "same") {
      const op = raw[i]!;
      if (op.kind === "remove") removed.push(op.a!);
      if (op.kind === "add") added.push(op.b!);
      i += 1;
    }
    let removeIndex = 0;
    let addIndex = 0;
    while (removeIndex < removed.length || addIndex < added.length) {
      const beforeColumn = removed[removeIndex];
      const afterColumn = added[addIndex];
      if (beforeColumn && afterColumn) {
        out.push(makeColumnDiff("changed", beforeColumn, afterColumn, beforeIndex.get(beforeColumn), afterIndex.get(afterColumn), patchId));
        removeIndex += 1;
        addIndex += 1;
      } else if (beforeColumn) {
        out.push(makeColumnDiff("removed", beforeColumn, undefined, beforeIndex.get(beforeColumn), undefined, patchId));
        removeIndex += 1;
      } else if (afterColumn) {
        out.push(makeColumnDiff("added", undefined, afterColumn, undefined, afterIndex.get(afterColumn), patchId));
        addIndex += 1;
      }
    }
  }
  return out;
}

function buildCalloutReplace(
  beforeNode: CalloutPmBlock,
  afterNode: CalloutPmBlock,
  input: Omit<BlockPatchInput, "op" | "blocks" | "blockCount" | "replaceBeforeBlocks">,
): BlockPatchInput | null {
  const beforeBlocks = pmNodesToViewBlocks([beforeNode]);
  const afterBlocks = pmNodesToViewBlocks([afterNode]);
  const beforeBlock = beforeBlocks[0];
  const afterBlock = afterBlocks[0];
  if (!beforeBlock || !afterBlock || afterBlock.kind !== "callout") return null;
  let bodyDiff: ViewBlockSeqDiff;
  try {
    bodyDiff = buildBlockSeqDiff(
      beforeNode.content,
      afterNode.content,
      input.patchId,
    );
  } catch (error) {
    if (!isInlineDiffBudgetExceeded(error)) throw error;
    return {
      ...input,
      op: "replace",
      blocks: [afterBlock],
      replaceBeforeBlocks: [beforeBlock],
      blockCount: 1,
    };
  }
  const bodyLevelVisible = hasVisibleBlockSeqDiff(bodyDiff);
  const needsBlockHover = pmStructureOrAttrsChanged(beforeNode, afterNode);
  return {
    ...input,
    op: "replace",
    blocks: [withCalloutBodyDiff(afterBlock, bodyDiff)],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
    ...(bodyLevelVisible && !needsBlockHover ? { granular: true } : {}),
  };
}

function buildColumnListReplace(
  beforeNode: ColumnListPmBlock,
  afterNode: ColumnListPmBlock,
  input: Omit<BlockPatchInput, "op" | "blocks" | "blockCount" | "replaceBeforeBlocks">,
): BlockPatchInput | null {
  const beforeBlocks = pmNodesToViewBlocks([beforeNode]);
  const afterBlocks = pmNodesToViewBlocks([afterNode]);
  const beforeBlock = beforeBlocks[0];
  const afterBlock = afterBlocks[0];
  if (!beforeBlock || !afterBlock || afterBlock.kind !== "columnList") return null;
  let columnsDiff: ViewColumnDiff[];
  try {
    columnsDiff = buildColumnsDiff(
      beforeNode.content,
      afterNode.content,
      input.patchId,
    );
  } catch (error) {
    if (!isInlineDiffBudgetExceeded(error)) throw error;
    return {
      ...input,
      op: "replace",
      blocks: [afterBlock],
      replaceBeforeBlocks: [beforeBlock],
      blockCount: 1,
    };
  }
  const columnLevelVisible = columnsDiff.some((columnDiff) =>
    columnDiff.status !== "same" || hasVisibleBlockSeqDiff(columnDiff.bodyDiff),
  );
  const needsBlockHover = pmStructureOrAttrsChanged(beforeNode, afterNode);
  return {
    ...input,
    op: "replace",
    blocks: [withColumnListColumnsDiff(afterBlock, columnsDiff)],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
    ...(columnLevelVisible && !needsBlockHover ? { granular: true } : {}),
  };
}

function pmNodeSize(node: PmBlockNode | PmInlineNode | PmDoc): number {
  if (node.type === "doc") {
    return node.content.reduce((sum, child) => sum + pmNodeSize(child), 0);
  }
  if (node.type === "text") return node.text.length;
  if (node.type === "hardBreak") return 1;
  if (!("content" in node) || !Array.isArray(node.content)) return 1;
  return 2 + node.content.reduce((sum, child) => sum + pmNodeSize(child as PmBlockNode | PmInlineNode), 0);
}

function isPatchRenderablePmBlock(
  node: PmBlockNode,
): node is PmBlockNode & { content?: PmInlineNode[] } {
  return (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "codeBlock" ||
    node.type === "penNote"
  );
}

function viewSectionCountForTopBlock(node: PmBlockNode): number {
  return pmBlockToViewSections(node).length;
}

function codeUnitOffsetToCharIndex(text: string, offset: number): number {
  return Array.from(text.slice(0, Math.max(0, Math.min(offset, text.length)))).length;
}

/** 两串"尾部"的最长公共长度(用于 prefix 上下文吻合度打分)。 */
function sharedTailLen(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** 两串"头部"的最长公共长度(用于 suffix 上下文吻合度打分)。 */
function sharedHeadLen(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[n] === b[n]) n++;
  return n;
}

/**
 * 文本回退:当 blockId/位置漂移时(常见于流式生成期 `ai-block-*` id 与持久化后
 * `block-*` id 不一致),用混合锚点的 quote + prefix/suffix 在视图段做文本匹配定位。
 * 这是锚点本就为之设计的鲁棒回退,避免一处 id 漂移就让 patch 静默消失。
 */
function findViewTargetByQuote(
  doc: ViewDocumentSnapshot,
  anchor: WireDocSuggestion["anchor"],
): { blockIndex: number; range: { start: number; end: number } } | null {
  const quote = anchor.quote;
  if (!quote) return null;
  const quoteCharLen = Array.from(quote).length;
  let best: { blockIndex: number; start: number; score: number } | null = null;
  const usesAtomOffset = quote.includes(INLINE_ATOM_PLACEHOLDER);
  for (let i = 0; i < doc.sections.length; i++) {
    const section = doc.sections[i];
    if (!section || !patchableSectionSpans(section)) continue;
    const text = usesAtomOffset ? viewSectionOffsetText(section) : viewSectionText(section);
    let from = 0;
    for (;;) {
      const idx = text.indexOf(quote, from);
      if (idx < 0) break;
      // prefix/suffix 消歧:同段多处出现时,取与锚点上下文吻合度最高的一处。
      let score = 0;
      if (anchor.prefix) score += sharedTailLen(text.slice(0, idx), anchor.prefix);
      if (anchor.suffix) score += sharedHeadLen(text.slice(idx + quote.length), anchor.suffix);
      if (!best || score > best.score) {
        best = { blockIndex: i, start: codeUnitOffsetToCharIndex(text, idx), score };
      }
      from = idx + 1;
    }
  }
  if (!best) return null;
  return { blockIndex: best.blockIndex, range: { start: best.start, end: best.start + quoteCharLen } };
}

function findSuggestionViewTarget(
  doc: ViewDocumentSnapshot,
  suggestion: WireDocSuggestion,
): { blockIndex: number; range: { start: number; end: number } } | null {
  // 主路径:blockId + PM 位置精确匹配(id 体系一致时最准)。
  if (doc.pmDoc) {
    let pmPos = 0;
    let viewSectionIndex = 0;
    for (const block of doc.pmDoc.content) {
      const blockStart = pmPos + 1;
      const blockEnd = blockStart + pmBlockOffsetText(block).length;
      if (
        block.attrs.blockId === suggestion.anchor.blockId &&
        isPatchRenderablePmBlock(block) &&
        suggestion.anchor.pmFrom >= blockStart &&
        suggestion.anchor.pmTo <= blockEnd
      ) {
        const viewSection = doc.sections[viewSectionIndex];
        if (viewSection && patchableSectionSpans(viewSection)) {
          const text = viewSectionOffsetText(viewSection);
          const start = codeUnitOffsetToCharIndex(text, suggestion.anchor.pmFrom - blockStart);
          const end = codeUnitOffsetToCharIndex(text, suggestion.anchor.pmTo - blockStart);
          return { blockIndex: viewSectionIndex, range: { start, end } };
        }
        break; // blockId 命中但视图段异常 → 落到文本回退
      }
      pmPos += pmNodeSize(block);
      viewSectionIndex += viewSectionCountForTopBlock(block);
    }
  }
  // 回退:id/位置漂移时用混合锚点 quote+prefix/suffix 文本匹配。
  return findViewTargetByQuote(doc, suggestion.anchor);
}

/**
 * Layer open / accepted / rejected PM suggestion overlays into a doc's
 * paragraph spans. Each `docSuggestion` tool-call is scoped to its
 * `blockIndex`, so repeated text in other sections cannot receive the
 * overlay by accident.
 */
export interface PatchOverlayInput {
  id: string;
  reviewBatchId?: string;
  groupMode?: "atomic" | "independent";
  order?: number;
  before: string;
  after: string;
  blockIndex: number;
  range?: { start: number; end: number };
  conflict?: boolean;
  kind?: "text" | "markAdd" | "markRemove";
  marks?: PmMark[];
  label?: string;
  matchBefore?: string;
  matchAfter?: string;
  beforeSpans?: ViewDocSpan[];
  afterSpans?: ViewDocSpan[];
}

export interface BlockPatchInput {
  patchId: string;
  reviewBatchId?: string;
  groupMode?: "atomic" | "independent";
  order?: number;
  op: "insert" | "delete" | "replace";
  anchorBlockId?: string;
  anchorIndex?: number;
  gravity?: "before" | "after";
  blocks: ViewBlock[];
  replaceBeforeBlocks?: ViewBlock[];
  blockCount?: number;
  /** 原始 PM node(insert/replace 的 hunk.after):审阅态块级新增/替换直接用它渲染,一律不经
   *  ViewBlock→legacy 降级,保全所有格式(对齐/marks/嵌套列表/合并单元格/代码高亮/inlineMath 等)。 */
  pmNodes?: readonly PmBlockNode[];
  /** 原始 PM node(replace/delete 的 hunk.before):hover 卡片"原文"直接用它渲染,同样不降级,
   *  保全表格合并单元格/嵌套列表子项/单元格富文本/图表 overlay 等(替代早前拍平的 before 文本)。 */
  beforePmNodes?: readonly PmBlockNode[];
  /** 该替换的正文已在块内部做**行级/单元格级 diff**(如列表/待办清单逐行标注)。为真时审阅装饰
   *  抑制块级冗余标记——不画整块红删标记、不画整块绿竖线(否则"既有行级又有块级"重复),
   *  仅保留隐藏原块 + 内部逐行 diff。 */
  granular?: boolean;
  /** granular 内容标注之外还存在容器/单元格属性变化，局部正文无法完整表达。改由整块原文 hover
   *  统一接管并关闭块内局部 popup，让旧 tone、背景色、栏宽等外壳属性仍可审阅；常规 granular 不设置。 */
  granularBlockHover?: boolean;
}

/** 行内文本通道能保真渲染的 PM 块类型(spans 模式);结构块都不在此列。 */
const INLINE_SAFE_PM_TYPES = new Set(["paragraph", "heading", "penNote"]);
/** 行内节点类型:replace 的 hunk.before/after 是「行内切片」(text/hardBreak/inlineMath),
 * 本就属行内、该走行内文本通道。此前漏列 → pmNodesInlineSafe 误判其为结构块 → 内联通道返 null、
 * 块通道(pmNodesToViewBlocks 过滤行内节点)又返 [] → 纯文本改动被双通道丢弃(表现为"无法定位")。
 * 实证:packages/core buildDraftDiff 对段内文本 replace 产出的 before=[{type:"text",...}](见
 * proposalDiff inlineSliceAsNodes)。结构块(表格/列表/代码)的 replace 仍是块节点、不在此集 → 照旧落块通道。
 * inlineMath 在视图层按 math span 保留,offset 投影统一用 U+FFFC,不会再把 latex 源码长度当 PM 位置。 */
const INLINE_NODE_PM_TYPES = new Set(["text", "hardBreak", "inlineMath"]);

function pmNodesInlineSafe(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return true;
  return nodes.every((node) => {
    if (node === null || typeof node !== "object") return false;
    const t = (node as { type?: string }).type ?? "";
    return INLINE_SAFE_PM_TYPES.has(t) || INLINE_NODE_PM_TYPES.has(t);
  });
}

export function suggestionToPatchOverlay(
  doc: ViewDocumentSnapshot | null,
  suggestion: WireDocSuggestion,
  order?: number,
): PatchOverlayInput | null {
  if (suggestion.status === "conflict") {
    return {
      id: suggestion.id,
      reviewBatchId: suggestion.reviewBatchId ?? suggestion.id,
      groupMode: suggestion.groupMode ?? "independent",
      ...(order !== undefined ? { order } : {}),
      before: suggestion.preview.deleteText,
      after: suggestion.preview.insertText,
      blockIndex: -1,
      conflict: true,
    };
  }
  if (!doc) return null;
  const hunk = suggestionDiffHunk(suggestion);
  if (hunk?.op === "insert" || hunk?.op === "delete") return null;
  // 结构块(表格/列表/代码块等)的 replace 不能走行内文本通道——文本通道渲染的
  // insertText 是制表符拍平的降级预览(表格会糊成一串绿字),真结构在 hunk.after
  // 的 PM 节点里。返回 null 落到块通道(suggestionToBlockPatchInputs),渲染
  // "删旧块+插新块"可视对,审核态与接受后所见一致。
  if (
    hunk?.op === "replace" &&
    (!pmNodesInlineSafe(hunk.before) || !pmNodesInlineSafe(hunk.after))
  ) {
    return null;
  }
  const target = findSuggestionViewTarget(doc, suggestion);
  if (!target) return null;
  const markOp = markHunkOp(suggestion, hunk);
  const beforeSpans = hunk ? pmInlineNodesToViewSpans(hunk.before) : null;
  const afterSpans = hunk ? pmInlineNodesToViewSpans(hunk.after) : null;
  const before = beforeSpans ? viewSpansText(beforeSpans) : hunk?.beforeText ?? suggestion.preview.deleteText;
  const after = afterSpans ? viewSpansText(afterSpans) : hunk?.afterText ?? suggestion.preview.insertText;
  const matchBefore = hunk?.beforeText ?? before;
  const matchAfter = hunk?.afterText ?? after;
  return {
    id: suggestion.id,
    reviewBatchId: suggestion.reviewBatchId ?? hunk?.reviewBatchId ?? suggestion.id,
    groupMode: suggestion.groupMode ?? hunk?.groupMode ?? "independent",
    ...(order !== undefined ? { order } : {}),
    before,
    after,
    blockIndex: target.blockIndex,
    range: target.range,
    matchBefore,
    matchAfter,
    ...(beforeSpans ? { beforeSpans } : {}),
    ...(afterSpans ? { afterSpans } : {}),
    ...(markOp
      ? {
          kind: markOp,
          marks: normalizePatchMarks(hunk?.marks),
          label: markActionLabel(markOp, normalizePatchMarks(hunk?.marks)),
        }
      : {}),
  };
}

export function suggestionToBlockPatchInput(
  suggestion: WireDocSuggestion,
  order?: number,
): BlockPatchInput | null {
  if (suggestion.status === "conflict") return null;
  const hunk = suggestionDiffHunk(suggestion);
  if (!hunk || (hunk.op !== "insert" && hunk.op !== "delete")) return null;
  const nodes = hunk.op === "insert" ? hunk.after : hunk.before;
  const blocks = Array.isArray(nodes) ? pmNodesToViewBlocks(nodes) : [];
  if (blocks.length === 0) return null;
  const anchorIndex = hunk.blockPath[0];
  return {
    patchId: suggestion.id,
    reviewBatchId: suggestion.reviewBatchId ?? hunk.reviewBatchId ?? suggestion.id,
    groupMode: suggestion.groupMode ?? hunk.groupMode ?? "independent",
    ...(order !== undefined ? { order } : {}),
    op: hunk.op,
    ...(hunk.anchor.blockId ? { anchorBlockId: hunk.anchor.blockId } : {}),
    ...(validBlockPathIndex(anchorIndex) ? { anchorIndex } : {}),
    ...(hunk.anchor.gravity ? { gravity: hunk.anchor.gravity } : {}),
    ...(hunk.op === "insert" && Array.isArray(nodes) ? { pmNodes: nodes as readonly PmBlockNode[] } : {}),
    ...(hunk.op === "delete" && Array.isArray(nodes) ? { beforePmNodes: nodes as readonly PmBlockNode[] } : {}),
    blocks,
    blockCount: blocks.length,
  };
}

/**
 * 诊断 p03:结构块(表格/列表/引用块等)的修改一律产出 op:"replace" hunk,
 * 而 replace 此前既进不了内联 overlay(patchableSectionSpans 只认纯文本段),
 * 也进不了块级 patch(上面的单数版只认 insert/delete)——在审阅界面被静默
 * 丢弃,出现"显示 0 处修改但请你审批"的盲签局面。
 *
 * 复数版补上 replace 通道:同一 replace hunk 保持为单一 replace 视觉态,
 * 正文显示 after 块,hover 展示 before 块。insert/delete 仍是单条。
 */
export function suggestionToBlockPatchInputs(
  suggestion: WireDocSuggestion,
  order?: number,
): BlockPatchInput[] {
  if (suggestion.status === "conflict") return [];
  const hunk = suggestionDiffHunk(suggestion);
  if (!hunk) return [];

  if (hunk.op === "insert" || hunk.op === "delete") {
    const single = suggestionToBlockPatchInput(suggestion, order);
    return single ? [single] : [];
  }
  if (hunk.op !== "replace") return [];

  const anchorIndex = hunk.blockPath[0];
  const shared = {
    patchId: suggestion.id,
    reviewBatchId: suggestion.reviewBatchId ?? hunk.reviewBatchId ?? suggestion.id,
    groupMode: suggestion.groupMode ?? hunk.groupMode ?? ("independent" as const),
    ...(order !== undefined ? { order } : {}),
    ...(hunk.anchor.blockId ? { anchorBlockId: hunk.anchor.blockId } : {}),
    ...(validBlockPathIndex(anchorIndex) ? { anchorIndex } : {}),
    ...(Array.isArray(hunk.before) ? { beforePmNodes: hunk.before as readonly PmBlockNode[] } : {}),
  };
  const beforeListNode = singleListPmBlock(hunk.before);
  const afterListNode = singleListPmBlock(hunk.after);
  if (beforeListNode && afterListNode && beforeListNode.type === afterListNode.type) {
    const input = buildListRowReplace(beforeListNode, afterListNode, shared);
    return input ? [input] : [];
  }
  const beforeTableNode = singleTablePmBlock(hunk.before);
  const afterTableNode = singleTablePmBlock(hunk.after);
  if (beforeTableNode && afterTableNode) {
    const input = buildTableCellReplace(beforeTableNode, afterTableNode, shared);
    return input ? [input] : [];
  }
  const beforeCalloutNode = singleCalloutPmBlock(hunk.before);
  const afterCalloutNode = singleCalloutPmBlock(hunk.after);
  if (beforeCalloutNode && afterCalloutNode) {
    const input = buildCalloutReplace(beforeCalloutNode, afterCalloutNode, shared);
    return input ? [input] : [];
  }
  const beforeColumnListNode = singleColumnListPmBlock(hunk.before);
  const afterColumnListNode = singleColumnListPmBlock(hunk.after);
  if (beforeColumnListNode && afterColumnListNode) {
    const input = buildColumnListReplace(beforeColumnListNode, afterColumnListNode, shared);
    return input ? [input] : [];
  }

  const beforeBlocks = Array.isArray(hunk.before) ? pmNodesToViewBlocks(hunk.before) : [];
  const afterBlocks = Array.isArray(hunk.after) ? pmNodesToViewBlocks(hunk.after) : [];
  if (beforeBlocks.length === 0 && afterBlocks.length === 0) return [];
  if (beforeBlocks.length === 1 && afterBlocks.length === 1) {
    return [{
      ...shared,
      op: "replace",
      blocks: afterBlocks,
      replaceBeforeBlocks: beforeBlocks,
      blockCount: 1,
      ...(Array.isArray(hunk.after) ? { pmNodes: hunk.after as readonly PmBlockNode[] } : {}),
    }];
  }

  const inputs: BlockPatchInput[] = [];
  if (beforeBlocks.length > 0) {
    inputs.push({
      ...shared,
      op: "delete",
      blocks: beforeBlocks,
      blockCount: beforeBlocks.length,
    });
  }
  if (afterBlocks.length > 0) {
    inputs.push({
      ...shared,
      op: "insert",
      // 新块紧跟在被替换的旧块之后展示,形成 before/after 对照。
      gravity: "after",
      blocks: afterBlocks,
      blockCount: afterBlocks.length,
      ...(Array.isArray(hunk.after) ? { pmNodes: hunk.after as readonly PmBlockNode[] } : {}),
    });
  }
  return inputs;
}

function resolveBlockPatchTargetIndex(
  doc: ViewDocumentSnapshot,
  sections: readonly ViewBlock[],
  input: BlockPatchInput,
  op: "insert" | "delete" | "replace",
): number | null {
  const blockIdIndex = input.anchorBlockId
    ? sections.findIndex((section) => section.blockId === input.anchorBlockId)
    : -1;
  if (blockIdIndex >= 0) {
    if (op !== "insert") return blockIdIndex;
    return input.gravity === "before" ? blockIdIndex : blockIdIndex + 1;
  }
  if (validBlockPathIndex(input.anchorIndex)) {
    return topBlockIndexToViewSectionIndex(doc, input.anchorIndex, sections.length);
  }
  return op === "insert" ? sections.length : null;
}

function topBlockIndexToViewSectionIndex(
  doc: ViewDocumentSnapshot,
  blockIndex: number,
  sectionCount: number,
): number {
  if (!doc.pmDoc) return clampIndex(blockIndex, sectionCount);
  let viewIndex = 0;
  const topBlockCount = Math.min(blockIndex, doc.pmDoc.content.length);
  for (let i = 0; i < topBlockCount; i += 1) {
    const block = doc.pmDoc.content[i];
    if (block) viewIndex += viewSectionCountForTopBlock(block);
  }
  return clampIndex(viewIndex, sectionCount);
}

function validBlockPathIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function cloneViewBlock(section: ViewBlock): ViewBlock {
  const meta = {
    ...(section.blockId ? { blockId: section.blockId } : {}),
    ...(section.blockPatch ? { blockPatch: cloneBlockPatch(section.blockPatch) } : {}),
  };
  switch (section.kind) {
    case "h1":
      return { ...meta, kind: "h1", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}), ...(section.textAlign ? { textAlign: section.textAlign } : {}) };
    case "h2":
      return { ...meta, kind: "h2", text: section.text, anchor: section.anchor, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}), ...(section.textAlign ? { textAlign: section.textAlign } : {}) };
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return { ...meta, kind: section.kind, text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}), ...(section.textAlign ? { textAlign: section.textAlign } : {}) };
    case "p":
      return { ...meta, kind: "p", spans: section.spans.map((span) => ({ ...span })), ...(section.textAlign ? { textAlign: section.textAlign } : {}) };
    case "quote":
      return { ...meta, kind: "quote", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}), ...(section.node ? { node: section.node } : {}) };
    case "list":
      return {
        ...meta,
        kind: "list",
        ordered: section.ordered,
        ...(section.start != null ? { start: section.start } : {}),
        ...(section.listStyle ? { listStyle: section.listStyle } : {}),
        items: section.items.slice(),
        ...(section.itemSpans ? { itemSpans: section.itemSpans.map(cloneSpans) } : {}),
        ...(section.rowDiff ? { rowDiff: cloneListRowDiff(section.rowDiff) } : {}),
        ...(section.node ? { node: section.node } : {}),
      };
    case "hr":
      return { ...meta, kind: "hr" };
    case "table":
      return {
        ...meta,
        kind: "table",
        head: section.head.slice(),
        rows: section.rows.map((row) => row.slice()),
        ...(section.headSpans ? { headSpans: section.headSpans.map(cloneSpans) } : {}),
        ...(section.rowSpans ? { rowSpans: section.rowSpans.map((row) => row.map(cloneSpans)) } : {}),
        ...(section.cellDiff ? { cellDiff: cloneTableRowDiff(section.cellDiff) } : {}),
        ...(section.node ? { node: section.node } : {}),
      };
    case "code":
      return { ...meta, kind: "code", body: section.body, language: section.language ?? null };
    case "diagram":
      return { ...meta, kind: "diagram", source: section.source, lang: section.lang, svg: section.svg, overlay: section.overlay ?? null };
    case "penNote":
      return { ...meta, kind: "penNote", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "image":
      return {
        ...meta,
        kind: "image",
        src: section.src,
        alt: section.alt,
	        caption: section.caption,
	        width: section.width,
	        height: section.height,
	        align: section.align ?? "center",
	      };
    case "fileAttachment":
      return {
        ...meta,
        kind: "fileAttachment",
        fileId: section.fileId,
        filename: section.filename,
        mimeType: section.mimeType,
        size: section.size,
      };
    // 保真块:node 不可变,按引用透传即可
    case "taskList":
      return {
        ...meta,
        kind: "taskList",
        node: section.node,
        text: section.text,
        ...(section.rowDiff ? { rowDiff: cloneListRowDiff(section.rowDiff) } : {}),
      };
    case "callout":
      return {
        ...meta,
        kind: "callout",
        node: section.node,
        text: section.text,
        ...(section.bodyDiff ? { bodyDiff: cloneBlockSeqDiff(section.bodyDiff) } : {}),
      };
    case "columnList":
      return {
        ...meta,
        kind: "columnList",
        node: section.node,
        text: section.text,
        ...(section.columnsDiff ? { columnsDiff: section.columnsDiff.map(cloneColumnDiff) } : {}),
      };
    case "math":
      return { ...meta, kind: "math", node: section.node, latex: section.latex };
  }
}

function cloneBlockPatch(blockPatch: ViewBlockPatch): ViewBlockPatch {
  return {
    patchId: blockPatch.patchId,
    op: blockPatch.op,
    ...(blockPatch.marker ? { marker: { ...blockPatch.marker } } : {}),
    ...(blockPatch.beforeBlock ? { beforeBlock: cloneViewBlock(blockPatch.beforeBlock) } : {}),
  };
}

export function cloneListRowDiff(rowDiff: readonly ViewListRowDiff[]): ViewListRowDiff[] {
  const cloneChildLists = (row: ViewListRowDiff) => (
    row.childLists
      ? {
          childLists: row.childLists.map((child) => ({
            ...(child.beforeListIndex !== undefined ? { beforeListIndex: child.beforeListIndex } : {}),
            ...(child.afterListIndex !== undefined ? { afterListIndex: child.afterListIndex } : {}),
            rowDiff: cloneListRowDiff(child.rowDiff),
          })),
        }
      : {}
  );
  return rowDiff.map((row): ViewListRowDiff => {
    switch (row.status) {
      case "same":
        return {
          status: "same",
          spans: cloneSpans(row.spans),
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...cloneChildLists(row),
        };
      case "changed":
        return {
          status: "changed",
          spans: cloneSpans(row.spans),
          oldText: row.oldText,
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...(row.checkedChanged ? { checkedChanged: true } : {}),
          ...cloneChildLists(row),
        };
      case "added":
        return {
          status: "added",
          spans: cloneSpans(row.spans),
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...cloneChildLists(row),
        };
      case "removed":
        return {
          status: "removed",
          oldText: row.oldText,
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...cloneChildLists(row),
        };
    }
  });
}

function cloneTableRowDiff(rowDiff: readonly ViewTableRowDiff[]): ViewTableRowDiff[] {
  return rowDiff.map((row) => ({
    status: row.status,
    cells: row.cells.map((cell): ViewTableCellDiff => {
      if (cell.status === "same") return { status: "same", spans: cloneSpans(cell.spans) };
      return { status: "changed", spans: cloneSpans(cell.spans), oldText: cell.oldText };
    }),
  }));
}

function cloneBlockSeqDiff(seqDiff: readonly ViewBlockSeqDiff[number][]): ViewBlockSeqDiff {
  return seqDiff.map((entry): ViewBlockSeqDiff[number] => {
    switch (entry.status) {
      case "same":
        return { status: "same", block: entry.block };
      case "added":
        return { status: "added", block: entry.block };
      case "removed":
        return { status: "removed", oldText: entry.oldText };
      case "changed":
        if (entry.kind === "block") {
          return {
            status: "changed",
            kind: "block",
            node: entry.node,
          };
        }
        if (entry.kind === "text") {
          return {
            status: "changed",
            kind: "text",
            node: entry.node,
            spans: cloneSpans(entry.spans),
            oldText: entry.oldText,
          };
        }
        if (entry.kind === "list") {
          return {
            status: "changed",
            kind: "list",
            node: entry.node,
            rowDiff: cloneListRowDiff(entry.rowDiff),
          };
        }
        return {
          status: "changed",
          kind: "table",
          node: entry.node,
          cellDiff: cloneTableRowDiff(entry.cellDiff),
        };
    }
  });
}

function cloneColumnDiff(columnDiff: ViewColumnDiff): ViewColumnDiff {
  return {
    status: columnDiff.status,
    ...(columnDiff.beforeColumnIndex !== undefined ? { beforeColumnIndex: columnDiff.beforeColumnIndex } : {}),
    ...(columnDiff.afterColumnIndex !== undefined ? { afterColumnIndex: columnDiff.afterColumnIndex } : {}),
    bodyDiff: cloneBlockSeqDiff(columnDiff.bodyDiff),
  };
}

export interface AppliedPatch {
  id: string;
  reviewBatchId: string;
  groupMode: "atomic" | "independent";
  before: string;
  after: string;
  kind: "text" | "markAdd" | "markRemove" | "insert" | "delete" | "replace";
  marks?: PmMark[];
  label?: string;
  /** 原始 before PM node(块级补丁的替换/删除原文):hover 卡片据此用 PmBlockView 渲成真内容,
   *  保全所有格式,而非把 markdown 源码散排。仅块级补丁携带,行内文本补丁为空。 */
  beforePmNodes?: readonly PmBlockNode[];
  /** 连续序号,1 起,只对真正落地的 patch 编号(无空洞)。 */
  index: number;
}

export interface ReviewPatchGroup {
  reviewBatchId: string;
  groupMode: "atomic" | "independent";
  patchIds: string[];
  index: number;
}

export type ReviewTargetKind = "added" | "removed" | "changed" | "patch";

/** 正文中可逐个计数、导航和高亮的最小审阅单元。裁决仍由 patchId 回到整条 suggestion。 */
export interface ReviewTarget {
  id: string;
  patchId: string;
  index: number;
  kind: ReviewTargetKind;
  /** granular React 树内的稳定定位路径；普通行内/块级 patch 不携带。 */
  path?: string;
}

export function granularReviewTargetId(patchId: string, path: string): string {
  return `${patchId}::${path}`;
}

type ReviewTargetPath = { path: string; kind: ReviewTargetKind };

function collectListReviewTargetPaths(
  rows: readonly ViewListRowDiff[],
  prefix: string,
  out: ReviewTargetPath[],
): void {
  rows.forEach((row, rowIndex) => {
    const rowPath = `${prefix}/row:${rowIndex}`;
    if (row.status !== "same") out.push({ path: rowPath, kind: row.status });
    row.childLists?.forEach((nested, nestedIndex) => {
      collectListReviewTargetPaths(nested.rowDiff, `${rowPath}/nested:${nestedIndex}`, out);
    });
  });
}

function collectTableReviewTargetPaths(
  rows: readonly ViewTableRowDiff[],
  prefix: string,
  out: ReviewTargetPath[],
): void {
  rows.forEach((row, rowIndex) => {
    const rowPath = `${prefix}/row:${rowIndex}`;
    if (row.status === "added" || row.status === "removed") {
      out.push({ path: rowPath, kind: row.status });
      return;
    }
    row.cells.forEach((cell, cellIndex) => {
      if (cell.status === "changed") out.push({ path: `${rowPath}/cell:${cellIndex}`, kind: "changed" });
    });
  });
}

function collectBlockSeqReviewTargetPaths(
  entries: readonly ViewBlockSeqDiff[number][],
  prefix: string,
  out: ReviewTargetPath[],
): void {
  entries.forEach((entry, entryIndex) => {
    const entryPath = `${prefix}/entry:${entryIndex}`;
    if (entry.status === "same") return;
    if (entry.status === "added" || entry.status === "removed") {
      out.push({ path: entryPath, kind: entry.status });
      return;
    }
    if (entry.kind === "list") {
      collectListReviewTargetPaths(entry.rowDiff, `${entryPath}/list`, out);
      return;
    }
    if (entry.kind === "table") {
      collectTableReviewTargetPaths(entry.cellDiff, `${entryPath}/table`, out);
      return;
    }
    out.push({ path: entryPath, kind: "changed" });
  });
}

function collectBlockReviewTargetPaths(block: ViewBlock, prefix: string, out: ReviewTargetPath[]): void {
  if ((block.kind === "list" || block.kind === "taskList") && block.rowDiff) {
    collectListReviewTargetPaths(block.rowDiff, `${prefix}/list`, out);
    return;
  }
  if (block.kind === "table" && block.cellDiff) {
    collectTableReviewTargetPaths(block.cellDiff, `${prefix}/table`, out);
    return;
  }
  if (block.kind === "callout" && block.bodyDiff) {
    collectBlockSeqReviewTargetPaths(block.bodyDiff, `${prefix}/body`, out);
    return;
  }
  if (block.kind === "columnList" && block.columnsDiff) {
    block.columnsDiff.forEach((column, columnIndex) => {
      collectBlockSeqReviewTargetPaths(column.bodyDiff, `${prefix}/column:${columnIndex}/body`, out);
    });
  }
}

/** applied 与 granular diff 同源地产生正文最小改动清单。 */
export function deriveReviewTargets(
  applied: readonly AppliedPatch[],
  blockPatches: readonly BlockPatchInput[],
): ReviewTarget[] {
  const targets: ReviewTarget[] = [];
  for (const patch of applied) {
    const paths: ReviewTargetPath[] = [];
    blockPatches.forEach((input, inputIndex) => {
      if (input.patchId !== patch.id || input.op !== "replace" || input.granular !== true) return;
      input.blocks.forEach((block, blockIndex) => {
        collectBlockReviewTargetPaths(block, `input:${inputIndex}/block:${blockIndex}`, paths);
      });
    });
    if (paths.length === 0) {
      targets.push({ id: patch.id, patchId: patch.id, index: targets.length + 1, kind: "patch" });
      continue;
    }
    for (const target of paths) {
      targets.push({
        id: granularReviewTargetId(patch.id, target.path),
        patchId: patch.id,
        index: targets.length + 1,
        kind: target.kind,
        path: target.path,
      });
    }
  }
  return targets;
}

/**
 * 审批态 patch 呈现的**单一真相源**:对 baseline 文档定位 patch,产出
 * - `applied`:真正可定位的 patch(含连续序号),计数 / 序号 / decoration 元数据都从这里派生;
 * - `reviewTargets`:正文实际行/格/块级标记(含连续序号),供计数、导航与当前态高亮;
 * - `droppedIds`:锚点失败被丢弃的 patch(完整性缺口,需被发现)。
 *
 * 这样"左侧已修改 N 处 / decoration 标记 / 悬浮序号"三者同源,天然一致,不会再出现
 * "说 4 处实际 3 处、序号缺 1"的错乱。
 */
export function derivePatchPresentation(
  doc: ViewDocumentSnapshot,
  patches: ReadonlyArray<PatchOverlayInput>,
  blockPatches: ReadonlyArray<BlockPatchInput> = [],
): {
  applied: AppliedPatch[];
  reviewTargets: ReviewTarget[];
  groups: ReviewPatchGroup[];
  appliedGroupIds: Set<string>;
  appliedIds: Set<string>;
  droppedIds: string[];
  conflictIds: string[];
} {
  const conflictIds = patches
    .filter((patch) => patch.conflict === true)
    .map((patch) => patch.id);
  const { appliedIds, droppedIds } = collectPatchOverlayReport(
    doc,
    patches,
  );
  const {
    appliedIds: blockAppliedIds,
    droppedIds: blockDroppedIds,
  } = collectBlockPatchOverlayReport(doc, blockPatches);
  const allAppliedIds = new Set([...appliedIds, ...blockAppliedIds]);
  type AppliedCandidate = {
    order: number;
    seq: number;
    id: string;
    reviewBatchId: string;
    groupMode: "atomic" | "independent";
    before: string;
    after: string;
    kind: AppliedPatch["kind"];
    marks?: PmMark[];
    label?: string;
    beforePmNodes?: readonly PmBlockNode[];
  };
  const appliedCandidates: AppliedCandidate[] = [];
  let seq = 0;
  patches.forEach((p, fallbackOrder) => {
    if (!appliedIds.has(p.id)) return;
    appliedCandidates.push({
      order: p.order ?? fallbackOrder,
      seq: seq++,
      id: p.id,
      reviewBatchId: patchReviewBatchId(p),
      groupMode: patchGroupMode(p),
      before: p.before,
      after: p.after,
      kind: p.kind ?? "text",
      ...(p.marks ? { marks: p.marks } : {}),
      ...(p.label ? { label: p.label } : {}),
    });
  });
  const blockCandidatesByPatchId = new Map<
    string,
    AppliedCandidate & { hasDelete: boolean; hasInsert: boolean; hasReplace: boolean }
  >();
  blockPatches.forEach((input, fallbackOrder) => {
    if (!blockAppliedIds.has(input.patchId)) return;
    const text = blocksPlainText(input.blocks);
    const replaceBeforeText = input.op === "replace" ? blocksPlainText(input.replaceBeforeBlocks ?? []) : "";
    // 原始 before PM node:replace/delete 携带 hunk.before;供 hover 卡片 PmBlockView 渲原文(全保真)。
    const beforePmNodes: readonly PmBlockNode[] =
      input.op === "replace" || input.op === "delete" ? input.beforePmNodes ?? [] : [];
    const existing = blockCandidatesByPatchId.get(input.patchId);
    if (existing) {
      existing.order = Math.min(existing.order, input.order ?? patches.length + fallbackOrder);
      if (input.op === "replace") {
        existing.before = joinBlockPatchText(existing.before, replaceBeforeText);
        existing.after = joinBlockPatchText(existing.after, text);
        existing.hasReplace = true;
      } else if (input.op === "delete") {
        existing.before = joinBlockPatchText(existing.before, text);
        existing.hasDelete = true;
      } else {
        existing.after = joinBlockPatchText(existing.after, text);
        existing.hasInsert = true;
      }
      if (beforePmNodes.length > 0) {
        existing.beforePmNodes = [...(existing.beforePmNodes ?? []), ...beforePmNodes];
      }
      existing.kind = blockAppliedKind(existing.hasDelete, existing.hasInsert, existing.hasReplace);
      return;
    }
    const hasDelete = input.op === "delete";
    const hasInsert = input.op === "insert";
    const hasReplace = input.op === "replace";
    blockCandidatesByPatchId.set(input.patchId, {
      order: input.order ?? patches.length + fallbackOrder,
      seq: seq++,
      id: input.patchId,
      reviewBatchId: blockPatchReviewBatchId(input),
      groupMode: blockPatchGroupMode(input),
      before: hasDelete ? text : replaceBeforeText,
      after: hasInsert || hasReplace ? text : "",
      kind: blockAppliedKind(hasDelete, hasInsert, hasReplace),
      ...(beforePmNodes.length > 0 ? { beforePmNodes } : {}),
      hasDelete,
      hasInsert,
      hasReplace,
    });
  });
  appliedCandidates.push(...blockCandidatesByPatchId.values());
  appliedCandidates.sort((a, b) => a.order - b.order || a.seq - b.seq);

  const applied: AppliedPatch[] = [];
  const groupIndexById = new Map<string, number>();
  const groupPatchIds = new Map<string, string[]>();
  const groupModeById = new Map<string, "atomic" | "independent">();
  for (const p of appliedCandidates) {
    const reviewBatchId = p.reviewBatchId;
    const groupMode = p.groupMode;
    let groupIndex = groupIndexById.get(reviewBatchId);
    if (groupIndex === undefined) {
      groupIndex = groupIndexById.size + 1;
      groupIndexById.set(reviewBatchId, groupIndex);
      groupPatchIds.set(reviewBatchId, []);
      groupModeById.set(reviewBatchId, groupMode);
    }
    groupPatchIds.get(reviewBatchId)!.push(p.id);
    applied.push({
      id: p.id,
      reviewBatchId,
      groupMode,
      before: p.before,
      after: p.after,
      kind: p.kind ?? "text",
      ...(p.marks ? { marks: p.marks } : {}),
      ...(p.label ? { label: p.label } : {}),
      ...(p.beforePmNodes && p.beforePmNodes.length > 0 ? { beforePmNodes: p.beforePmNodes } : {}),
      index: applied.length + 1,
    });
  }
  const groups: ReviewPatchGroup[] = [...groupIndexById.entries()].map(
    ([reviewBatchId, index]) => ({
      reviewBatchId,
      groupMode: groupModeById.get(reviewBatchId) ?? "independent",
      patchIds: groupPatchIds.get(reviewBatchId) ?? [],
      index,
    }),
  );
  const reviewTargets = deriveReviewTargets(applied, blockPatches);
  return {
    applied,
    reviewTargets,
    groups,
    appliedGroupIds: new Set(groups.map((group) => group.reviewBatchId)),
    appliedIds: allAppliedIds,
    droppedIds: [...droppedIds, ...blockDroppedIds],
    conflictIds,
  };
}

function collectPatchOverlayReport(
  doc: ViewDocumentSnapshot,
  patches: ReadonlyArray<PatchOverlayInput>,
): { appliedIds: Set<string>; droppedIds: string[] } {
  const appliedIds = new Set<string>();
  if (patches.length === 0) return { appliedIds, droppedIds: [] };
  const activePatches = patches.filter((patch) => patch.conflict !== true);

  const patchesBySection = new Map<number, PatchOverlayInput[]>();
  for (const patch of activePatches) {
    const sectionPatches = patchesBySection.get(patch.blockIndex) ?? [];
    sectionPatches.push(patch);
    patchesBySection.set(patch.blockIndex, sectionPatches);
  }

  doc.sections.forEach((section, blockIndex) => {
    const baseSpans = patchableSectionSpans(section);
    if (!baseSpans) return;
    const scopedPatches = patchesBySection.get(blockIndex);
    if (!scopedPatches || scopedPatches.length === 0) return;
    for (const patch of scopedPatches) {
      if (patchResolvesInSpans(baseSpans, patch)) appliedIds.add(patch.id);
    }
  });

  const droppedIds = patches
    .filter((p) => p.conflict !== true)
    .filter((p) => !appliedIds.has(p.id))
    .map((p) => p.id);
  return { appliedIds, droppedIds };
}

function patchResolvesInSpans(spans: readonly ViewDocSpan[], patch: PatchOverlayInput): boolean {
  if (patch.kind === "markAdd" || patch.kind === "markRemove") {
    return markPatchResolvesInSpans(spans, patch as PatchOverlayInput & { kind: "markAdd" | "markRemove" });
  }

  const matchBefore = patch.matchBefore ?? patch.before;
  const matchAfter = patch.matchAfter ?? patch.after;
  const hasVisiblePatch =
    Boolean(patch.beforeSpans?.length) ||
    Boolean(patch.afterSpans?.length) ||
    patch.before.length > 0 ||
    patch.after.length > 0;
  if (!hasVisiblePatch) return false;

  const text = viewSpansOffsetText(spans);
  const range = resolvePatchRange(text, patch.range, matchBefore);
  if (range) return true;

  if (matchBefore !== "") {
    const idx = text.indexOf(matchBefore);
    if (idx >= 0) {
      const isEditedDoc =
        matchAfter.length > matchBefore.length &&
        matchAfter.startsWith(matchBefore) &&
        text.startsWith(matchAfter, idx);
      if (!isEditedDoc) return true;
    }
  }

  if (matchAfter.length > 0 && text.includes(matchAfter)) return true;
  return matchAfter === "" && matchBefore !== "" && text.includes("​");
}

function markPatchResolvesInSpans(
  spans: readonly ViewDocSpan[],
  patch: PatchOverlayInput & { kind: "markAdd" | "markRemove" },
): boolean {
  const matchBefore = patch.matchBefore ?? patch.before;
  const text = viewSpansOffsetText(spans);
  const range = resolvePatchRange(text, patch.range, matchBefore);
  if (range) return markPatchRangeHasBody(spans, range.start, range.end);
  if (matchBefore.length === 0) return false;
  const idx = text.indexOf(matchBefore);
  if (idx < 0) return false;
  const start = Array.from(text.slice(0, idx)).length;
  const end = Array.from(text.slice(0, idx + matchBefore.length)).length;
  return markPatchRangeHasBody(spans, start, end);
}

function resolvePatchRange(
  text: string,
  range: PatchOverlayInput["range"] | undefined,
  matchBefore: string,
): { start: number; end: number } | null {
  if (!range) return null;
  const textLength = Array.from(text).length;
  const start = Math.max(0, Math.min(range.start, textLength));
  const end = Math.max(start, Math.min(range.end, textLength));
  const selected = Array.from(text).slice(start, end).join("");
  return selected === matchBefore ? { start, end } : null;
}

function markPatchRangeHasBody(spans: readonly ViewDocSpan[], start: number, end: number): boolean {
  const splitStart = splitSpansAt(spans, start);
  if (!splitStart) return false;
  const splitEnd = splitSpansAt(splitStart.right, end - start);
  if (!splitEnd) return false;
  if (splitEnd.left.some((span) => span.kind === "math" || span.kind === "patchInsMath" || span.kind === "patchDelMath")) {
    return false;
  }
  return viewSpansText(splitEnd.left).length > 0;
}

function collectBlockPatchOverlayReport(
  doc: ViewDocumentSnapshot,
  inputs: ReadonlyArray<BlockPatchInput>,
): { appliedIds: Set<string>; droppedIds: string[] } {
  if (inputs.length === 0) return { appliedIds: new Set(), droppedIds: [] };
  const sections = doc.sections.map(cloneViewBlock);
  const appliedIds = new Set<string>();
  const droppedIds: string[] = [];
  const insertions: Array<{ input: BlockPatchInput; targetIndex: number; seq: number }> = [];

  inputs.forEach((input) => {
    if (input.op !== "replace") return;
    if (input.blocks.length !== 1) {
      droppedIds.push(input.patchId);
      return;
    }
    const targetIndex = resolveBlockPatchTargetIndex(doc, sections, input, "replace");
    if (targetIndex === null || targetIndex >= sections.length) {
      droppedIds.push(input.patchId);
      return;
    }
    sections[targetIndex] = cloneViewBlock(input.blocks[0]!);
    appliedIds.add(input.patchId);
  });

  inputs.forEach((input) => {
    if (input.op !== "delete") return;
    const count = Math.max(1, input.blockCount ?? input.blocks.length);
    const targetIndex = resolveBlockPatchTargetIndex(doc, sections, input, "delete");
    if (targetIndex === null || targetIndex + count > sections.length) {
      droppedIds.push(input.patchId);
      return;
    }
    appliedIds.add(input.patchId);
  });

  inputs.forEach((input, seq) => {
    if (input.op !== "insert") return;
    if (input.blocks.length === 0) {
      droppedIds.push(input.patchId);
      return;
    }
    const targetIndex = resolveBlockPatchTargetIndex(doc, sections, input, "insert");
    if (targetIndex === null) {
      droppedIds.push(input.patchId);
      return;
    }
    insertions.push({ input, targetIndex, seq });
  });

  insertions.sort((a, b) => a.targetIndex - b.targetIndex || a.seq - b.seq);
  let insertOffset = 0;
  for (const insertion of insertions) {
    const insertAt = clampIndex(insertion.targetIndex + insertOffset, sections.length);
    sections.splice(insertAt, 0, ...insertion.input.blocks.map(cloneViewBlock));
    insertOffset += insertion.input.blocks.length;
    appliedIds.add(insertion.input.patchId);
  }

  return { appliedIds, droppedIds };
}

function patchReviewBatchId(patch: PatchOverlayInput): string {
  return patch.reviewBatchId ?? patch.id;
}

function patchGroupMode(patch: PatchOverlayInput): "atomic" | "independent" {
  return patch.groupMode ?? "independent";
}

function blockPatchReviewBatchId(input: BlockPatchInput): string {
  return input.reviewBatchId ?? input.patchId;
}

function blockPatchGroupMode(input: BlockPatchInput): "atomic" | "independent" {
  return input.groupMode ?? "independent";
}

function blockAppliedKind(hasDelete: boolean, hasInsert: boolean, hasReplace = false): AppliedPatch["kind"] {
  if (hasReplace) return "replace";
  if (hasDelete && hasInsert) return "text";
  return hasInsert ? "insert" : "delete";
}

function blocksPlainText(blocks: readonly ViewBlock[]): string {
  return blocks.map(viewSectionText).filter(Boolean).join("\n");
}

function joinBlockPatchText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left}\n${right}`;
}

/**
 * Materialize patch verdicts into the doc body: accepted patches'
 * `after` text replaces `before`; rejected patches restore the
 * original `before` text. Used at commit time to produce the next
 * doc version's plain spans.
 */
export function materializeDoc(
  doc: ViewDocumentSnapshot,
  patches: ReadonlyArray<{
    id: string;
    before: string;
    after: string;
    blockIndex: number;
    verdict: "accepted" | "rejected";
  }>,
  newVersion: number,
): ViewDocumentSnapshot {
  if (patches.length === 0) return { ...doc, version: newVersion };
  const patchesBySection = new Map<number, typeof patches>();
  for (const patch of patches) {
    const sectionPatches = patchesBySection.get(patch.blockIndex) ?? [];
    patchesBySection.set(patch.blockIndex, [...sectionPatches, patch]);
  }

  const sections = doc.sections.map((section, blockIndex): ViewBlock => {
    if (section.kind !== "p") return section;
    const scopedPatches = patchesBySection.get(blockIndex);
    if (!scopedPatches || scopedPatches.length === 0) return section;

    let text = section.spans
      .map(viewDocSpanText)
      .join("");
    for (const p of scopedPatches) {
      const replacement = p.verdict === "accepted" ? p.after : p.before;
      // Try the after-text first — the edited doc already contains it
      // when the seamless transition shipped `buildEditedDoc` output.
      const idxAfter = p.after.length > 0 ? text.indexOf(p.after) : -1;
      if (idxAfter >= 0) {
        text =
          text.slice(0, idxAfter) +
          replacement +
          text.slice(idxAfter + p.after.length);
        continue;
      }
      // Fallback: `before` still present (original doc path).
      const idx = p.before.length > 0 ? text.indexOf(p.before) : -1;
      if (idx >= 0) {
        text = text.slice(0, idx) + replacement + text.slice(idx + p.before.length);
        continue;
      }
      // Pure deletion with ZWS marker: replace the ZWS with `before` on
      // reject, or remove it on accept.
      if (p.after === "" && p.before !== "") {
        const zwsIdx = text.indexOf("​");
        if (zwsIdx >= 0) {
          const r = p.verdict === "rejected" ? p.before : "";
          text = text.slice(0, zwsIdx) + r + text.slice(zwsIdx + 1);
        }
      }
    }
    return { kind: "p", spans: [{ kind: "text", text }] };
  });
  return { ...doc, version: newVersion, sections };
}

function spliceSpans(
  spans: ViewDocSpan[],
  patch: {
    id: string;
    before: string;
    after: string;
    range?: { start: number; end: number };
    kind?: "text" | "markAdd" | "markRemove";
    marks?: PmMark[];
    label?: string;
    matchBefore?: string;
    matchAfter?: string;
    beforeSpans?: ViewDocSpan[];
    afterSpans?: ViewDocSpan[];
  },
): { spans: ViewDocSpan[]; injected: boolean } {
  if (patch.kind === "markAdd" || patch.kind === "markRemove") {
    return spliceMarkSpans(spans, patch as PatchOverlayInput & { kind: "markAdd" | "markRemove" });
  }

  const matchBefore = patch.matchBefore ?? patch.before;
  const matchAfter = patch.matchAfter ?? patch.after;
  const beforePatchSpans = patch.beforeSpans?.length
    ? patchSpans(patch.beforeSpans, "delete", patch.id)
    : patch.before
      ? [{ kind: "patchDel", text: patch.before, patchId: patch.id } satisfies ViewDocSpan]
      : [];
  const afterPatchSpans = patch.afterSpans?.length
    ? patchSpans(patch.afterSpans, "insert", patch.id)
    : patch.after
      ? [{ kind: "patchIns", text: patch.after, patchId: patch.id } satisfies ViewDocSpan]
      : [];

  const injectAt = (start: number, end: number, mode: "replace" | "insert"): { spans: ViewDocSpan[]; injected: boolean } => {
    const splitStart = splitSpansAt(spans, start);
    if (!splitStart) return { spans, injected: false };
    const splitEnd = splitSpansAt(splitStart.right, end - start);
    if (!splitEnd) return { spans, injected: false };
    if (splitEnd.left.some(isPatchSpan)) return { spans, injected: false };
    const selectedOffsetText = viewSpansOffsetText(splitEnd.left);
    if (mode === "replace" && selectedOffsetText !== matchBefore) return { spans, injected: false };
    const injectedSpans = mode === "replace" ? [...beforePatchSpans, ...afterPatchSpans] : afterPatchSpans;
    if (injectedSpans.length === 0) return { spans, injected: false };
    return {
      spans: [...splitStart.left, ...injectedSpans, ...splitEnd.right],
      injected: true,
    };
  };

  if (patch.range) {
    const textLength = Array.from(viewSpansOffsetText(spans)).length;
    const start = Math.max(0, Math.min(patch.range.start, textLength));
    const end = Math.max(start, Math.min(patch.range.end, textLength));
    const ranged = injectAt(start, end, "replace");
    if (ranged.injected) return ranged;
  }

  // Case A: `before` found in the offset projection — splice patchDel + patchIns.
  if (matchBefore !== "") {
    const text = viewSpansOffsetText(spans);
    const idx = text.indexOf(matchBefore);
    if (idx >= 0) {
      const isEditedDoc =
        matchAfter.length > matchBefore.length &&
        matchAfter.startsWith(matchBefore) &&
        text.startsWith(matchAfter, idx);
      if (!isEditedDoc) {
        const replaced = injectAt(
          Array.from(text.slice(0, idx)).length,
          Array.from(text.slice(0, idx + matchBefore.length)).length,
          "replace",
        );
        if (replaced.injected) return replaced;
      }
    }
  }

  // Case B: the doc already contains edited content; wrap `after` as inserted.
  if (matchAfter.length > 0) {
    const text = viewSpansOffsetText(spans);
    const idxAfter = text.indexOf(matchAfter);
    if (idxAfter >= 0) {
      const inserted = injectAt(
        Array.from(text.slice(0, idxAfter)).length,
        Array.from(text.slice(0, idxAfter + matchAfter.length)).length,
        "insert",
      );
      if (inserted.injected) return inserted;
    }
  }

  // Case C: pure deletion marker.
  if (matchAfter === "" && matchBefore !== "") {
    const text = viewSpansOffsetText(spans);
    const zwsIdx = text.indexOf("​");
    if (zwsIdx >= 0) {
      const deleted = injectAt(
        Array.from(text.slice(0, zwsIdx)).length,
        Array.from(text.slice(0, zwsIdx + 1)).length,
        "replace",
      );
      if (deleted.injected) return deleted;
    }
  }

  return { spans, injected: false };
}

function isPatchSpan(span: ViewDocSpan): boolean {
  return (
    span.kind === "patchDel" ||
    span.kind === "patchIns" ||
    span.kind === "patchDelMath" ||
    span.kind === "patchInsMath" ||
    span.kind === "patchMark"
  );
}

function splitSpansAt(spans: readonly ViewDocSpan[], offset: number): { left: ViewDocSpan[]; right: ViewDocSpan[] } | null {
  if (offset <= 0) return { left: [], right: cloneSpans(spans) };
  let remaining = offset;
  const left: ViewDocSpan[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i]!;
    const len = Array.from(viewDocSpanOffsetText(span)).length;
    if (remaining === len) {
      return { left: [...left, { ...span }], right: cloneSpans(spans.slice(i + 1)) };
    }
    if (remaining < len) {
      const split = splitSpanAt(span, remaining);
      if (!split) return null;
      return {
        left: [...left, ...split.left],
        right: [...split.right, ...cloneSpans(spans.slice(i + 1))],
      };
    }
    left.push({ ...span });
    remaining -= len;
  }
  return remaining === 0 ? { left, right: [] } : null;
}

function splitSpanAt(span: ViewDocSpan, offset: number): { left: ViewDocSpan[]; right: ViewDocSpan[] } | null {
  if (offset <= 0) return { left: [], right: [{ ...span }] };
  if (span.kind !== "text" && span.kind !== "patchIns" && span.kind !== "patchDel" && span.kind !== "patchMark" && span.kind !== "selectable") {
    return offset === 1 ? { left: [{ ...span }], right: [] } : null;
  }
  const chars = Array.from(span.text);
  if (offset >= chars.length) return { left: [{ ...span }], right: [] };
  const leftText = chars.slice(0, offset).join("");
  const rightText = chars.slice(offset).join("");
  const left = leftText ? [{ ...span, text: leftText } as ViewDocSpan] : [];
  const right = rightText ? [{ ...span, text: rightText } as ViewDocSpan] : [];
  return { left, right };
}

function spliceMarkSpans(
  spans: ViewDocSpan[],
  patch: PatchOverlayInput & { kind: "markAdd" | "markRemove" },
): { spans: ViewDocSpan[]; injected: boolean } {
  const matchBefore = patch.matchBefore ?? patch.before;
  const injectAt = (start: number, end: number): { spans: ViewDocSpan[]; injected: boolean } => {
    const splitStart = splitSpansAt(spans, start);
    if (!splitStart) return { spans, injected: false };
    const splitEnd = splitSpansAt(splitStart.right, end - start);
    if (!splitEnd) return { spans, injected: false };
    if (splitEnd.left.some(isPatchSpan)) return { spans, injected: false };
    if (viewSpansOffsetText(splitEnd.left) !== matchBefore) return { spans, injected: false };
    if (splitEnd.left.some((span) => span.kind === "math" || span.kind === "patchInsMath" || span.kind === "patchDelMath")) {
      return { spans, injected: false };
    }
    const body = viewSpansText(splitEnd.left);
    if (body.length === 0) return { spans, injected: false };
    return {
      spans: [
        ...splitStart.left,
        {
          kind: "patchMark",
          text: body,
          patchId: patch.id,
          op: patch.kind,
          marks: patch.marks ?? [],
          label: patch.label ?? markActionLabel(patch.kind, patch.marks ?? []),
        },
        ...splitEnd.right,
      ],
      injected: true,
    };
  };

  if (patch.range) {
    const textLength = Array.from(viewSpansOffsetText(spans)).length;
    const start = Math.max(0, Math.min(patch.range.start, textLength));
    const end = Math.max(start, Math.min(patch.range.end, textLength));
    const ranged = injectAt(start, end);
    if (ranged.injected) return ranged;
  }

  if (matchBefore.length > 0) {
    const text = viewSpansOffsetText(spans);
    const idx = text.indexOf(matchBefore);
    if (idx >= 0) {
      const matched = injectAt(
        Array.from(text.slice(0, idx)).length,
        Array.from(text.slice(0, idx + matchBefore.length)).length,
      );
      if (matched.injected) return matched;
    }
  }

  return { spans, injected: false };
}

type DiffBackedSuggestion = WireDocSuggestion & { diffHunk?: DiffHunk };

function suggestionDiffHunk(suggestion: WireDocSuggestion): DiffHunk | undefined {
  return (suggestion as DiffBackedSuggestion).diffHunk;
}

function markHunkOp(
  suggestion: WireDocSuggestion,
  hunk: DiffHunk | undefined,
): "markAdd" | "markRemove" | null {
  if (hunk?.op === "markAdd" || hunk?.op === "markRemove") return hunk.op;
  const stepType = suggestion.patch.steps[0]?.stepType;
  if (stepType === "addMark") return "markAdd";
  if (stepType === "removeMark") return "markRemove";
  return null;
}

function normalizePatchMarks(marks: DiffHunk["marks"] | undefined): PmMark[] {
  return Array.isArray(marks) ? (marks as PmMark[]) : [];
}

const MARK_LABELS: Record<string, string> = {
  bold: "加粗",
  italic: "斜体",
  underline: "下划线",
  strike: "删除线",
  code: "等宽",
  link: "链接",
  highlight: "高亮",
};

function markActionLabel(op: "markAdd" | "markRemove", marks: readonly PmMark[]): string {
  const names = marks.map((mark) => MARK_LABELS[mark.type] ?? mark.type).filter(Boolean);
  const target = names.length > 0 ? names.join("、") : "样式";
  return op === "markAdd" ? `将${target}` : `取消${target}`;
}

/* ───────────── Stream error + local UI actions ───────────── */

export interface StreamError {
  kind: "cancelled" | "failed" | "draftingFailed" | "docWriteConflict";
  reason: string;
  retriable?: boolean;
  statusCode?: number;
  category?: "auth" | "quota" | "request" | "rate_limit" | "timeout" | "upstream" | "network" | "blocked_address" | "unknown";
  userMessage?: string;
  action?: "retry" | "check_model_settings" | "check_balance" | "reload" | "none";
  actualDocumentSnapshot?: number;
}

export type WorkspaceLocalAction =
  | { kind: "streamErrorCleared" }
  | { kind: "streamErrorSet"; error: StreamError }
  | { kind: "retryDrafting"; streamId: string }
  | {
      kind: "streamTerminated";
      streamIds?: string[];
      reason: "stop" | "abort" | "error" | "completed";
    }
  | { kind: "viewingVersionSet"; version: number | null; versionId?: string | null }
  | { kind: "historySnapshotSet"; doc: ViewDocumentSnapshot | null }
  /** 前端是本期批注坐标与 accepted/ignored 状态的准源；本地事务用全量替换。 */
  | { kind: "annotationGroupsChanged"; groups: AnnotationGroup[] }
  /** 诊断 p01:手动编辑 updateDoc 保存成功后,把已保存的 PM 文档同步进
   * state.doc——此前只更新版本号,canonical 文档停留在手动编辑前,导致
   * 进入审阅/拒绝后界面回退、看似"回滚吞了手动编辑"。 */
  | { kind: "manualDocSaved"; pmDoc: PmDoc; version: number }
  /** Page-level commit: materialize all docSuggestion tool-calls with
   * verdict accepted/rejected into the doc body, flip their status to
   * committed, bump the version. Used by Stage B mock backend (a real
   * server would emit a documentSnapshotWritten + tool-call-updated stream
   * instead). */
  | { kind: "commitPatchVerdicts"; nextVersion: number }
  | {
      kind: "restoreAskUser";
      messageId: string;
      toolCall: ToolCallSpec;
      overlay: WireActiveOverlay;
      docState: DocState;
      agentBusy: boolean;
    }
  | { kind: "forceUnlockReview" }
  | { kind: "rewindChat"; keepMessageCount: number };

export type WorkspaceFrame = BridgeFrame;
export type WorkspaceAction = BridgeFrame | WorkspaceLocalAction;


/* ───────────── Convenience aliases ───────────── */

export type ViewChatMessage = WireChatMessage;
