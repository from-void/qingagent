/**
 * Workspace view-side facade over the wire contract.
 *
 * Stage A.5 hand-authored a kebab-case parallel protocol here. Group A
 * collapsed it: every wire shape now lives in `agent-contract` (Rust)
 * and is generated into `@qingagent/contract-ts`. This module re-exports
 * those wire types and adds only the view-layer rendering helpers
 * (DocSpan / LegacySection with patch overlays, DOC_EDITABLE policy,
 * WorkspaceFrame envelope including local UI actions).
 */

export type {
  AgentMessage,
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
import type { PmBlockNode, PmDiagramOverlay, PmDoc, PmInlineNode, PmMark, PmTableCellNode } from "@qingagent/pm-schema";

/** Map from `AskUserQuestion.id` to the user's answer. ts-rs doesn't
 * emit a type for the Rust `pub type AskUserAnswers = HashMap<...>`
 * alias, so we shadow it locally. */
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

export type ViewPatchTextSpan =
  | { kind: "patchDel"; text: string; patchId: string }
  | { kind: "patchIns"; text: string; patchId: string };

export type ViewDocSpan =
  | { kind: "text"; text: string; marks?: PmMark[] }
  | ViewPatchTextSpan
  | {
      kind: "patchMark";
      text: string;
      patchId: string;
      op: "markAdd" | "markRemove";
      marks: PmMark[];
      label: string;
    }
  | { kind: "selectable"; text: string };

export type ViewListRowDiff =
  | { status: "same"; spans: ViewDocSpan[]; checked?: boolean }
  | {
      status: "changed";
      spans: ViewDocSpan[];
      oldText: string;
      checked?: boolean;
      checkedChanged?: boolean;
    }
  | { status: "added"; spans: ViewDocSpan[]; checked?: boolean }
  | { status: "removed"; oldText: string; checked?: boolean };

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
>;

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
  | { kind: "quote"; text: string; spans?: ViewDocSpan[] }
  | { kind: "list"; ordered: boolean; items: string[]; itemSpans?: ViewDocSpan[][]; start?: number; rowDiff?: ViewListRowDiff[] }
  | { kind: "hr" }
  | {
      kind: "table";
      head: string[];
      rows: string[][];
      headSpans?: ViewDocSpan[][];
      rowSpans?: ViewDocSpan[][][];
      cellDiff?: ViewTableRowDiff[];
    }
  | { kind: "code"; body: string; language?: string | null }
  | { kind: "diagram"; source: string; lang: string; svg: string | null; overlay?: PmDiagramOverlay | null }
  | { kind: "penNote"; text: string; spans?: ViewDocSpan[] }
  | { kind: "image"; src: string; alt: string; caption: string | null; width: number | null; height: number | null; align?: "left" | "center" | "right" | null }
  | { kind: "fileAttachment"; fileId: string; filename: string; mimeType: string; size: number }
  // 审阅态保真块:携带原始 pm 节点,审核态直接用 PmBlockView 渲染(与最终态同一套渲染,
  // 保证"审核态展示=最终态展示")。这几类不接行内 patch(patchableSectionSpans 返回 null),
  // 只参与整块插入/删除(blockPatch)。`text` 仅作文本投影用(锚点回退/块级 patch 文本)。
  | { kind: "taskList"; node: PmBlockNode; text: string; rowDiff?: ViewListRowDiff[] }
  | { kind: "callout"; node: PmBlockNode; text: string; bodyDiff?: ViewBlockSeqDiff }
  | { kind: "columnList"; node: PmBlockNode; text: string; columnsDiff?: ViewBlockSeqDiff[] }
  | { kind: "math"; node: PmBlockNode; latex: string }
);

export interface ViewDocumentSnapshot {
  version: number;
  ts: string;
  sections: ViewBlock[];
  pmDoc?: PmDoc;
}

