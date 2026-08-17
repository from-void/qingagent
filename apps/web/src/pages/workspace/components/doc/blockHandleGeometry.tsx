import type { JSX } from "react";
import type { Editor } from "@tiptap/react";
import { getCollapsedBlockIds } from "../BlockCollapse";
import { findDraggableListItem, getListItemRowMetrics, type DraggableListItem } from "../ListItemDnD";
import { BlockHandleIcon } from "./BlockHandleIcons";
import {
  TABLE_COLUMN_HEADER_SIZE,
  TABLE_INSERT_DOT_GAP,
  TABLE_INSERT_DOT_SIZE,
  TABLE_ROW_HEADER_SIZE,
} from "./tableChromeGeometry";

/* ───────────── 块级左侧手柄(对齐飞书):显示块类型 / 点击转换格式 / 拖拽排序 ───────────── */

export interface HandleState {
  kind: "block" | "listItem"; // listItem 行手柄只负责拖拽,不打开块转换菜单
  top: number; // 视口 y(对齐块首行垂直中点)
  left: number; // 视口 x(块正文左缘 / 列表 marker 左侧锚点)
  blockPos: number; // 块/列表行节点之前的位置(NodeSelection 拖拽用)
  insertPos: number; // 块内位置(转换 / 插入光标用)
  isEmpty: boolean; // 当前块是否为空(空块显示 "+",非空块显示类型徽标)
  glyph: string; // 手柄字形:空块 "+";否则块类型(正文 "T" / 标题 "H1".."H6" / 列表 / 引用 / 代码)
  blockEl: HTMLElement; // 块 DOM(拖拽预览 + 滚动跟随重定位)
  blockId?: string | null;
  itemType?: DraggableListItem["itemType"];
  nodeType: string;
}

export interface BlockMenuPlacement {
  top: number;
  left: number;
  flipUp: boolean;
}

const BLOCK_MENU_EST_WIDTH = 222;
const BLOCK_MENU_EST_HEIGHT = 280;
const BLOCK_MENU_VIEWPORT_MARGIN = 8;
const BLOCK_MENU_GAP = 12;
export const TABLE_BLOCK_HANDLE_LEFT_OFFSET =
  TABLE_ROW_HEADER_SIZE + TABLE_INSERT_DOT_GAP + TABLE_INSERT_DOT_SIZE / 2;
export const TABLE_BLOCK_HANDLE_TOP_OFFSET = TABLE_COLUMN_HEADER_SIZE + TABLE_INSERT_DOT_GAP;

function clampViewportValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function getVisibleBlockMenuHeight(menuEl?: HTMLElement | null): number {
  if (!menuEl) return BLOCK_MENU_EST_HEIGHT;

  // 主菜单实际可见高度。不要用 scrollHeight:隐藏的 absolute 子菜单会污染它。
  const offsetHeight = menuEl.offsetHeight;
  if (Number.isFinite(offsetHeight) && offsetHeight > 0) return offsetHeight;

  const rectHeight = menuEl.getBoundingClientRect().height;
  if (Number.isFinite(rectHeight) && rectHeight > 0) return rectHeight;

  return BLOCK_MENU_EST_HEIGHT;
}

/** 表格块手柄需避让 B3 行列头与首位插入圆点；其他块仍沿用首行中线锚点。 */
export function blockHandleGeometry(
  blockEl: HTMLElement,
  nodeType: string,
): { top: number; left: number } {
  const rect = blockEl.getBoundingClientRect();
  const top = rect.top + firstLineCenterOffset(blockEl);
  if (nodeType !== "table") return { top, left: rect.left };
  return {
    top: top - TABLE_BLOCK_HANDLE_TOP_OFFSET,
    left: rect.left - TABLE_BLOCK_HANDLE_LEFT_OFFSET,
  };
}

