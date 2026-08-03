import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { DEFAULT_DRAWIO_SOURCE } from "@qingagent/pm-schema";
import type { DrawioEditorResult } from "./drawioEmbedProtocol";
import type { AiModifyTarget } from "../data/aiModifyTarget";
import { formatKey } from "../../../overlays/settings/shortcutsRegistry";
import { pickFile } from "./doc/pickFile";
import { insertFileAsset, insertImageAsset } from "../data/insertUploadedAsset";
import { uploadFailureMessage } from "../data/uploadAsset";
import { AlignIcon, CaretIcon, CheckIcon } from "./icons";
import { headingLevelLabel, HeadingLevelPicker } from "./HeadingLevelPicker";
import type { AlignVariant } from "./icons";
import { openDrawioEditor } from "./drawioEditorLauncher";
import {
  createDrawioBlockId,
  writeDrawioResultByBlockId,
} from "./drawioDocumentWriteback";
import { TableSizePicker, type TableSize } from "./doc/TableSizePicker";
import {
  resolveCenteredFloatingPosition,
  shouldFlipDropdownUp,
  type FloatingAnchorRect,
} from "../data/floatingPosition";
import {
  TOOLBAR_HIGHLIGHT_COLORS,
  TOOLBAR_TEXT_COLORS,
  TOOLBAR_THEME_COLORS,
  type ToolbarThemeColorKey,
  isToolbarCommandEnabled,
  normalizeToolbarHighlightColor,
  normalizeToolbarTextColor,
  resolveToolbarUnlockConfig,
} from "../data/toolbarUnlock";
import { useToolbarLinkEditor } from "./doc/ToolbarLinkEditor";
import {
  createDefaultColumnListNode,
  createDefaultTableNode,
  insertStructureNodeAtSelection,
} from "./doc/structureNodes";

interface ToolbarPos {
  top: number;
  left: number;
  /** 浮条落在选区上方还是下方——下方时 caret 翻向朝上。 */
  placement: "above" | "below";
}

export interface DocToolbarProps {
  active: boolean;
  editor: Editor | null;
  containerSelector: string;
  onAiModify: (target: AiModifyTarget) => Promise<boolean>;
  onToast?: (message: string) => void;
}

export interface SavedAiSelection {
  text: string;
  location: string;
  from: number;
  to: number;
  selectionRefs?: string[];
}

type OrderedListStyle = "decimal" | "lower-alpha" | "upper-alpha" | "lower-roman" | "upper-roman";

const ORDERED_LIST_STYLE_OPTIONS: Array<{ value: OrderedListStyle; label: string; marker: string }> = [
  { value: "decimal", label: "数字序号", marker: "1." },
  { value: "lower-alpha", label: "小写字母序号", marker: "a." },
  { value: "upper-alpha", label: "大写字母序号", marker: "A." },
  { value: "lower-roman", label: "小写罗马序号", marker: "i." },
  { value: "upper-roman", label: "大写罗马序号", marker: "I." },
];

const COMMAND_SHORTCUTS: Record<string, string[]> = {
  bold: ["Mod", "B"],
  italic: ["Mod", "I"],
  underline: ["Mod", "U"],
  strikeThrough: ["Mod", "Shift", "S"],
  code: ["Mod", "E"],
  bulletList: ["Mod", "Shift", "8"],
  orderedList: ["Mod", "Shift", "7"],
  blockquote: ["Mod", "Shift", "B"],
  codeBlock: ["Mod", "Alt", "C"],
  // 标题 1~6 走 TipTap Heading 扩展内建的 Mod-Alt-N
  heading1: ["Mod", "Alt", "1"],
  heading2: ["Mod", "Alt", "2"],
  heading3: ["Mod", "Alt", "3"],
  heading4: ["Mod", "Alt", "4"],
  heading5: ["Mod", "Alt", "5"],
  heading6: ["Mod", "Alt", "6"],
};

export type SavedToolbarSelection =
  | { kind: "text"; anchor: number; head: number }
  | { kind: "node"; anchor: number };

/** 保存 PM 选区的方向与类型；CellSelection 使用独立表格工具栏，不进入正文工具栏恢复链路。 */
export function captureToolbarSelection(editor: Pick<Editor, "state">): SavedToolbarSelection | null {
  const selection = editor.state.selection;
  if (selection instanceof TextSelection) {
    return { kind: "text", anchor: selection.anchor, head: selection.head };
  }
  if (selection instanceof NodeSelection) {
    return { kind: "node", anchor: selection.anchor };
  }
  return null;
}

/** 用当前文档重新 resolve 两端，避免浮层接管焦点后命令落到塌陷光标。 */
export function restoreToolbarSelection(
  editor: Pick<Editor, "state" | "view">,
  saved: SavedToolbarSelection,
): boolean {
  const doc = editor.state.doc;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.content.size));
  try {
    const selection = saved.kind === "text"
      ? TextSelection.between(doc.resolve(clamp(saved.anchor)), doc.resolve(clamp(saved.head)))
      : NodeSelection.create(doc, clamp(saved.anchor));
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    return true;
  } catch {
    return false;
  }
}

function normalizeOrderedListStyle(value: unknown): OrderedListStyle | null {
  return ORDERED_LIST_STYLE_OPTIONS.some((item) => item.value === value) ? (value as OrderedListStyle) : null;
}

export function toolbarTitle(label: string, command: string): string {
  const keys = COMMAND_SHORTCUTS[command];
  return keys ? `${label} (${keys.map(formatKey).join("+")})` : label;
}

export function reportToolbarCommandResult(
  ok: boolean,
  label: string,
  onToast?: (message: string) => void,
): boolean {
  if (!ok) onToast?.(`无法执行：${label}`);
  return ok;
}

// 原子块(无可标注文本)选中时,文本工具栏没意义——改给一条紧凑「让 AI 修改这个块」。
// 非原子块(表格/callout/列表等)里仍是文本选区,保持文本工具栏不变。
const BLOCK_NODE_LABELS: Record<string, string> = {
  image: "图片",
  diagram: "图表",
  blockMath: "公式块",
  horizontalRule: "分隔线",
  fileAttachment: "附件",
};

export interface SelectedBlockNode {
  type: string;
  label: string;
  from: number;
  to: number;
  /** 稳定块锚:每个块的 blockId(全局属性),供后端按 id 精确找回引用块,不依赖会漂移的 PM 位置估算。 */
  blockId?: string;
}

/** 当前是否选中了一个「原子块」节点(点选图表/图片/公式等会产生 NodeSelection)。 */
export function resolveSelectedBlockNode(editor: Pick<Editor, "state">): SelectedBlockNode | null {
  const sel = editor.state.selection;
  if (!(sel instanceof NodeSelection)) return null;
  const node = sel.node;
  if (!node.isBlock || !node.type.isAtom) return null;
  // 分隔线没有可让 AI 改的内容,点它不该弹"让 AI 修改这个分隔线"气泡(键盘删除等编辑语义不受影响)。
  if (node.type.name === "horizontalRule") return null;
  const label = BLOCK_NODE_LABELS[node.type.name] ?? "内容块";
  const blockId = typeof node.attrs.blockId === "string" && node.attrs.blockId ? node.attrs.blockId : undefined;
  return { type: node.type.name, label, from: sel.from, to: sel.to, blockId };
}