/** Convert a wire DocumentSnapshot into the view shape (P sections wrapped in
 * a single text span). Patch overlays are layered on top via
 * `applyPatchOverlaysWithReport` once the open `docSuggestion` tool-calls are
 * known to the reducer / page. */
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
      const text = pmInlineText(node.content ?? []);
      const textAlign = node.attrs.textAlign ?? undefined;
      if (node.attrs.level === 1) return [{ ...meta, kind: "h1", text, textAlign }];
      if (node.attrs.level === 2) {
        return [{ ...meta, kind: "h2", text, anchor: node.attrs.anchor ?? undefined, textAlign }];
      }
      return [{ ...meta, kind: `h${node.attrs.level}` as "h3" | "h4" | "h5" | "h6", text, textAlign }];
    }
    case "paragraph":
      return [{ ...meta, kind: "p", spans: [{ kind: "text", text: pmInlineText(node.content ?? []) }], textAlign: node.attrs.textAlign ?? undefined }];
    case "blockquote":
      return [{ ...meta, kind: "quote", text: node.content.map(pmBlockText).join("\n") }];
    case "bulletList":
    case "orderedList":
      return [{
        ...meta,
        kind: "list",
        ordered: node.type === "orderedList",
        ...(node.type === "orderedList" && typeof node.attrs.start === "number" ? { start: node.attrs.start } : {}),
        items: node.content.map((item) => item.content.map(pmBlockText).join("\n")),
        // 富 spans:保留加粗/链接等行内样式,审阅渲染优先消费(items 仍供文本派生)
        itemSpans: node.content.map((item) => pmBlocksInlineSpans(item.content)),
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
      return [{ ...meta, kind: "table", head, rows, headSpans, rowSpans }];
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
      return [{ ...meta, kind: "penNote", text: pmInlineText(node.content ?? []) }];
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
    const content = ("content" in block ? block.content : undefined) as
      | readonly { type: string; text?: string; marks?: PmMark[] }[]
      | undefined;
    for (const inline of content ?? []) {
      if (inline.type !== "text" || !inline.text) continue;
      spans.push(
        inline.marks && inline.marks.length > 0
          ? { kind: "text", text: inline.text, marks: inline.marks }
          : { kind: "text", text: inline.text },
      );
    }
  });
  return spans;
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
      return section.spans.map((span) => span.text).join("");
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