export function refreshHandleGeometryFromDom(h: HandleState, editorDom: HTMLElement): HandleState | null {
  // 同 computeBlockMenuPlacement:只查 isConnected,不要求 getClientRects 非空——键盘唤起 / jsdom 下
  // getClientRects 可能为空,但仍要能刷新出 handle 几何(rect 由 getBoundingClientRect 提供)。
  if (!h.blockEl.isConnected) return null;
  const rect = h.blockEl.getBoundingClientRect();
  const editorRect = editorDom.getBoundingClientRect();
  if (rect.bottom < editorRect.top - 24 || rect.top > editorRect.bottom + 24) return null;
  if (h.kind === "listItem" && h.itemType) {
    const geometry = listItemHandleGeometry(h.blockEl, h.itemType);
    return { ...h, top: geometry.top, left: geometry.left };
  }
  return { ...h, ...blockHandleGeometry(h.blockEl, h.nodeType) };
}

export function computeBlockMenuPlacement(h: HandleState, menuEl?: HTMLElement | null): BlockMenuPlacement | null {
  if (h.kind !== "block") return null;
  // isConnected 足够判断块在文档中;不要求 getClientRects 非空——jsdom / display 边界下 rect 可能为 0,
  // 但键盘唤起仍需能打开菜单(位置随后由 menuEl mount 后的 layout effect 用真实 rect 重算)。
  if (!h.blockEl.isConnected) return null;

  const rect = h.blockEl.getBoundingClientRect();
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.left)) return null;

  const menuWidth = menuEl?.offsetWidth || BLOCK_MENU_EST_WIDTH;
  const menuHeight = getVisibleBlockMenuHeight(menuEl);
  const margin = BLOCK_MENU_VIEWPORT_MARGIN;
  const anchor = blockHandleGeometry(h.blockEl, h.nodeType);
  const anchorTop = anchor.top;
  const belowTop = anchorTop + BLOCK_MENU_GAP;
  const aboveTop = anchorTop - menuHeight - BLOCK_MENU_GAP;
  const belowFits = belowTop + menuHeight + margin <= window.innerHeight;
  const aboveFits = aboveTop >= margin;
  const flipUp = !belowFits && aboveFits;
  const preferredTop = flipUp ? aboveTop : belowTop;
  // 恒 clamp 到 [margin, maxTop](review #5):上下都放不下(矮视口)时也不许底部溢出——旧实现
  // 只 Math.max(preferredTop, margin) 会让尾部菜单项落到视口外且 fixed 定位无法滚动触达。
  // 菜单比视口还高的极端情形 maxTop<margin → 钉在 margin,由 CSS max-height+overflow 兜底可滚。
  const maxTop = Math.max(margin, window.innerHeight - menuHeight - margin);
  const top = clampViewportValue(preferredTop, margin, maxTop);
  const preferredLeft = anchor.left - 24;
  const maxLeft = window.innerWidth - menuWidth - margin;

  return {
    top: Math.round(top),
    left: Math.round(clampViewportValue(preferredLeft, margin, maxLeft)),
    flipUp,
  };
}

/** 顶层块 → 手柄徽标字形(对齐飞书:正文 T、标题 H1..H6、列表/引用/代码各有标记)。 */
export function glyphForBlock(node: { type: { name: string }; attrs?: Record<string, unknown> } | null | undefined): string {
  if (!node) return "T";
  switch (node.type.name) {
    case "heading":
      return `H${Number(node.attrs?.level) || 1}`;
    case "paragraph":
      return "T";
    case "bulletList":
      return "•";
    case "orderedList":
      return "1.";
    case "blockquote":
      return "❝";
    case "codeBlock":
      return "{}";
    case "taskList":
      return "task";
    case "table":
      return "table";
    case "horizontalRule":
      return "divider";
    default:
      return "T";
  }
}

export function glyphForListItem(item: DraggableListItem): string {
  if (item.itemType === "taskItem") return "task";
  return item.listType === "orderedList" ? "1." : "•";
}