/** PM state 里是否存在"有内容的文本选区"(含全选);文本工具栏的显隐只认它。 */
export function hasTextRangeSelection(editor: Pick<Editor, "state">): boolean {
  const selection = editor.state.selection;
  if (selection instanceof NodeSelection) return false;
  return !selection.empty;
}

/** 取某位置所在【顶层块】的 blockId(文本选区用):自下而上找到 doc 的直接子节点。 */
export function resolveTopBlockIdAtPos(editor: Pick<Editor, "state">, pos: number): string | undefined {
  try {
    const $pos = editor.state.doc.resolve(Math.max(0, Math.min(pos, editor.state.doc.content.size)));
    // depth 1 = doc 的直接子节点(顶层块);depth 0 是 doc 本身。
    const top = $pos.depth >= 1 ? $pos.node(1) : null;
    const blockId = top?.attrs?.blockId;
    return typeof blockId === "string" && blockId ? blockId : undefined;
  } catch {
    return undefined;
  }
}

function isListItemNodeType(typeName: string): boolean {
  return typeName === "listItem" || typeName === "taskItem";
}

function clampDocPos(editor: Pick<Editor, "state">, pos: number): number {
  return Math.max(0, Math.min(pos, editor.state.doc.content.size));
}

function resolveListItemBlockIdAtPos(editor: Pick<Editor, "state">, pos: number): string | undefined {
  try {
    const $pos = editor.state.doc.resolve(clampDocPos(editor, pos));
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      const node = $pos.node(depth);
      if (!isListItemNodeType(node.type.name)) continue;
      const blockId = node.attrs?.blockId;
      return typeof blockId === "string" && blockId ? blockId : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface ListItemPosition {
  parentListPos: number;
  itemIndex: number;
}

function resolveListItemPositionAtPos(
  editor: Pick<Editor, "state">,
  pos: number,
): ListItemPosition | null {
  try {
    const $pos = editor.state.doc.resolve(clampDocPos(editor, pos));
    for (let depth = $pos.depth; depth >= 1; depth -= 1) {
      const node = $pos.node(depth);
      if (!isListItemNodeType(node.type.name) || depth < 2) continue;
      const parentDepth = depth - 1;
      return {
        parentListPos: $pos.before(parentDepth),
        itemIndex: $pos.index(parentDepth),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 取某位置所在 listItem/taskItem 的 blockId；不在 item 内时保持旧行为返回顶层块 id。 */
export function resolveItemBlockIdAtPos(editor: Pick<Editor, "state">, pos: number): string | undefined {
  return resolveListItemBlockIdAtPos(editor, pos) ?? resolveTopBlockIdAtPos(editor, pos);
}

export function resolveListItemSelectionRefs(
  editor: Pick<Editor, "state">,
  from: number,
  to: number,
): string[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return [];
  const endPos = Math.max(from, to - 1);
  const fromItem = resolveListItemPositionAtPos(editor, from);
  const toItem = resolveListItemPositionAtPos(editor, endPos);
  if (!fromItem || !toItem || fromItem.parentListPos !== toItem.parentListPos) return [];
  const parentList = editor.state.doc.nodeAt(fromItem.parentListPos);
  if (!parentList) return [];
  const firstIndex = Math.min(fromItem.itemIndex, toItem.itemIndex);
  const lastIndex = Math.max(fromItem.itemIndex, toItem.itemIndex);
  const refs: string[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const node = parentList.child(index);
    if (!isListItemNodeType(node.type.name)) return [];
    const blockId = node.attrs?.blockId;
    if (typeof blockId !== "string" || !blockId) return [];
    refs.push(blockId);
  }
  return refs;
}

/** 取选中原子块节点的视口矩形(给浮动工具栏定位)。 */
function selectedBlockNodeRect(editor: Editor, from: number): FloatingAnchorRect | null {
  try {
    const dom = editor.view.nodeDOM(from);
    if (dom instanceof HTMLElement) {
      const r = dom.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, width: r.width };
    }
  } catch {
    /* ignore */
  }
  try {
    const coords = editor.view.coordsAtPos(from);
    return { top: coords.top, bottom: coords.bottom, left: coords.left, width: Math.max(1, coords.right - coords.left) };
  } catch {
    return null;
  }
}

export type AiModifySelectionTarget =
  | (SavedAiSelection & { kind: "ready" })
  | { kind: "emptySelection" }
  | { kind: "crossBlockSelection" }
  | { kind: "noSelection" };

function truncateAiSelectionText(text: string): string {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** 范围是否恰好是单个原子块节点(图表/图片/公式等)——给块级 AI 引用放行用。 */
export function isEditorRangeSingleAtomBlock(
  editor: Pick<Editor, "state">,
  from: number,
  to: number,
): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;
  try {
    const node = editor.state.doc.nodeAt(from);
    // 必须是「块级」原子节点(图表/图片/公式等),排除行内/文本叶子节点
    return Boolean(node && node.isBlock && node.type.isAtom && from + node.nodeSize === to);
  } catch {
    return false;
  }
}

export function isEditorRangeWithinSingleTextBlock(
  editor: Pick<Editor, "state">,
  from: number,
  to: number,
): boolean {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return false;
  try {
    const $from = editor.state.doc.resolve(from);
    const $to = editor.state.doc.resolve(to);
    return $from.sameParent($to) && $from.parent.isTextblock;
  } catch {
    return false;
  }
}

export function resolveAiModifyLiveSelection(
  editor: Pick<Editor, "state">,
): AiModifySelectionTarget {
  const { from, to, empty } = editor.state.selection;
  if (empty) return { kind: "noSelection" };
  const selectionRefs = resolveListItemSelectionRefs(editor, from, to);
  if (!isEditorRangeWithinSingleTextBlock(editor, from, to) && selectionRefs.length === 0) {
    return { kind: "crossBlockSelection" };
  }

  const text = editor.state.doc.textBetween(from, to).trim();
  if (!text) return { kind: "emptySelection" };

  return {
    kind: "ready",
    text: truncateAiSelectionText(text),
    location: "正文",
    from,
    to,
    ...(selectionRefs.length > 0 ? { selectionRefs } : {}),
  };
}

export function resolveAiModifyTarget(
  editor: Pick<Editor, "state">,
  savedSelection: SavedAiSelection | null,
): AiModifySelectionTarget {
  const live = resolveAiModifyLiveSelection(editor);
  if (live.kind !== "noSelection") return live;
  if (savedSelection) return { kind: "ready", ...savedSelection };
  return live;
}

export async function resolveDiagramSourceForInsert(selectedText: string): Promise<string | undefined> {
  const source = selectedText.trim();
  if (!source) return undefined;
  try {
    const mermaid = (await import("mermaid")).default;
    const result = await mermaid.parse(source, { suppressErrors: true });
    return result === false ? undefined : source;
  } catch {
    return undefined;
  }
}

function stripMathDelimiters(input: string): string {
  return input.trim().replace(/^\$+/, "").replace(/\$+$/, "").trim();
}

function selectionAnchorRect(editor: Editor, fallback: ToolbarPos | null) {
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const anchor = selection.anchorNode;
    if (anchor && editor.view.dom.contains(anchor)) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) return rect;
    }
  }

  if (fallback) {
    return {
      top: fallback.top,
      bottom: fallback.top + 32,
      left: fallback.left,
      width: 1,
    };
  }

  try {
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    return {
      top: coords.top,
      bottom: coords.bottom,
      left: coords.left,
      width: Math.max(1, coords.right - coords.left),
    };
  } catch {
    return { top: 48, bottom: 80, left: 48, width: 1 };
  }
}

export function DocToolbar({
  active,
  editor,
  containerSelector,
  onAiModify,
  onToast,
}: DocToolbarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<ToolbarPos | null>(null);
  const [blockSel, setBlockSel] = useState<SelectedBlockNode | null>(null);
  const [cellSelectionSuppressed, setCellSelectionSuppressed] = useState(
    () => Boolean(editor && editor.state.selection instanceof CellSelection),
  );
  const lastPosRef = useRef<ToolbarPos | null>(null);
  if (pos) lastPosRef.current = pos;
  const [openDd, setOpenDd] = useState<string | null>(null);
  const [flipUp, setFlipUp] = useState(false);
  const [tablePicker, setTablePicker] = useState<{ anchor: HTMLElement; autoFocus: boolean } | null>(null);
  const { openLinkEditor, closeLinkEditor, linkEditor } = useToolbarLinkEditor({ editor, onToast, ignoreRef: barRef });
  const toolbarUnlock = resolveToolbarUnlockConfig();
  const [editorEditable, setEditorEditable] = useState(
    () => editor ? !editor.isDestroyed && editor.isEditable : true,
  );

  useEffect(() => {
    const syncEditorEditable = () => {
      setEditorEditable(editor ? !editor.isDestroyed && editor.isEditable : true);
    };

    // TipTap 的 editable prop 在 DocumentSnapshotView effect 后才通过
    // editor.setEditable() 落到 EditorView；这次内部更新不会让持有同一 Editor
    // 对象的父组件重渲染，但会发出 update。必须订阅这条事实，否则终态会出现
    // 正文 contenteditable=true、工具栏仍保留生成中 disabled 的分叉，直到下一次
    // 输入或发送碰巧触发 React render 才自愈。
    syncEditorEditable();
    if (!editor || editor.isDestroyed) return undefined;
    editor.on("update", syncEditorEditable);
    return () => {
      editor.off("update", syncEditorEditable);
    };
  }, [editor]);

  // Snapshot the editor selection text continuously so it survives
  // focus-loss that happens when the user clicks a toolbar button.
  // Clicking a <button> outside the contenteditable clears the DOM
  // selection (and thus TipTap's mirrored selection) before onClick
  // fires, even when mousedown calls preventDefault on the toolbar
  // wrapper. Saving on every selectionchange guarantees the value is
  // available when handleAiModify runs.
  const savedSelRef = useRef<SavedAiSelection | null>(null);
  const savedCommandSelRef = useRef<SavedToolbarSelection | null>(null);
  const toolbarPointerDownRef = useRef(false);
  const toolbarPointerDownTimerRef = useRef<number | null>(null);

  const markToolbarPointerDown = useCallback(() => {
    toolbarPointerDownRef.current = true;
    if (toolbarPointerDownTimerRef.current !== null) {
      window.clearTimeout(toolbarPointerDownTimerRef.current);
    }
    // 点击工具栏按钮时浏览器会先清空正文选区再触发 click;这段时间内 selectionchange
    // 不能关闭刚打开的菜单,否则插入菜单会一闪即关。
    toolbarPointerDownTimerRef.current = window.setTimeout(() => {
      toolbarPointerDownRef.current = false;
      toolbarPointerDownTimerRef.current = null;
    }, 250);
  }, []);

  useEffect(
    () => () => {
      if (toolbarPointerDownTimerRef.current !== null) {
        window.clearTimeout(toolbarPointerDownTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const syncCellSelectionSuppression = () => {
      setCellSelectionSuppressed(Boolean(
        active && editor && editor.state.selection instanceof CellSelection,
      ));
    };
    syncCellSelectionSuppression();
    if (!active || !editor) return undefined;
    editor.on("selectionUpdate", syncCellSelectionSuppression);
    return () => {
      editor.off("selectionUpdate", syncCellSelectionSuppression);
    };
  }, [active, editor]);

  const positionToolbar = useCallback(() => {
    if (!active || !editor || !editor.isEditable) {
      setCellSelectionSuppressed(false);
      setPos(null);
      setBlockSel(null);
      return;
    }
    // 表格 CellSelection 自带专用选区工具栏；正文 DocToolbar 只为格内普通 TextSelection 保留。
    // 抑制仅作用于浮层渲染，selectionchange 下方的 savedSelRef 快照仍照常执行。
    const suppressForCellSelection = editor.state.selection instanceof CellSelection;
    setCellSelectionSuppressed(suppressForCellSelection);
    if (suppressForCellSelection) {
      setPos(null);
      setBlockSel(null);
      return;
    }
    // 原子块(图表/图片/公式/分隔线/附件)选中:用节点矩形定位,显示紧凑「让 AI 修改这个块」工具栏。
    // 不要求 isFocused——点选原子节点未必聚焦 contenteditable。
    const block = resolveSelectedBlockNode(editor);
    if (block) {
      setBlockSel(block);
      const rect = selectedBlockNodeRect(editor, block.from);
      if (!rect) {
        setPos(null);
        return;
      }
      const barH = barRef.current?.offsetHeight || 40;
      const barW = barRef.current?.offsetWidth || 220;
      setPos(resolveCenteredFloatingPosition(
        rect,
        { width: barW, height: barH },
        { width: window.innerWidth, height: window.innerHeight },
      ));
      return;
    }
    setBlockSel(null);
    // 显隐以 PM state 为准:取消选中原子块(图表/图片)的那一拍,PM 选区已经不是块选,
    // 但浏览器原生选区还残留着原子块的旧 range(非折叠、有高度),只看原生选区会让
    // 文本工具栏按旧矩形闪现一帧。原生选区此后只负责定位,不负责显隐。
    if (!hasTextRangeSelection(editor)) {
      setPos(null);
      return;
    }
    if (!editor.isFocused) {
      setPos(null);
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setPos(null);
      return;
    }
    const anchor = sel.anchorNode;
    if (!anchor || !editor.view.dom.contains(anchor)) {
      setPos(null);
      return;
    }
    if (sel.isCollapsed) {
      setPos(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (typeof range.getBoundingClientRect !== "function") {
      setPos(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.height === 0) {
      setPos(null);
      return;
    }
    const barH = barRef.current?.offsetHeight || 40;
    const barW = barRef.current?.offsetWidth || 360;
    setPos(resolveCenteredFloatingPosition(
      rect,
      { width: barW, height: barH },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [active, editor]);

  useEffect(() => {
    if (editorEditable) return;
    setPos(null);
    setBlockSel(null);
    setOpenDd(null);
    closeLinkEditor();
    setTablePicker(null);
    savedSelRef.current = null;
    savedCommandSelRef.current = null;
  }, [closeLinkEditor, editorEditable]);

  useEffect(() => {
    if (!active) {
      setPos(null);
      setOpenDd(null);
      closeLinkEditor();
      setTablePicker(null);
      savedSelRef.current = null;
      savedCommandSelRef.current = null;
      return;
    }
    const onSel = () => {
      if (
        toolbarPointerDownRef.current ||
        document.activeElement?.closest?.(".doc-toolbar, .table-size-picker")
      ) return;
      setOpenDd(null);
      positionToolbar();

      // Continuously snapshot the selected text so handleAiModify can
      // use it even after the DOM selection is cleared by a button click.
      if (editor) {
        if (!editor.isEditable) {
          savedSelRef.current = null;
          return;
        }
        // 命令选区与 AI 单块定位分开保存：跨段 TextSelection 对格式命令完全有效。
        savedCommandSelRef.current = captureToolbarSelection(editor);
        const target = resolveAiModifyLiveSelection(editor);
        if (target.kind === "ready") {
          savedSelRef.current = {
            text: target.text,
            location: target.location,
            from: target.from,
            to: target.to,
            ...(target.selectionRefs ? { selectionRefs: target.selectionRefs } : {}),
          };
        } else if (
          target.kind === "emptySelection" ||
          target.kind === "crossBlockSelection"
        ) {
          savedSelRef.current = null;
        }
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.(".doc-toolbar")) return;
      window.setTimeout(positionToolbar, 0);
    };
    const onKeyUp = () => positionToolbar();
    const container = document.querySelector(containerSelector);
    let rafId: number | null = null;
    const schedulePositionToolbar = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        positionToolbar();
      });
    };
    document.addEventListener("selectionchange", onSel);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    container?.addEventListener("scroll", schedulePositionToolbar, { passive: true });
    window.addEventListener("resize", schedulePositionToolbar, { passive: true });
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      document.removeEventListener("selectionchange", onSel);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      container?.removeEventListener("scroll", schedulePositionToolbar);
      window.removeEventListener("resize", schedulePositionToolbar);
    };
  }, [active, closeLinkEditor, editor, positionToolbar, containerSelector]);

  useLayoutEffect(() => {
    if (!openDd) {
      setFlipUp(false);
      return;
    }
    const groupEl = barRef.current?.querySelector(`.dt-group[data-dd="${openDd}"]`);
    const menuEl = groupEl?.querySelector(".dt-menu") as HTMLElement | null;
    const buttonEl = groupEl?.querySelector("button");
    if (!menuEl || !buttonEl) {
      setFlipUp(false);
      return;
    }
    const menuHeight = menuEl.scrollHeight || menuEl.getBoundingClientRect().height;
    const buttonRect = buttonEl.getBoundingClientRect();
    setFlipUp(shouldFlipDropdownUp(buttonRect.bottom, menuHeight, window.innerHeight));
    window.requestAnimationFrame(() => {
      menuEl.querySelector<HTMLElement>('.dt-mi[role="menuitem"]:not(.disabled)')?.focus();
    });
  }, [openDd]);

  useEffect(() => {
    if (openDd !== "insert") setTablePicker(null);
  }, [openDd]);

  useEffect(() => {
    if (!openDd) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpenDd(null);
        barRef.current
          ?.querySelector<HTMLElement>(`.dt-group[data-dd="${openDd}"] button`)
          ?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = Array.from(
        barRef.current?.querySelectorAll<HTMLElement>(
          `.dt-group[data-dd="${openDd}"] .dt-mi[role="menuitem"]:not(.disabled)`,
        ) ?? [],
      );
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? current < 0
            ? 0
            : (current + 1) % items.length
          : current <= 0
            ? items.length - 1
            : current - 1;
      items[next]?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openDd]);

  const saveCurrentCommandSelection = useCallback(() => {
    if (!editor || !editor.isEditable) return;
    const saved = captureToolbarSelection(editor);
    // 菜单第二次点击时焦点可能已塌陷；不能覆盖第一次按下触发器时保存的正文范围。
    if (saved) savedCommandSelRef.current = saved;
  }, [editor]);

  const restoreSavedCommandSelection = useCallback(() => {
    if (!editor || !savedCommandSelRef.current) return true;
    return reportToolbarCommandResult(
      restoreToolbarSelection(editor, savedCommandSelRef.current),
      "恢复工具栏选区",
      onToast,
    );
  }, [editor, onToast]);

  const swallowMouseDown = useCallback((e: React.MouseEvent) => {
    saveCurrentCommandSelection();
    markToolbarPointerDown();
    e.preventDefault();
  }, [markToolbarPointerDown, saveCurrentCommandSelection]);

  const runCommand = useCallback(
    async (cmd: string, val?: string | null) => {
      if (!editor) return;
      if (!editor.isEditable) return;
      if (!isToolbarCommandEnabled(cmd, val, toolbarUnlock)) return;
      if (!restoreSavedCommandSelection()) {
        setOpenDd(null);
        return;
      }
      // 选区已由 PM transaction 恢复；此处再 chain.focus() 会从下拉菜单读取 DOM 光标并将 range 塌陷。
      const chain = editor.chain();
      const run = (label: string, action: () => boolean) =>
        reportToolbarCommandResult(action(), label, onToast);
      switch (cmd) {
        case "bold":
          run("加粗", () => chain.toggleBold().run());
          break;
        case "italic":
          run("斜体", () => chain.toggleItalic().run());
          break;
        case "underline":
          run("下划线", () => chain.toggleUnderline().run());
          break;
        case "strikeThrough":
          run("删除线", () => chain.toggleStrike().run());
          break;
        case "code":
          run("行内代码", () => chain.toggleCode().run());
          break;
        case "formatBlock": {
          if (!val || val === "P") {
            run("正文", () => chain.setParagraph().run());
          } else {
            const level = parseInt(val.replace("H", "")) as
              | 1
              | 2
              | 3
              | 4
              | 5
              | 6;
            run(`${level}级标题`, () => chain.toggleHeading({ level }).run());
          }
          break;
        }
        case "bulletList":
          run("无序列表", () => chain.toggleBulletList().run());
          break;
        case "orderedList":
          run("有序列表", () => chain.toggleOrderedList().run());
          break;
        case "orderedListStyle": {
          const listStyle = normalizeOrderedListStyle(val);
          if (!listStyle) return;
          run("序号样式", () => chain.updateAttributes("orderedList", { listStyle }).run());
          break;
        }
        case "blockquote":
          run("引用", () => chain.toggleBlockquote().run());
          break;
        case "taskList":
          run("待办清单", () => chain.toggleTaskList().run());
          break;
        case "callout":
          if (editor.isActive("callout")) run("高亮块", () => chain.lift("callout").run());
          else run("高亮块", () => chain.wrapIn("callout").run());
          break;
        case "insertInlineMath": {
          const { from, to } = editor.state.selection;
          const latex = stripMathDelimiters(editor.state.doc.textBetween(from, to, "\n")) || "x^2";
          if (from !== to) {
            run("行内公式", () => chain.insertContentAt({ from, to }, { type: "inlineMath", attrs: { latex } }).run());
          } else {
            run("行内公式", () => chain.insertInlineMath({ latex }).run());
          }
          break;
        }
        case "insertBlockMath": {
          const { from, to } = editor.state.selection;
          const latex = stripMathDelimiters(editor.state.doc.textBetween(from, to, "\n")) || "E = mc^2";
          run("公式块", () =>
            insertStructureNodeAtSelection(editor, { type: "blockMath", attrs: { latex } }),
          );
          break;
        }
        case "insertDiagram": {
          // 选中文本必须通过 mermaid.parse 校验,否则使用默认流程图模板。
          const { from, to } = editor.state.selection;
          const selected = editor.state.doc.textBetween(from, to, "\n").trim();
          const source = await resolveDiagramSourceForInsert(selected);
          run("插入图表", () =>
            insertStructureNodeAtSelection(editor, {
              type: "diagram",
              attrs: {
                lang: "mermaid",
                source: source ?? "flowchart TD\n  A[开始] --> B[结束]",
                svg: null,
              },
            }),
          );
          break;
        }
        case "insertDrawio": {
          try {
            const blockId = createDrawioBlockId();
            const inserted = run("插入 drawio 工程图", () =>
              insertStructureNodeAtSelection(editor, {
                type: "diagram",
                attrs: {
                  blockId,
                  lang: "drawio",
                  source: DEFAULT_DRAWIO_SOURCE,
                  svg: null,
                },
              }),
            );
            if (!inserted) break;
            const writeBack = (result: DrawioEditorResult) => {
              if (!editor.isEditable) return;
              writeDrawioResultByBlockId(editor, blockId, result);
            };
            const result = await openDrawioEditor(
              DEFAULT_DRAWIO_SOURCE,
              "新建 drawio 工程图",
              writeBack,
            );
            if (result) writeBack(result);
          } catch (drawioError) {
            onToast?.(drawioError instanceof Error ? drawioError.message : String(drawioError));
          }
          break;
        }
        case "insertTable":
          run("插入表格", () =>
            insertStructureNodeAtSelection(editor, createDefaultTableNode(3, 3, false)),
          );
          break;
        case "insertColumns": {
          run("插入分栏", () =>
            insertStructureNodeAtSelection(editor, createDefaultColumnListNode()),
          );
          break;
        }
        case "codeBlock":
          run("代码块", () => chain.setCodeBlock().run());
          break;
        case "horizontalRule":
          run("分隔线", () =>
            insertStructureNodeAtSelection(editor, { type: "horizontalRule" }),
          );
          break;
        case "justifyLeft":
          run("左对齐", () => chain.setTextAlign("left").run());
          break;
        case "justifyCenter":
          run("居中", () => chain.setTextAlign("center").run());
          break;
        case "justifyRight":
          run("右对齐", () => chain.setTextAlign("right").run());
          break;
        case "textColor":
          if (val === "transparent") {
            run("清除文字颜色", () => chain.unsetMark("textColor").run());
          } else {
            const color = normalizeToolbarTextColor(val);
            if (color) run("文字颜色", () => chain.setMark("textColor", { color }).run());
          }
          break;
        case "hiliteColor":
          if (val === "transparent") {
            run("清除背景高亮", () => chain.unsetHighlight().run());
          } else {
            const color = normalizeToolbarHighlightColor(val);
            if (color) run("背景高亮", () => chain.toggleHighlight({ color }).run());
          }
          break;
        case "createLink": {
          const anchor = selectionAnchorRect(editor, pos ?? lastPosRef.current);
          openLinkEditor(anchor);
          setOpenDd(null);
          return;
        }
      }
      setOpenDd(null);
      savedCommandSelRef.current = captureToolbarSelection(editor);
      positionToolbar();
    },
    [editor, onToast, openLinkEditor, pos, positionToolbar, restoreSavedCommandSelection, toolbarUnlock],
  );

  const handleInsertImage = useCallback(() => {
    if (!editor) return;
    if (!editor.isEditable) return;
    setOpenDd(null);
    void pickFile("image/*").then(async (file) => {
      if (!file) return;
      if (!editor.isEditable) return;
      if (!restoreSavedCommandSelection()) return;
      try {
        await insertImageAsset(editor, file);
      } catch (error) {
        console.error("[workspace] image upload failed", error);
        onToast?.(uploadFailureMessage(error, "图片上传失败，请重试"));
      }
    });
  }, [editor, onToast, restoreSavedCommandSelection]);

  const handleInsertFile = useCallback(() => {
    if (!editor) return;
    if (!editor.isEditable) return;
    setOpenDd(null);
    void pickFile("*/*").then(async (file) => {
      if (!file) return;
      if (!editor.isEditable) return;
      if (!restoreSavedCommandSelection()) return;
      try {
        await insertFileAsset(editor, file);
      } catch (error) {
        console.error("[workspace] file upload failed", error);
        onToast?.(uploadFailureMessage(error, "文件上传失败，请重试"));
      }
    });
  }, [editor, onToast, restoreSavedCommandSelection]);

  const handleAiModify = useCallback(() => {
    if (!editor) return;
    if (!editor.isEditable) return;

    // 原子块:把整个块(图表/图片/公式等)作为引用推进输入框,让用户跟 AI 说"改这个图表"。
    const block = resolveSelectedBlockNode(editor);
    if (block) {
      if (!block.blockId) {
        onToast?.("暂时无法定位选区,请重新选择");
        return;
      }
      void onAiModify({
        label: block.label,
        suffix: "批注",
        blockId: block.blockId,
        from: block.from,
        to: block.to,
      });
      setPos(null);
      setBlockSel(null);
      setOpenDd(null);
      return;
    }

    const target = resolveAiModifyTarget(editor, savedSelRef.current);
    if (target.kind === "crossBlockSelection") {
      savedSelRef.current = null;
      onToast?.("暂不支持跨段落修改,请在同一段内选择");
      return;
    }
    if (target.kind === "emptySelection") {
      savedSelRef.current = null;
      onToast?.("请先选中要修改的文字");
      return;
    }
    if (target.kind === "noSelection") {
      onToast?.("请先选中要修改的文字");
      return;
    }

    const blockId = target.selectionRefs?.[0] ??
      (target.from !== undefined ? resolveItemBlockIdAtPos(editor, target.from) : undefined);
    if (!blockId) {
      onToast?.("暂时无法定位选区,请重新选择");
      return;
    }
    void onAiModify({
      label: target.text,
      suffix: "批注",
      blockId,
      from: target.from,
      to: target.to,
      selectionRefs: target.selectionRefs,
    });
    savedSelRef.current = null;
    editor.commands.blur();
    setPos(null);
    setOpenDd(null);
  }, [editor, onAiModify, onToast]);

  const toggleDd = useCallback((id: string) => {
    setOpenDd((prev) => (prev === id ? null : id));
  }, []);

  const insertTableAtSize = useCallback((size: TableSize) => {
    if (!editor || !editor.isEditable || !toolbarUnlock.blocks) return;
    if (!restoreSavedCommandSelection()) return;
    reportToolbarCommandResult(
      insertStructureNodeAtSelection(
        editor,
        createDefaultTableNode(size.rows, size.cols, false),
      ),
      "插入表格",
      onToast,
    );
    setTablePicker(null);
    setOpenDd(null);
    positionToolbar();
  }, [editor, onToast, positionToolbar, restoreSavedCommandSelection, toolbarUnlock.blocks]);

  const activeOrderedListStyle = editor?.isActive("orderedList")
    ? normalizeOrderedListStyle(editor.getAttributes("orderedList").listStyle) ?? "decimal"
    : null;
  // 当前光标所在标题层级(高亮六格里的那一格)
  const activeHeadingLevel = editor?.isActive("heading")
    ? Number(editor.getAttributes("heading").level) || null
    : null;

  if (
    !active ||
    cellSelectionSuppressed ||
    Boolean(editor && editor.state.selection instanceof CellSelection)
  ) return null;

  return (
    <>
    <div
      ref={barRef}
      className={`doc-toolbar${pos ? " on" : ""}${blockSel ? " is-block" : ""}${(pos ?? lastPosRef.current)?.placement === "below" ? " is-below" : ""}`}
      data-wf="DocToolbar"
      role="toolbar"
      aria-label="文档格式工具栏"
      style={
        (pos ?? lastPosRef.current)
          ? { top: (pos ?? lastPosRef.current)!.top, left: (pos ?? lastPosRef.current)!.left }
          : undefined
      }
      onMouseDown={swallowMouseDown}
    >
      {blockSel ? (
        <button
          type="button"
          className="dt-btn dt-ai dt-block-ai"
          aria-label={`让 AI 修改这个${blockSel.label}`}
          disabled={!editorEditable}
          onClick={handleAiModify}
        >
          <span className="dt-ai-ico">✨</span>
          <span>让 AI 修改这个{blockSel.label}</span>
        </button>
      ) : (
      <>
      <Group
        id="heading"
        label="标题和块样式"
        open={openDd === "heading"}
        flip={openDd === "heading" && flipUp}
        onToggle={() => toggleDd("heading")}
        disabled={!editorEditable}
        active={Boolean(editor?.isActive("heading"))}
      >
        <span className="dt-lbl">T</span>
        <span className="dt-caret"><CaretIcon size={11} /></span>
        <Menu open={openDd === "heading"}>
          {/* 六级标题紧凑排一行(旧版是六行长列表,菜单被撑得又高又散) */}
          <HeadingLevelPicker
            activeLevel={activeHeadingLevel}
            isDisabled={(level) => !editorEditable || (level >= 3 && !toolbarUnlock.headings)}
            titleOf={(level) => toolbarTitle(headingLevelLabel(level), `heading${level}`)}
            onPick={(level) => runCommand("formatBlock", `H${level}`)}
          />
          <MenuItem k="¶" onPick={() => runCommand("formatBlock", "P")} disabled={!editorEditable}>
            正文
          </MenuItem>
          <MenuItem k="•" onPick={() => runCommand("bulletList")} disabled={!editorEditable || !toolbarUnlock.blocks}>
            无序列表
          </MenuItem>
          <MenuItem k="1." onPick={() => runCommand("orderedList")} disabled={!editorEditable || !toolbarUnlock.blocks}>
            有序列表
          </MenuItem>
          {ORDERED_LIST_STYLE_OPTIONS.map((item) => (
            <MenuItem
              key={item.value}
              k={item.marker}
              onPick={() => runCommand("orderedListStyle", item.value)}
              disabled={!editorEditable || !toolbarUnlock.blocks || !activeOrderedListStyle}
              className={activeOrderedListStyle === item.value ? "active" : undefined}
            >
              {item.label}
            </MenuItem>
          ))}
          <MenuItem k=">" onPick={() => runCommand("blockquote")} disabled={!editorEditable || !toolbarUnlock.blocks}>
            引用
          </MenuItem>
          <MenuItem k={<CheckIcon size={12} />} onPick={() => runCommand("taskList")} disabled={!editorEditable || !toolbarUnlock.blocks}>
            待办清单
          </MenuItem>
          <MenuItem k="💡" onPick={() => runCommand("callout")} disabled={!editorEditable || !toolbarUnlock.blocks}>
            高亮块
          </MenuItem>
        </Menu>
      </Group>
      <Divider />
      <Group
        id="align"
        label="对齐方式"
        open={openDd === "align"}
        flip={openDd === "align" && flipUp}
        onToggle={() => toggleDd("align")}
        disabled={!editorEditable || !toolbarUnlock.align}
        active={Boolean(editor?.isActive({ textAlign: "center" }) || editor?.isActive({ textAlign: "right" }))}
      >
        <span className="dt-lbl dt-lbl-icon"><AlignIcon align="justify" size={15} /></span>
        <span className="dt-caret"><CaretIcon size={11} /></span>
        <Menu open={openDd === "align"}>
          <MenuItem onPick={() => runCommand("justifyLeft")}>
            <MenuAlignIcon align="left" />左对齐
          </MenuItem>
          <MenuItem onPick={() => runCommand("justifyCenter")}>
            <MenuAlignIcon align="center" />居中
          </MenuItem>
          <MenuItem onPick={() => runCommand("justifyRight")}>
            <MenuAlignIcon align="right" />右对齐
          </MenuItem>
        </Menu>
      </Group>
      <Divider />
      <button
        type="button"
        className={toolbarButtonClass(Boolean(editor?.isActive("bold")))}
        aria-label="加粗"
        title={toolbarTitle("加粗", "bold")}
        disabled={!editorEditable || !toolbarUnlock.marks}
        onClick={() => runCommand("bold")}
      >
        <b>B</b>
      </button>
      <button
        type="button"
        className={toolbarButtonClass(Boolean(editor?.isActive("strike")))}
        aria-label="删除线"
        title={toolbarTitle("删除线", "strikeThrough")}
        disabled={!editorEditable || !toolbarUnlock.marks}
        onClick={() => runCommand("strikeThrough")}
      >
        <s>S</s>
      </button>
      <button
        type="button"
        className={toolbarButtonClass(Boolean(editor?.isActive("italic")))}
        aria-label="斜体"
        title={toolbarTitle("斜体", "italic")}
        disabled={!editorEditable || !toolbarUnlock.marks}
        onClick={() => runCommand("italic")}
      >
        <i>I</i>
      </button>
      <button
        type="button"
        className={toolbarButtonClass(Boolean(editor?.isActive("underline")))}
        aria-label="下划线"
        title={toolbarTitle("下划线", "underline")}
        disabled={!editorEditable || !toolbarUnlock.marks}
        onClick={() => runCommand("underline")}
      >
        <u>U</u>
      </button>
      <Divider />
      <button
        type="button"
        className={toolbarButtonClass(Boolean(editor?.isActive("link")))}
        aria-label="链接"
        title="链接"
        disabled={!editorEditable || !toolbarUnlock.marks}
        onClick={() => runCommand("createLink")}
      >
        <ToolbarIcon name="link" />
      </button>
      <button
        type="button"
        className={toolbarButtonClass(Boolean(editor?.isActive("code")))}
        aria-label="行内代码"
        title={toolbarTitle("行内代码", "code")}
        disabled={!editorEditable || !toolbarUnlock.marks}
        onClick={() => runCommand("code")}
      >
        <ToolbarIcon name="inlineCode" />
      </button>
      <Divider />
      <Group
        id="colors"
        label="文字和背景颜色"
        open={openDd === "colors"}
        flip={openDd === "colors" && flipUp}
        onToggle={() => toggleDd("colors")}
        disabled={!editorEditable || !toolbarUnlock.marks}
        active={Boolean(editor?.isActive("textColor") || editor?.isActive("highlight"))}
      >
        <span className="dt-lbl dt-hi-lbl">
          A<span className="dt-hi-bar" />
        </span>
        <span className="dt-caret"><CaretIcon size={11} /></span>
        <Menu open={openDd === "colors"} className="dt-menu-colors">
          <ColorPaletteMenu
            disabled={!editorEditable || !toolbarUnlock.marks}
            onTextColor={(color) => runCommand("textColor", color)}
            onHighlightColor={(color) => runCommand("hiliteColor", color)}
          />
        </Menu>
      </Group>
      <Divider />
      <Group
        id="insert"
        label="插入"
        open={openDd === "insert"}
        flip={openDd === "insert" && flipUp}
        onToggle={() => toggleDd("insert")}
        disabled={!editorEditable}
      >
        <ToolbarIcon name="insert" />
        <span className="dt-caret"><CaretIcon size={11} /></span>
        <Menu open={openDd === "insert"}>
          <MenuItem onPick={handleInsertImage} disabled={!editorEditable}><MenuIcon name="image" />插入图片</MenuItem>
          <MenuItem onPick={handleInsertFile} disabled={!editorEditable || !toolbarUnlock.resourceRef}><MenuIcon name="file" />插入文件</MenuItem>
          <MenuItem onPick={() => runCommand("insertInlineMath")} disabled={!editorEditable || !toolbarUnlock.blocks}><MenuIcon name="inlineMath" />行内公式</MenuItem>
          <MenuItem onPick={() => runCommand("insertBlockMath")} disabled={!editorEditable || !toolbarUnlock.blocks}><MenuIcon name="blockMath" />公式块</MenuItem>
          <MenuItem onPick={() => runCommand("insertDiagram")} disabled={!editorEditable || !toolbarUnlock.blocks}><MenuIcon name="diagram" />插入 Mermaid 图表</MenuItem>
          <MenuItem onPick={() => runCommand("insertDrawio")} disabled={!editorEditable || !toolbarUnlock.blocks}><MenuIcon name="diagram" />插入 drawio 工程图</MenuItem>
          <MenuItem
            onPreview={(anchor, autoFocus) => setTablePicker({ anchor, autoFocus })}
            disabled={!editorEditable || !toolbarUnlock.blocks}
          ><MenuIcon name="table" />插入表格<span className="dt-mi-spacer"><CaretIcon size={12} direction="right" /></span></MenuItem>
          <MenuItem onPick={() => runCommand("insertColumns")} disabled={!editorEditable || !toolbarUnlock.blocks}><MenuIcon name="columns" />插入分栏</MenuItem>
          <MenuItem onPick={() => runCommand("codeBlock")} disabled={!editorEditable || !toolbarUnlock.blocks}><MenuIcon name="code" />代码块</MenuItem>
          <MenuItem onPick={() => runCommand("horizontalRule")} disabled={!editorEditable || !toolbarUnlock.blocks}><MenuIcon name="divider" />分隔线</MenuItem>
        </Menu>
      </Group>
      <Divider />
      <button
        type="button"
        className="dt-btn dt-ai"
        aria-label="AI 修改"
        title="作为引用加入对话"
        disabled={!editorEditable}
        onClick={handleAiModify}
      >
        <span className="dt-ai-ico">✨</span>
        <span>修改选中文字</span>
      </button>
      </>
      )}
    </div>
    {linkEditor}
    {tablePicker ? (
      <TableSizePicker
        anchor={tablePicker.anchor}
        autoFocus={tablePicker.autoFocus}
        onSelect={insertTableAtSize}
        onClose={() => setTablePicker(null)}
      />
    ) : null}
    </>
  );
}

/* ───────────── toolbar sub-components ───────────── */

function Group({
  id,
  label,
  open,
  flip = false,
  onToggle,
  disabled = false,
  active = false,
  children,
}: {
  id: string;
  label: string;
  open: boolean;
  flip?: boolean;
  onToggle: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  const triggerChildren: React.ReactNode[] = [];
  const menuChildren: React.ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (isValidElement(child) && child.type === Menu) {
      menuChildren.push(child);
    } else {
      triggerChildren.push(child);
    }
  });

  return (
    <div
      className={`dt-group dt-dropdown${open ? " open" : ""}${flip ? " flip-up" : ""}`}
      data-dd={id}
    >
      <button
        type="button"
        className={toolbarButtonClass(active)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          onToggle();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          e.stopPropagation();
          if (!open) onToggle();
        }}
      >
        {triggerChildren}
      </button>
      {menuChildren}
    </div>
  );
}

function Menu({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className={["dt-menu", className].filter(Boolean).join(" ")} role="menu">
      {children}
    </div>
  );
}

function MenuItem({
  k,
  onPick,
  className,
  disabled = false,
  onPreview,
  children,
}: {
  k?: React.ReactNode;
  onPick?: () => void;
  onPreview?: (anchor: HTMLElement, autoFocus: boolean) => void;
  className?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="menuitem"
      tabIndex={0}
      aria-disabled={disabled}
      aria-haspopup={onPreview ? "dialog" : undefined}
      className={["dt-mi", disabled ? "disabled" : null, className].filter(Boolean).join(" ")}
      onMouseEnter={(event) => {
        if (!disabled) onPreview?.(event.currentTarget, false);
      }}
      onFocus={(event) => {
        if (!disabled) onPreview?.(event.currentTarget, false);
      }}
      onClick={(event) => {
        if (disabled) return;
        if (onPreview) onPreview(event.currentTarget, true);
        else onPick?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (disabled) return;
          if (onPreview) onPreview(e.currentTarget, true);
          else onPick?.();
        }
      }}
    >
      {k && <span className="dt-mi-k">{k}</span>}
      {children}
    </div>
  );
}

function Divider() {
  return <div className="dt-divider" />;
}

function toolbarButtonClass(active: boolean): string {
  return ["dt-btn", active ? "active" : null].filter(Boolean).join(" ");
}

function ColorPaletteMenu({
  disabled = false,
  onTextColor,
  onHighlightColor,
}: {
  disabled?: boolean;
  onTextColor: (color: ToolbarThemeColorKey | "transparent") => void;
  onHighlightColor: (color: ToolbarThemeColorKey | "transparent") => void;
}) {
  return (
    <div className="dt-color-menu">
      <div className="dt-color-section">
        <div className="dt-color-label">文字颜色</div>
        <div className="dt-swatch-grid">
          {TOOLBAR_THEME_COLORS.map((color) => (
            <button
              key={`text-${color.key}`}
              type="button"
              role="menuitem"
              className="dt-swatch dt-swatch-text"
              title={`文字颜色：${color.label}`}
              disabled={disabled}
              onClick={() => onTextColor(color.key)}
            >
              <span
                className="dt-swatch-chip"
                style={{ background: TOOLBAR_TEXT_COLORS[color.key], borderColor: TOOLBAR_TEXT_COLORS[color.key] }}
              />
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="dt-swatch dt-swatch-clear"
            title="清除文字颜色"
            disabled={disabled}
            onClick={() => onTextColor("transparent")}
          >
            <span className="dt-color-none" />
          </button>
        </div>
      </div>
      <div className="dt-color-section">
        <div className="dt-color-label">背景高亮</div>
        <div className="dt-swatch-grid">
          {TOOLBAR_THEME_COLORS.map((color) => (
            <button
              key={`highlight-${color.key}`}
              type="button"
              role="menuitem"
              className="dt-swatch"
              title={`背景高亮：${color.label}`}
              disabled={disabled}
              onClick={() => onHighlightColor(color.key)}
            >
              <span
                className="dt-swatch-chip"
                style={{ background: TOOLBAR_HIGHLIGHT_COLORS[color.key], borderColor: color.border }}
              />
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="dt-swatch dt-swatch-clear"
            title="清除背景高亮"
            disabled={disabled}
            onClick={() => onHighlightColor("transparent")}
          >
            <span className="dt-color-none" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 菜单行里的对齐图标:复用共用 AlignIcon,套 dt-menu-icon 盒子与其它菜单图标同列对齐。 */
function MenuAlignIcon({ align }: { align: AlignVariant }) {
  return (
    <span className="dt-menu-icon" aria-hidden="true">
      <AlignIcon align={align} size={15} />
    </span>
  );
}

type ToolbarIconName = "link" | "inlineCode" | "insert";

function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  switch (name) {
    case "link":
      return (
        <svg className="dt-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6.5 5.2l1.2-1.2c1.3-1.3 3.4-1.3 4.7 0s1.3 3.4 0 4.7l-1.5 1.5c-1.2 1.2-3.1 1.3-4.4.3" />
          <path d="M9.5 10.8l-1.2 1.2c-1.3 1.3-3.4 1.3-4.7 0s-1.3-3.4 0-4.7l1.5-1.5c1.2-1.2 3.1-1.3 4.4-.3" />
          <path d="M6.2 9.8l3.6-3.6" />
        </svg>
      );
    case "inlineCode":
      return (
        <span className="dt-code-icon" aria-hidden="true">
          <svg className="dt-svg" viewBox="0 0 16 16">
            <path d="M6.1 4.7L3.1 8l3 3.3M9.9 4.7l3 3.3-3 3.3" />
          </svg>
        </span>
      );
    case "insert":
      return (
        <svg className="dt-svg" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="3" width="10" height="10" rx="1.4" />
          <path d="M8 5.5v5M5.5 8h5" />
        </svg>
      );
  }
}

type MenuIconName = "image" | "file" | "inlineMath" | "blockMath" | "diagram" | "table" | "columns" | "code" | "divider";

function MenuIcon({ name }: { name: MenuIconName }) {
  return (
    <span className="dt-menu-icon" aria-hidden="true">
      {renderMenuIcon(name)}
    </span>
  );
}

function renderMenuIcon(name: MenuIconName) {
  switch (name) {
    case "image":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <rect x="2.5" y="2.7" width="11" height="10.6" rx="1.6" />
          <path d="M5.3 6.4h.1M3 11.4l3-3 2.2 2.1 2.1-2.5 3 3.4" />
        </svg>
      );
    case "file":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <path d="M4 2.5h5.2l2.8 2.8v8.2H4zM9.2 2.5v2.8H12M6.1 8h4M6.1 10.6h3.2" />
        </svg>
      );
    case "inlineMath":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <path d="M12 4H5.2l3.3 4-3.3 4H12" />
        </svg>
      );
    case "blockMath":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="M10.8 5.7H6.3L8.5 8l-2.2 2.3h4.5" />
        </svg>
      );
    case "diagram":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <rect x="2.4" y="3" width="4" height="3.4" rx="1" />
          <rect x="9.6" y="9.6" width="4" height="3.4" rx="1" />
          <path d="M6.4 4.7h2.4c1.5 0 2.8 1.2 2.8 2.8v2.1M8 11.3H5.7c-1.6 0-2.9-1.2-2.9-2.8V6.4" />
        </svg>
      );
    case "table":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <rect x="2.5" y="3" width="11" height="10" rx="1.3" />
          <path d="M2.5 6.5h11M2.5 9.5h11M6.2 3v10M9.8 3v10" />
        </svg>
      );
    case "columns":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
          <path d="M8 3v10M4.7 5.3h1.7M9.7 5.3h1.7M4.7 8h1.7M9.7 8h1.7M4.7 10.7h1.7M9.7 10.7h1.7" />
        </svg>
      );
    case "code":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <path d="M5.9 4.8L2.7 8l3.2 3.2M10.1 4.8L13.3 8l-3.2 3.2M9 3.8L7 12.2" />
        </svg>
      );
    case "divider":
      return (
        <svg className="dt-menu-svg" viewBox="0 0 16 16">
          <path d="M2.8 8h10.4" strokeDasharray="1.8 2.4" />
        </svg>
      );
  }
}