function viewSpansText(spans: readonly ViewDocSpan[]): string {
  return spans.map((span) => span.text).join("");
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

function sectionPatchMarkerSpans(section: ViewBlock): ViewDocSpan[] | null {
  const spans = patchableSectionSpans(section) ?? [];
  const marker = section.blockPatch?.marker;
  if (!marker) return spans.length > 0 ? spans : null;
  return [...spans, marker];
}

function withPatchableSectionSpans(section: ViewBlock, spans: ViewDocSpan[]): ViewBlock {
  switch (section.kind) {
    case "p":
      return { ...section, spans };
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "quote":
    case "penNote":
      return { ...section, spans };
    default:
      return section;
  }
}

function blockPatchMarkerText(section: ViewBlock, op: "insert" | "delete"): string {
  const prefix = op === "insert" ? "新增" : "删除";
  switch (section.kind) {
    case "list":
      return `${prefix}列表`;
    case "table":
      return `${prefix}表格`;
    case "code":
      return `${prefix}代码块`;
    case "diagram":
      return `${prefix}图表`;
    case "image":
      return `${prefix}图片`;
    case "hr":
      return `${prefix}分隔线`;
    case "fileAttachment":
      return `${prefix}附件`;
    case "quote":
      return `${prefix}引用`;
    case "penNote":
      return `${prefix}批注`;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${prefix}标题`;
    case "p":
      return `${prefix}段落`;
    case "taskList":
      return `${prefix}待办`;
    case "callout":
      return `${prefix}提示`;
    case "columnList":
      return `${prefix}分栏`;
    case "math":
      return `${prefix}公式`;
  }
}

/** 词级 diff 段:对 old/new 做逐字符 LCS,合并相邻同类为段。
 *  same=两边都有(未改),ins=只在新文本(新增),del=只在旧文本(删除)。
 *  多区段(不再是单一公共前后缀),能把分散的多处改动各自标出来。 */
export type WordDiffSeg = { type: "same" | "ins" | "del"; text: string };

export function wordDiffSegments(oldText: string, newText: string): WordDiffSeg[] {
  if (oldText === newText) return oldText ? [{ type: "same", text: oldText }] : [];
  const raw = lcsDiff(Array.from(oldText), Array.from(newText), (x, y) => x === y);
  const segs: WordDiffSeg[] = [];
  const push = (type: WordDiffSeg["type"], ch: string) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += ch;
    else segs.push({ type, text: ch });
  };
  for (const op of raw) {
    if (op.kind === "same") push("same", op.b ?? op.a ?? "");
    else if (op.kind === "add") push("ins", op.b ?? "");
    else push("del", op.a ?? "");
  }
  return segs;
}

/** 新内容的行内 spans:未改段为普通文本、新增段为 patchIns(绿)。删除段不进新内容(在 hover 看)。 */
export function inlineWordDiffSpans(oldText: string, newText: string, patchId: string): ViewDocSpan[] {
  const spans: ViewDocSpan[] = [];
  for (const seg of wordDiffSegments(oldText, newText)) {
    if (seg.type === "del") continue;
    if (seg.type === "same") spans.push({ kind: "text", text: seg.text });
    else spans.push({ kind: "patchIns", text: seg.text, patchId });
  }
  return spans.length > 0 ? spans : (newText ? [{ kind: "text", text: newText }] : []);
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
type TextDiffPmBlock = Extract<PmBlockNode, { type: "paragraph" | "heading" | "penNote" }>;

type ListRowData = {
  text: string;
  spans: ViewDocSpan[];
  checked?: boolean;
};

type TableCellData = {
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
    return node.content.map((item) => ({
      text: item.content.map(pmBlockText).join("\n"),
      spans: pmBlocksInlineSpans(item.content),
      checked: item.attrs.checked,
    }));
  }
  return node.content.map((item) => ({
    text: item.content.map(pmBlockText).join("\n"),
    spans: pmBlocksInlineSpans(item.content),
  }));
}

function tableRowsFromPmBlock(node: TablePmBlock): TableRowData[] {
  return node.content.map((row) => {
    const cells = row.content.map((cell) => ({
      text: pmCellText(cell),
      spans: pmBlocksInlineSpans(cell.content),
    }));
    return {
      text: cells.map((cell) => cell.text).join("\t"),
      cells,
    };
  });
}

function cloneSpans(spans: readonly ViewDocSpan[]): ViewDocSpan[] {
  return spans.map((span) => ({ ...span }));
}

function patchInsSpansForRow(row: ListRowData, patchId: string): ViewDocSpan[] {
  return row.text ? [{ kind: "patchIns", text: row.text, patchId }] : [];
}

function listRowTextSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  const dp: number[][] = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = left[i] === right[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp[0]![0]! / Math.max(left.length, right.length);
}

function shouldPairListRowsAsChanged(before: ListRowData, after: ListRowData): boolean {
  if (before.text === after.text) return true;
  return listRowTextSimilarity(before.text, after.text) >= 0.5;
}

function changedListRow(before: ListRowData, after: ListRowData, patchId: string): ViewListRowDiff {
  const checkedChanged =
    typeof before.checked === "boolean" &&
    typeof after.checked === "boolean" &&
    before.checked !== after.checked;
  const spans = before.text === after.text
    ? cloneSpans(after.spans)
    : inlineWordDiffSpans(before.text, after.text, patchId);
  return {
    status: "changed",
    spans,
    oldText: before.text,
    ...(typeof after.checked === "boolean" ? { checked: after.checked } : {}),
    ...(checkedChanged ? { checkedChanged } : {}),
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
        typeof before.checked === "boolean" &&
        typeof after.checked === "boolean" &&
        before.checked !== after.checked
      ) {
        out.push(changedListRow(before, after, patchId));
      } else {
        out.push({
          status: "same",
          spans: cloneSpans(after.spans),
          ...(typeof after.checked === "boolean" ? { checked: after.checked } : {}),
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
      if (before && after && shouldPairListRowsAsChanged(before, after)) {
        out.push(changedListRow(before, after, patchId));
        removeIndex += 1;
        addIndex += 1;
        continue;
      }
      if (before) {
        out.push({
          status: "removed",
          oldText: before.text,
          ...(typeof before.checked === "boolean" ? { checked: before.checked } : {}),
        });
        removeIndex += 1;
        continue;
      }
      if (after) {
        out.push({
          status: "added",
          spans: patchInsSpansForRow(after, patchId),
          ...(typeof after.checked === "boolean" ? { checked: after.checked } : {}),
        });
        addIndex += 1;
      }
    }
  }
  return out;
}

function withListRowDiff(block: ViewBlock, rowDiff: ViewListRowDiff[]): ViewBlock {
  if (block.kind === "list") return { ...block, rowDiff };
  if (block.kind === "taskList") return { ...block, rowDiff };
  return block;
}

function tableRowTextSimilarity(a: string, b: string): number {
  return listRowTextSimilarity(a, b);
}

function shouldPairTableRowsAsChanged(before: TableRowData, after: TableRowData): boolean {
  if (before.text === after.text) return true;
  const sameColumnCount = before.cells.length === after.cells.length;
  const sameCellCount = before.cells.filter((cell, index) => cell.text === after.cells[index]?.text).length;
  return (sameColumnCount && sameCellCount > 0) || tableRowTextSimilarity(before.text, after.text) >= 0.5;
}

function sameTableCell(cell: TableCellData): ViewTableCellDiff {
  return { status: "same", spans: cloneSpans(cell.spans) };
}

function changedTableCell(before: TableCellData | undefined, after: TableCellData | undefined, patchId: string): ViewTableCellDiff {
  const oldText = before?.text ?? "";
  const newText = after?.text ?? "";
  return {
    status: "changed",
    oldText,
    spans: inlineWordDiffSpans(oldText, newText, patchId),
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
    if (beforeCell && afterCell && beforeCell.text === afterCell.text) {
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
      out.push({
        status: "same",
        cells: current.b!.cells.map(sameTableCell),
      });
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
      if (before && after && shouldPairTableRowsAsChanged(before, after)) {
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

function withTableCellDiff(block: ViewBlock, cellDiff: ViewTableRowDiff[]): ViewBlock {
  if (block.kind === "table") return { ...block, cellDiff };
  return block;
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
  const rowDiff = buildListRowDiff(
    listRowsFromPmBlock(beforeNode),
    listRowsFromPmBlock(afterNode),
    input.patchId,
  );
  return {
    ...input,
    op: "replace",
    blocks: [withListRowDiff(afterBlock, rowDiff)],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
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
  const cellDiff = buildTableCellDiff(
    tableRowsFromPmBlock(beforeNode),
    tableRowsFromPmBlock(afterNode),
    input.patchId,
  );
  return {
    ...input,
    op: "replace",
    blocks: [withTableCellDiff(afterBlock, cellDiff)],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
  };
}

function containerBlockTextSimilarity(beforeNode: PmBlockNode, afterNode: PmBlockNode): number {
  return listRowTextSimilarity(pmBlockText(beforeNode), pmBlockText(afterNode));
}

function shouldPairContainerBlocksAsChanged(beforeNode: PmBlockNode, afterNode: PmBlockNode): boolean {
  if (isTextDiffPmBlock(beforeNode) && isTextDiffPmBlock(afterNode) && beforeNode.type === afterNode.type) {
    return containerBlockTextSimilarity(beforeNode, afterNode) >= 0.5;
  }
  if (isListPmBlock(beforeNode) && isListPmBlock(afterNode) && beforeNode.type === afterNode.type) {
    return true;
  }
  return isTablePmBlock(beforeNode) && isTablePmBlock(afterNode);
}

function changedContainerBlock(
  beforeNode: PmBlockNode,
  afterNode: PmBlockNode,
  patchId: string,
): ViewBlockSeqDiff[number] | null {
  if (isTextDiffPmBlock(beforeNode) && isTextDiffPmBlock(afterNode) && beforeNode.type === afterNode.type) {
    const oldText = pmBlockText(beforeNode);
    const newText = pmBlockText(afterNode);
    return {
      status: "changed",
      kind: "text",
      node: afterNode,
      oldText,
      spans: inlineWordDiffSpans(oldText, newText, patchId),
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
  return null;
}

function buildBlockSeqDiff(
  beforeNodes: readonly PmBlockNode[],
  afterNodes: readonly PmBlockNode[],
  patchId: string,
): ViewBlockSeqDiff {
  const raw = lcsDiff(beforeNodes, afterNodes, (before, after) => pmBlockText(before) === pmBlockText(after));
  const out: ViewBlockSeqDiff = [];
  let i = 0;
  while (i < raw.length) {
    const current = raw[i]!;
    if (current.kind === "same") {
      out.push({ status: "same", block: current.b! });
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
      if (beforeNode && afterNode && shouldPairContainerBlocksAsChanged(beforeNode, afterNode)) {
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

function withColumnListColumnsDiff(block: ViewBlock, columnsDiff: ViewBlockSeqDiff[]): ViewBlock {
  if (block.kind === "columnList") return { ...block, columnsDiff };
  return block;
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
  return {
    ...input,
    op: "replace",
    blocks: [withCalloutBodyDiff(afterBlock, buildBlockSeqDiff(beforeNode.content, afterNode.content, input.patchId))],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
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
  const columnsDiff = afterNode.content.map((afterColumn, columnIndex) =>
    buildBlockSeqDiff(beforeNode.content[columnIndex]?.content ?? [], afterColumn.content, input.patchId),
  );
  if (beforeNode.content.length > afterNode.content.length && columnsDiff.length > 0) {
    const tailRemoved = beforeNode.content.slice(afterNode.content.length).flatMap((column) =>
      column.content.map((block): ViewBlockSeqDiff[number] => ({ status: "removed", oldText: pmBlockText(block) })),
    );
    columnsDiff[columnsDiff.length - 1] = [...columnsDiff[columnsDiff.length - 1]!, ...tailRemoved];
  }
  return {
    ...input,
    op: "replace",
    blocks: [withColumnListColumnsDiff(afterBlock, columnsDiff)],
    replaceBeforeBlocks: [beforeBlock],
    blockCount: 1,
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
  for (let i = 0; i < doc.sections.length; i++) {
    const section = doc.sections[i];
    if (!section || !patchableSectionSpans(section)) continue;
    const text = viewSectionText(section);
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
      from = idx + Math.max(1, quote.length);
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
      const blockEnd = blockStart + pmBlockText(block).length;
      if (
        block.attrs.blockId === suggestion.anchor.blockId &&
        isPatchRenderablePmBlock(block) &&
        suggestion.anchor.pmFrom >= blockStart &&
        suggestion.anchor.pmTo <= blockEnd
      ) {
        const viewSection = doc.sections[viewSectionIndex];
        if (viewSection && patchableSectionSpans(viewSection)) {
          const text = viewSectionText(viewSection);
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
}

/** 行内文本通道能保真渲染的 PM 块类型(spans 模式);结构块都不在此列。 */
const INLINE_SAFE_PM_TYPES = new Set(["paragraph", "heading", "blockquote", "penNote"]);
/** 行内节点类型:纯文本 replace 的 hunk.before/after 是「行内切片」(text/hardBreak),
 * 本就属行内、该走行内文本通道。此前漏列 → pmNodesInlineSafe 误判其为结构块 → 内联通道返 null、
 * 块通道(pmNodesToViewBlocks 过滤行内节点)又返 [] → 纯文本改动被双通道丢弃(表现为"无法定位")。
 * 实证:packages/core buildDraftDiff 对段内文本 replace 产出的 before=[{type:"text",...}](见
 * proposalDiff inlineSliceAsNodes)。结构块(表格/列表/代码)的 replace 仍是块节点、不在此集 → 照旧落块通道。
 * 注意:**故意不含 inlineMath** —— 生成端把公式投影为 U+FFFC、前端视图投影为 latex 文本,offset 口径
 * 不一致,放行后 overlay 会生成但 spliceSpans 定位不到/打错位置(round-3 实证)。公式 replace 暂维持
 * 落块通道(其本身定位也待修),不在行内放行,避免"看似可审实则改错位置"。 */
const INLINE_NODE_PM_TYPES = new Set(["text", "hardBreak"]);

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
  const before = hunk?.beforeText ?? suggestion.preview.deleteText;
  const after = hunk?.afterText ?? suggestion.preview.insertText;
  return {
    id: suggestion.id,
    reviewBatchId: suggestion.reviewBatchId ?? hunk?.reviewBatchId ?? suggestion.id,
    groupMode: suggestion.groupMode ?? hunk?.groupMode ?? "independent",
    ...(order !== undefined ? { order } : {}),
    before,
    after,
    blockIndex: target.blockIndex,
    range: target.range,
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
 * 复数版补上 replace 通道:渲染为"删旧块 + 插新块"的可视对(旧块红、新块绿,
 * 共享同一 patchId,点任一侧都作用于同一条 suggestion)。insert/delete 仍是
 * 单条,行为与单数版一致。
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
    });
  }
  return inputs;
}

/**
 * 把 patch 折进文档,并**如实报告**哪些 patch 真正落地(产出了 patchDel/patchIns 标记)、
 * 哪些因锚点匹配失败被丢弃。dropped 非空即意味着"正文会比意图少几处"——这是
 * 数量不一致(左侧计数 ≠ 正文处数 ≠ 序号)的根因,必须能被发现。
 */
export function applyPatchOverlaysWithReport(
  doc: ViewDocumentSnapshot,
  patches: ReadonlyArray<PatchOverlayInput>,
): { doc: ViewDocumentSnapshot; appliedIds: Set<string>; droppedIds: string[] } {
  const appliedIds = new Set<string>();
  if (patches.length === 0) return { doc, appliedIds, droppedIds: [] };
  const activePatches = patches.filter((patch) => patch.conflict !== true);

  const patchesBySection = new Map<number, PatchOverlayInput[]>();
  for (const patch of activePatches) {
    const sectionPatches = patchesBySection.get(patch.blockIndex) ?? [];
    sectionPatches.push(patch);
    patchesBySection.set(patch.blockIndex, sectionPatches);
  }

  const sections = doc.sections.map((section, blockIndex): ViewBlock => {
    const baseSpans = patchableSectionSpans(section);
    if (!baseSpans) return section;
    const scopedPatches = patchesBySection.get(blockIndex);
    if (!scopedPatches || scopedPatches.length === 0) return section;

    let spans: ViewDocSpan[] = baseSpans;
    const orderedPatches = scopedPatches.slice().sort((a, b) => {
      const ar = a.range?.start;
      const br = b.range?.start;
      if (ar == null || br == null) return 0;
      return br - ar;
    });
    for (const patch of orderedPatches) {
      const result = spliceSpans(spans, patch);
      spans = result.spans;
      if (result.injected) appliedIds.add(patch.id);
    }
    return withPatchableSectionSpans(section, spans);
  });

  const droppedIds = patches
    .filter((p) => p.conflict !== true)
    .filter((p) => !appliedIds.has(p.id))
    .map((p) => p.id);
  return { doc: { ...doc, sections }, appliedIds, droppedIds };
}

export function applyBlockPatchOverlays(
  doc: ViewDocumentSnapshot,
  inputs: ReadonlyArray<BlockPatchInput>,
): { doc: ViewDocumentSnapshot; appliedIds: Set<string>; droppedIds: string[] } {
  if (inputs.length === 0) return { doc, appliedIds: new Set(), droppedIds: [] };
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
    sections[targetIndex] = withReplaceBlockPatch(input.blocks[0]!, input);
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
    for (let i = targetIndex; i < targetIndex + count; i += 1) {
      const section = sections[i];
      if (section) sections[i] = withBlockPatch(section, input, "delete");
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
    sections.splice(
      insertAt,
      0,
      ...insertion.input.blocks.map((block) => withBlockPatch(block, insertion.input, "insert")),
    );
    insertOffset += insertion.input.blocks.length;
    appliedIds.add(insertion.input.patchId);
  }

  return { doc: { ...doc, sections }, appliedIds, droppedIds };
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

function withReplaceBlockPatch(section: ViewBlock, input: BlockPatchInput): ViewBlock {
  const cloned = cloneViewBlock(section);
  const beforeBlock = input.replaceBeforeBlocks?.[0];
  return {
    ...cloned,
    blockPatch: {
      patchId: input.patchId,
      op: "replace",
      ...(beforeBlock ? { beforeBlock: cloneViewBlock(beforeBlock) } : {}),
    },
  };
}

function withBlockPatch(section: ViewBlock, input: BlockPatchInput, op: "insert" | "delete"): ViewBlock {
  const cloned = cloneViewBlock(section);
  const patchSpan: ViewPatchTextSpan = {
    kind: op === "insert" ? "patchIns" : "patchDel",
    text: viewSectionText(cloned),
    patchId: input.patchId,
  };
  const blockPatch: ViewBlockPatch = {
    patchId: input.patchId,
    op,
  };

  switch (cloned.kind) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "p":
    case "quote":
    case "penNote":
      if (patchSpan.text.length > 0) {
        return { ...cloned, blockPatch, spans: [patchSpan] } as ViewBlock;
      }
      break;
  }

  return {
    ...cloned,
    blockPatch: {
      ...blockPatch,
      marker: {
        kind: op === "insert" ? "patchIns" : "patchDel",
        text: blockPatchMarkerText(cloned, op),
        patchId: input.patchId,
      },
    },
  };
}

function cloneViewBlock(section: ViewBlock): ViewBlock {
  const meta = {
    ...(section.blockId ? { blockId: section.blockId } : {}),
    ...(section.blockPatch ? { blockPatch: cloneBlockPatch(section.blockPatch) } : {}),
  };
  switch (section.kind) {
    case "h1":
      return { ...meta, kind: "h1", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "h2":
      return { ...meta, kind: "h2", text: section.text, anchor: section.anchor, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return { ...meta, kind: section.kind, text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "p":
      return { ...meta, kind: "p", spans: section.spans.map((span) => ({ ...span })) };
    case "quote":
      return { ...meta, kind: "quote", text: section.text, ...(section.spans ? { spans: section.spans.map((span) => ({ ...span })) } : {}) };
    case "list":
      return {
        ...meta,
        kind: "list",
        ordered: section.ordered,
        ...(section.start != null ? { start: section.start } : {}),
        items: section.items.slice(),
        ...(section.itemSpans ? { itemSpans: section.itemSpans.map(cloneSpans) } : {}),
        ...(section.rowDiff ? { rowDiff: cloneListRowDiff(section.rowDiff) } : {}),
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
      };
    case "code":
      return { ...meta, kind: "code", body: section.body, language: section.language ?? null };
    case "diagram":
      return { ...meta, kind: "diagram", source: section.source, lang: section.lang, svg: section.svg };
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
        ...(section.columnsDiff ? { columnsDiff: section.columnsDiff.map(cloneBlockSeqDiff) } : {}),
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

function cloneListRowDiff(rowDiff: readonly ViewListRowDiff[]): ViewListRowDiff[] {
  return rowDiff.map((row): ViewListRowDiff => {
    switch (row.status) {
      case "same":
        return {
          status: "same",
          spans: cloneSpans(row.spans),
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
        };
      case "changed":
        return {
          status: "changed",
          spans: cloneSpans(row.spans),
          oldText: row.oldText,
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
          ...(row.checkedChanged ? { checkedChanged: true } : {}),
        };
      case "added":
        return {
          status: "added",
          spans: cloneSpans(row.spans),
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
        };
      case "removed":
        return {
          status: "removed",
          oldText: row.oldText,
          ...(typeof row.checked === "boolean" ? { checked: row.checked } : {}),
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

export interface AppliedPatch {
  id: string;
  reviewBatchId: string;
  groupMode: "atomic" | "independent";
  before: string;
  after: string;
  kind: "text" | "markAdd" | "markRemove" | "insert" | "delete" | "replace";
  marks?: PmMark[];
  label?: string;
  /** 连续序号,1 起,只对真正落地的 patch 编号(无空洞)。 */
  index: number;
}

export interface ReviewPatchGroup {
  reviewBatchId: string;
  groupMode: "atomic" | "independent";
  patchIds: string[];
  index: number;
}

/**
 * 审批态 patch 呈现的**单一真相源**:对 baseline 文档折叠 patch,产出
 * - `doc`:带 patchDel/patchIns 标记的文档;
 * - `applied`:真正落地的 patch(含连续序号),计数 / 序号 / 正文标记都从这里派生;
 * - `droppedIds`:锚点失败被丢弃的 patch(完整性缺口,需被发现)。
 *
 * 这样"左侧已修改 N 处 / 正文标记 / 悬浮序号"三者同源,天然一致,不会再出现
 * "说 4 处实际 3 处、序号缺 1"的错乱。
 */
export function derivePatchPresentation(
  doc: ViewDocumentSnapshot,
  patches: ReadonlyArray<PatchOverlayInput>,
  blockPatches: ReadonlyArray<BlockPatchInput> = [],
): {
  doc: ViewDocumentSnapshot;
  applied: AppliedPatch[];
  groups: ReviewPatchGroup[];
  appliedGroupIds: Set<string>;
  appliedIds: Set<string>;
  droppedIds: string[];
  conflictIds: string[];
} {
  const conflictIds = patches
    .filter((patch) => patch.conflict === true)
    .map((patch) => patch.id);
  const { doc: overlaidDoc, appliedIds, droppedIds } = applyPatchOverlaysWithReport(
    doc,
    patches,
  );
  const {
    doc: blockPatchedDoc,
    appliedIds: blockAppliedIds,
    droppedIds: blockDroppedIds,
  } = applyBlockPatchOverlays(overlaidDoc, blockPatches);
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
  return {
    doc: blockPatchedDoc,
    applied,
    groups,
    appliedGroupIds: new Set(groups.map((group) => group.reviewBatchId)),
    appliedIds: allAppliedIds,
    droppedIds: [...droppedIds, ...blockDroppedIds],
    conflictIds,
  };
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

/** 扫文档,只收集 patchDel/patchIns/patchMark span 携带的 distinct patchId(= 正文实际可见的处)。 */
export function collectPatchMarkerIds(doc: ViewDocumentSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const section of doc.sections) {
    if (section.blockPatch?.op === "replace") ids.add(section.blockPatch.patchId);
    const spans = sectionPatchMarkerSpans(section);
    if (!spans) continue;
    for (const span of spans) {
      if (span.kind === "patchDel" || span.kind === "patchIns") ids.add(span.patchId);
      if (span.kind === "patchMark") ids.add(span.patchId);
    }
  }
  return ids;
}

/**
 * 内部一致性自检("沉淀的验证方法"):派生结果必须满足
 * 1. 决策组序号连续 1..N(同组多 hunk 可共享序号);
 * 2. 正文标记 id 集合 === applied id 集合(不多不少);
 * 3. 计数(applied 数)=== 正文 distinct 标记数。
 *
 * 这是 derivePatchPresentation 的**不变量**,任何场景都应返回空数组。返回非空 =
 * 数数逻辑出 bug,开发态据此报警、单测据此断言——"一旦数量不对,自己立刻知道"。
 *
 * 注意:这里只查"内部一致性"(显示给用户的数全都自洽)。完整性缺口(droppedIds 非空,
 * 即正文比 agent 意图少几处)单独通过 droppedIds 暴露,不计入本函数。
 */
export function checkPatchPresentationConsistency(p: {
  doc: ViewDocumentSnapshot;
  applied: AppliedPatch[];
  appliedIds: Set<string>;
}): string[] {
  const violations: string[] = [];

  const uniqueIndexes = [...new Set(p.applied.map((a) => a.index))].sort((a, b) => a - b);
  uniqueIndexes.forEach((index, i) => {
    if (index !== i + 1) {
      violations.push(`组序号不连续:第 ${i} 个组 index=${index}(应为 ${i + 1})`);
    }
  });

  const markerIds = collectPatchMarkerIds(p.doc);
  for (const id of markerIds) {
    if (!p.appliedIds.has(id)) violations.push(`正文标记 ${id} 不在 applied 集合`);
  }
  for (const a of p.applied) {
    if (!markerIds.has(a.id)) violations.push(`applied ${a.id} 在正文无标记`);
  }
  if (markerIds.size !== p.applied.length) {
    violations.push(
      `计数不一致:正文标记 ${markerIds.size} 处,applied ${p.applied.length} 处`,
    );
  }

  return violations;
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
      .map((s) => ("text" in s ? s.text : ""))
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
  },
): { spans: ViewDocSpan[]; injected: boolean } {
  if (patch.kind === "markAdd" || patch.kind === "markRemove") {
    return spliceMarkSpans(spans, patch as PatchOverlayInput & { kind: "markAdd" | "markRemove" });
  }

  const out: ViewDocSpan[] = [];
  let injected = false;
  for (const s of spans) {
    if (injected || s.kind !== "text") {
      out.push(s);
      continue;
    }

    if (patch.range) {
      const chars = Array.from(s.text);
      const start = Math.max(0, Math.min(patch.range.start, chars.length));
      const end = Math.max(start, Math.min(patch.range.end, chars.length));
      const rangedBefore = chars.slice(start, end).join("");
      if (rangedBefore === patch.before) {
        const head = chars.slice(0, start).join("");
        const tail = chars.slice(end).join("");
        const didInject = patch.before.length > 0 || patch.after.length > 0;
        if (didInject) {
          if (head.length > 0) out.push({ kind: "text", text: head });
          if (patch.before.length > 0) {
            out.push({ kind: "patchDel", text: patch.before, patchId: patch.id });
          }
          if (patch.after.length > 0) {
            out.push({ kind: "patchIns", text: patch.after, patchId: patch.id });
          }
          if (tail.length > 0) out.push({ kind: "text", text: tail });
          injected = true;
          continue;
        }
      }
    }

    // Case A (original path): `before` found in text — splice patchDel + patchIns.
    // Skip when the doc already contains the edited text (i.e. `after`
    // starts with `before` and the full `after` text appears at the same
    // position) — that scenario is handled by Case B.
    if (patch.before !== "") {
      const idx = s.text.indexOf(patch.before);
      if (idx >= 0) {
        const isEditedDoc =
          patch.after.length > patch.before.length &&
          patch.after.startsWith(patch.before) &&
          s.text.startsWith(patch.after, idx);
        if (!isEditedDoc) {
          const head = s.text.slice(0, idx);
          const tail = s.text.slice(idx + patch.before.length);
          if (head.length > 0) out.push({ kind: "text", text: head });
          out.push({ kind: "patchDel", text: patch.before, patchId: patch.id });
          if (patch.after.length > 0)
            out.push({ kind: "patchIns", text: patch.after, patchId: patch.id });
          if (tail.length > 0) out.push({ kind: "text", text: tail });
          injected = true;
          continue;
        }
      }
    }

    // Case B: `before` not found but `after` is non-empty — the doc
    // already contains the edited text. Wrap the `after` text as a
    // patchIns span (no patchDel needed).
    if (!injected && patch.after.length > 0) {
      const idxAfter = s.text.indexOf(patch.after);
      if (idxAfter >= 0) {
        const head = s.text.slice(0, idxAfter);
        const tail = s.text.slice(idxAfter + patch.after.length);
        if (head.length > 0) out.push({ kind: "text", text: head });
        out.push({ kind: "patchIns", text: patch.after, patchId: patch.id });
        if (tail.length > 0) out.push({ kind: "text", text: tail });
        injected = true;
        continue;
      }
    }

    // Case C: pure deletion (after="") — the doc has a zero-width space
    // marker (​) at the deletion point. Find it and emit a
    // zero-length patchDel span.
    if (!injected && patch.after === "" && patch.before !== "") {
      const zwsIdx = s.text.indexOf("​");
      if (zwsIdx >= 0) {
        const head = s.text.slice(0, zwsIdx);
        const tail = s.text.slice(zwsIdx + 1); // skip the ZWS character
        if (head.length > 0) out.push({ kind: "text", text: head });
        out.push({ kind: "patchDel", text: patch.before, patchId: patch.id });
        if (tail.length > 0) out.push({ kind: "text", text: tail });
        injected = true;
        continue;
      }
    }

    out.push(s);
  }
  return { spans: out, injected };
}

function spliceMarkSpans(
  spans: ViewDocSpan[],
  patch: PatchOverlayInput & { kind: "markAdd" | "markRemove" },
): { spans: ViewDocSpan[]; injected: boolean } {
  const out: ViewDocSpan[] = [];
  let injected = false;
  for (const s of spans) {
    if (injected || s.kind !== "text") {
      out.push(s);
      continue;
    }

    const injectAt = (start: number, end: number) => {
      const chars = Array.from(s.text);
      const head = chars.slice(0, start).join("");
      const body = chars.slice(start, end).join("");
      const tail = chars.slice(end).join("");
      if (body.length === 0) return false;
      if (head.length > 0) out.push({ kind: "text", text: head });
      out.push({
        kind: "patchMark",
        text: body,
        patchId: patch.id,
        op: patch.kind,
        marks: patch.marks ?? [],
        label: patch.label ?? markActionLabel(patch.kind, patch.marks ?? []),
      });
      if (tail.length > 0) out.push({ kind: "text", text: tail });
      injected = true;
      return true;
    };

    if (patch.range) {
      const chars = Array.from(s.text);
      const start = Math.max(0, Math.min(patch.range.start, chars.length));
      const end = Math.max(start, Math.min(patch.range.end, chars.length));
      const rangedBefore = chars.slice(start, end).join("");
      if (rangedBefore === patch.before && injectAt(start, end)) continue;
    }

    if (patch.before.length > 0) {
      const idx = s.text.indexOf(patch.before);
      if (idx >= 0) {
        const start = codeUnitOffsetToCharIndex(s.text, idx);
        const end = start + Array.from(patch.before).length;
        if (injectAt(start, end)) continue;
      }
    }

    out.push(s);
  }
  return { spans: out, injected };
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
  category?: "auth" | "quota" | "rate_limit" | "timeout" | "upstream" | "network" | "unknown";
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