/** 托柄左侧"格式图标"(对齐飞书:无序列表用列表图标、待办用方框勾、其余用文字徽标如 H1/1./T)。 */
export function HandleTypeIcon({ glyph }: { glyph: string }): JSX.Element {
  if (glyph === "table") return <BlockHandleIcon name="table" />;
  if (glyph === "divider") return <BlockHandleIcon name="divider" />;
  if (glyph === "❝") return <BlockHandleIcon name="quote" />;
  if (glyph === "{}") return <BlockHandleIcon name="code" />;
  if (glyph === "•") {
    return (
      <svg className="bh-type-svg" width="13" height="11" viewBox="0 0 13 11" aria-hidden="true" focusable="false">
        <circle cx="1.6" cy="1.8" r="1.2" fill="currentColor" />
        <circle cx="1.6" cy="5.5" r="1.2" fill="currentColor" />
        <circle cx="1.6" cy="9.2" r="1.2" fill="currentColor" />
        <path d="M5 1.8h7M5 5.5h7M5 9.2h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (glyph === "task") {
    return (
      <svg className="bh-type-svg" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <path d="M3.4 6.2l1.7 1.7 3.3-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return <span className="bh-type-text">{glyph}</span>;
}

/** 块 DOM → 其首行垂直中点相对块顶的偏移(padTop + 行高/2);手柄按它对齐首行中线,多行块也不偏。 */
export function firstLineCenterOffset(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  let lineH = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lineH)) lineH = (parseFloat(cs.fontSize) || 16) * 1.5;
  const padTop = parseFloat(cs.paddingTop) || 0;
  return padTop + lineH / 2;
}

export function listItemHandleGeometry(
  itemDom: HTMLElement,
  itemType: DraggableListItem["itemType"],
): { top: number; left: number } {
  const metrics = getListItemRowMetrics(itemDom, itemType);
  const top = metrics.contentRect.top + firstLineCenterOffset(metrics.contentElement);
  return {
    top: Number.isFinite(top) ? top : metrics.itemRect.top + firstLineCenterOffset(itemDom),
    left: metrics.handleLeft,
  };
}

export interface CollapsedCaret {
  blockId: string;
  top: number;
  left: number;
}

/**
 * 折叠态常驻三角的位置:和拖拽托柄一样是 gutter 悬浮层(不进入内容区)。按每个"已折叠且可见"的块
 * 的 DOM 算 top/left(与托柄同锚点),隐藏块(display:none,无 client rect)跳过。
 */
export function computeCollapsedCarets(editor: Editor): CollapsedCaret[] {
  if (!editor.isEditable) return []; // 审阅态强制展开,不出常驻三角
  const collapsed = getCollapsedBlockIds(editor.state);
  if (!collapsed || collapsed.size === 0) return [];
  const result: CollapsedCaret[] = [];
  const seen = new Set<string>();
  editor.state.doc.descendants((node, pos) => {
    const blockId = typeof node.attrs.blockId === "string" ? node.attrs.blockId : null;
    if (!blockId || seen.has(blockId) || !collapsed.has(blockId)) return true;
    const typeName = node.type.name;
    if (typeName !== "listItem" && typeName !== "taskItem" && typeName !== "heading") return true;
    const dom = editor.view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement) || dom.getClientRects().length === 0) {
      // 隐藏块(被上层折叠)无 client rect → 跳过且不深入
      return typeName === "heading";
    }
    if (typeName === "heading") {
      const rect = dom.getBoundingClientRect();
      result.push({ blockId, top: rect.top + firstLineCenterOffset(dom), left: rect.left });
      seen.add(blockId);
      return true;
    }
    // listItem / taskItem
    const item = findDraggableListItem(
      editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size)),
    );
    if (item) {
      const geo = listItemHandleGeometry(dom, item.itemType);
      if (Number.isFinite(geo.top) && Number.isFinite(geo.left)) {
        result.push({ blockId, top: geo.top, left: geo.left });
        seen.add(blockId);
      }
    }
    return false; // 折叠列表项的子项已隐藏,不深入
  });
  return result;
}
